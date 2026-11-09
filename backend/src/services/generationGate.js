import { ApiError } from "../lib/errors.js";
import crypto from "crypto";
import { createMemoryLedger, createPrismaLedger, usdToMicros, isValidTimeZone } from "./spendLedger.js";

/**
 * Single entry point for every paid provider call (spec section 6, WP4).
 * One gate instance is created per app (createApp) and passed explicitly to
 * routes and services; there is no module-global gate.
 *
 * Checks run for EVERY step of a workflow before anything is reserved or
 * called, and every one fails closed:
 *   1. a provider/model is SELECTED for this media kind (image default:
 *      "higgsfield:soul", the owner-confirmed primary direction; video: none)
 *   2. that provider/model has an adapter
 *   3. it is listed in APPROVED_PROVIDER_MODELS (empty by default)
 *   4. LIVE_PROVIDER_CALLS=enabled
 *   5. the spending ledger is durable (the default in-memory ledger is not)
 *   6. a price is configured for it (unknown price blocks)
 *   7. per-job, daily and monthly caps are configured; the whole workflow's
 *      cost is reserved atomically against them
 *
 * There is NO automatic fallback to another provider.
 *
 * Environment (unset by default, so nothing can be spent):
 *   IMAGE_PROVIDER, VIDEO_PROVIDER, APPROVED_PROVIDER_MODELS,
 *   LIVE_PROVIDER_CALLS, PROVIDER_PRICES_USD (JSON),
 *   SPEND_CAP_PER_JOB_USD, SPEND_CAP_DAILY_USD, SPEND_CAP_MONTHLY_USD,
 *   SPEND_LEDGER ("postgres" selects the durable ledger; default in-memory)
 */

export const DEFAULT_SELECTION = Object.freeze({ image: "higgsfield:soul", video: "" });

const parseList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

function parsePrices(value) {
  if (!value) return {};
  try {
    const p = JSON.parse(value);
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/**
 * Fault-injection seam for tests (WHY: the brief requires proving recovery
 * after a process dies at each step of a paid call). A test passes a
 * `faults(point)` function that throws SimulatedProcessDeath; the gate and
 * routes then stop WITHOUT any cleanup, exactly as a killed process would.
 * Production never constructs this error and never passes `faults`.
 */
export class SimulatedProcessDeath extends Error {
  constructor(point) { super(`simulated process death at ${point}`); this.name = "SimulatedProcessDeath"; this.processDeath = true; }
}
export const isProcessDeath = (err) => err?.processDeath === true;

/** Error thrown by adapters. `submitted: false` means the request never left this server. */
export class ProviderError extends Error {
  constructor(message, { submitted = true } = {}) {
    super(message);
    this.name = "ProviderError";
    this.submitted = submitted;
  }
}

/** Media URLs only: safe to return to the operator and to log. */
function publicResult(result) {
  const out = {};
  if (result?.imageUrl) out.imageUrl = result.imageUrl;
  if (result?.videoUrl) out.videoUrl = result.videoUrl;
  return out;
}

/** Picks the ledger. Only an explicit SPEND_LEDGER=postgres selects the durable one. */
export function selectLedger(env, prisma) {
  if (env.SPEND_LEDGER === "postgres") {
    if (!prisma) throw new Error("SPEND_LEDGER=postgres requires a Prisma client");
    return createPrismaLedger(prisma);
  }
  return createMemoryLedger({ durable: false });
}

export function createGenerationGate({ env = process.env, ledger, adapters, log = console, faults = null } = {}) {
  const fault = async (point, info) => { if (faults) await faults(point, info); };
  if (!ledger) throw new Error("createGenerationGate requires a ledger");
  if (!adapters) throw new Error("createGenerationGate requires adapters");

  function selectionFor(kind) {
    const configured = env[kind === "image" ? "IMAGE_PROVIDER" : "VIDEO_PROVIDER"];
    return (configured === undefined ? DEFAULT_SELECTION[kind] ?? "" : configured).trim();
  }

  /** Declared capabilities of the selected adapter (no approval implied). */
  function capabilities(kind) {
    const selected = selectionFor(kind);
    const adapter = selected ? adapters[kind]?.[selected] : null;
    if (!adapter) return null;
    return { referenceConditioning: false, sourceImage: false, ...(adapter.capabilities || {}) };
  }

  function describe() {
    return {
      capabilities: { image: capabilities("image"), video: capabilities("video") },
      liveCallsEnabled: env.LIVE_PROVIDER_CALLS === "enabled",
      ledger: ledger.kind || "custom",
      ledgerDurable: Boolean(ledger.durable),
      automaticFallback: false,
      selection: { image: selectionFor("image") || null, video: selectionFor("video") || null },
      approved: parseList(env.APPROVED_PROVIDER_MODELS),
      pricesConfigured: Object.keys(parsePrices(env.PROVIDER_PRICES_USD)),
      capsConfigured: {
        perJob: usdToMicros(env.SPEND_CAP_PER_JOB_USD) !== null,
        daily: usdToMicros(env.SPEND_CAP_DAILY_USD) !== null,
        monthly: usdToMicros(env.SPEND_CAP_MONTHLY_USD) !== null,
      },
    };
  }

  /** Throws the first blocking ApiError for one media kind. No side effects. */
  function preflight(kind) {
    const selected = selectionFor(kind);
    if (!selected) throw new ApiError("PROVIDER_NOT_SELECTED", 503, `No ${kind} provider has been selected`);
    const adapter = adapters[kind]?.[selected];
    if (!adapter) throw new ApiError("PROVIDER_UNAVAILABLE", 503, `No adapter is available for ${selected}`);
    if (!parseList(env.APPROVED_PROVIDER_MODELS).includes(selected)) {
      throw new ApiError("PROVIDER_NOT_APPROVED", 403, `${selected} has not been approved for paid generation`);
    }
    if (env.LIVE_PROVIDER_CALLS !== "enabled") {
      throw new ApiError("LIVE_CALLS_DISABLED", 503, "Live provider calls are disabled on this server");
    }
    if (!ledger.durable) {
      throw new ApiError("LEDGER_NOT_DURABLE", 503, "Paid generation requires a durable spending ledger");
    }
    const priceMicros = usdToMicros(parsePrices(env.PROVIDER_PRICES_USD)[selected]);
    if (priceMicros === null) throw new ApiError("PRICE_UNKNOWN", 503, `No verified price is configured for ${selected}`);
    const caps = {
      perJobMicros: usdToMicros(env.SPEND_CAP_PER_JOB_USD),
      dailyMicros: usdToMicros(env.SPEND_CAP_DAILY_USD),
      monthlyMicros: usdToMicros(env.SPEND_CAP_MONTHLY_USD),
    };
    if (Object.values(caps).some((v) => v === null)) {
      throw new ApiError("BUDGET_NOT_CONFIGURED", 503, "Spending caps are not configured");
    }
    // WHY required: a price without its currency and version cannot be
    // audited later, and "daily" means nothing without a timezone.
    const currency = env.PRICE_CURRENCY;
    const priceVersion = env.PRICE_VERSION;
    const missing = [];
    if (!/^[A-Z]{3}$/.test(currency || "")) missing.push("PRICE_CURRENCY (ISO code, e.g. USD)");
    if (!priceVersion || priceVersion.length > 64) missing.push("PRICE_VERSION (where and when prices were checked)");
    if (!isValidTimeZone(env.SPEND_CAP_TIMEZONE)) missing.push("SPEND_CAP_TIMEZONE (IANA zone, e.g. America/Los_Angeles)");
    if (missing.length) throw new ApiError("PRICE_CONFIG_INCOMPLETE", 503, "Pricing configuration is incomplete", { missing });
    caps.timezone = env.SPEND_CAP_TIMEZONE;
    const [provider, model] = selected.split(":");
    return { selected, provider, model, adapter, priceMicros, caps, currency, priceVersion };
  }

  /** Preflights a list of kinds; throws before anything is reserved if any is blocked. */
  function preflightAll(kinds) {
    return kinds.map((k) => preflight(k));
  }

  /**
   * Runs a multi-step paid workflow.
   * steps: [{ kind, input: object | (previousResults) => object,
   *           idempotencyKey?, requestHash?, onResult?: async (result) => void }]
   * options.hooks (durable job journal), all awaited:
   *   afterReserve(reservations) · beforeSubmit(i) · onAccepted(i, providerRequestId)
   *   afterSettle(i, result) · onStepState(i, state, errorCode)
   * All steps are preflighted, then their total cost is reserved atomically,
   * then steps run in order. onResult persists each stage as soon as it
   * succeeds so a later failure does not lose (or re-buy) earlier output.
   *
   * Failure rules (WHY: money already spent must stay counted, money not
   * spent must be freed, and nothing may be bought twice):
   *  - the "submitting" mark could not be written -> not sent: release
   *  - provider says "not sent"       -> release this step
   *  - provider outcome unclear       -> keep this step (outcome_unknown)
   *  - provider succeeded, settle fails -> keep this step reserved (it still
   *    blocks retries of its key, so the result is never re-bought) and
   *    report the result so it is not lost
   *  - provider succeeded, onResult fails -> the step is settled with its
   *    result stored; a retry of the same key replays it for recovery
   *  - in every case, later steps that never started are released
   *  - a simulated process death stops everything with no cleanup at all
   */
  async function runWorkflow(steps, { hooks = {} } = {}) {
    const hook = async (name, ...args) => { if (hooks[name]) await hooks[name](...args); };
    const checks = preflightAll(steps.map((s) => s.kind));
    const caps = checks[0].caps;
    const reservations = await ledger.reserveGroup(
      steps.map((s, i) => ({
        amountMicros: checks[i].priceMicros,
        provider: checks[i].provider,
        model: checks[i].model,
        idempotencyKey: s.idempotencyKey,
        requestHash: s.requestHash,
        currency: checks[i].currency,
        priceVersion: checks[i].priceVersion,
      })),
      caps
    );
    await fault("afterReserve");
    await hook("afterReserve", reservations);

    // Releases reservations for steps after index i that never started.
    // Best effort: a release that fails leaves the money counted (safe side).
    async function releaseUnstartedAfter(i) {
      for (let j = i + 1; j < steps.length; j++) {
        const rj = reservations[j];
        if (rj.reservationId && rj.replay === undefined) {
          try {
            await ledger.release(rj.reservationId);
            await hook("onStepState", j, "not_submitted", "EARLIER_STEP_FAILED");
          } catch (err) {
            log.error?.(`[generation] could not release unstarted reservation ${rj.reservationId}: ${err?.message}`);
          }
        }
      }
    }

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const check = checks[i];
      const r = reservations[i];
      let result;

      if (r.replay !== undefined) {
        // Settled earlier with the same request: reuse the stored output, no new call.
        result = { ...(r.replay || {}), replayed: true };
        await hook("onStepState", i, "replayed");
      } else {
        const input = typeof step.input === "function" ? step.input(results) : step.input;
        // WHY a durable mark before the call: after a crash, a step without it
        // provably never reached the provider, so its money can be released.
        try {
          await fault("beforeSubmit", { index: i });
          await hook("beforeSubmit", i);
        } catch (err) {
          if (isProcessDeath(err)) throw err;
          await ledger.release(r.reservationId);
          await releaseUnstartedAfter(i);
          throw new ApiError("PROVIDER_UNAVAILABLE", 503, "Could not record the request before sending it; nothing was sent");
        }
        const capabilities = check.adapter.capabilities || {};
        const vendorIdempotencyKey = capabilities.vendorIdempotency && step.idempotencyKey
          ? crypto.createHash("sha256").update(step.idempotencyKey).digest("hex").slice(0, 40)
          : undefined;
        const ctx = {
          vendorIdempotencyKey,
          // Adapters call this once the provider has accepted the request.
          onAccepted: async (providerRequestId) => {
            await hook("onAccepted", i, String(providerRequestId).slice(0, 200));
            await fault("afterAccept", { index: i });
          },
        };
        try {
          result = await check.adapter.generate(input || {}, ctx);
        } catch (err) {
          if (isProcessDeath(err)) throw err;
          const notSent = err instanceof ProviderError && err.submitted === false;
          if (notSent) await ledger.release(r.reservationId);
          else await ledger.markUnknown(r.reservationId);
          await hook("onStepState", i, notSent ? "not_submitted" : "outcome_unknown", notSent ? "PROVIDER_UNAVAILABLE" : "OUTCOME_UNKNOWN");
          await releaseUnstartedAfter(i);
          if (notSent) {
            throw new ApiError("PROVIDER_UNAVAILABLE", 503, `${check.selected} could not be called: ${err.message}`);
          }
          log.error?.(`[generation] ${check.selected} outcome unknown (reservation ${r.reservationId})`);
          throw new ApiError("OUTCOME_UNKNOWN", 502,
            `${check.selected} did not return a confirmed result; not retried`, { reservationId: r.reservationId });
        }
        await fault("afterResult", { index: i });

        // The provider has charged us. Record that; a few quick retries cover
        // transient database errors.
        let settled = false;
        let lastErr;
        for (let attempt = 0; attempt < 3 && !settled; attempt++) {
          try {
            await fault("beforeSettle", { index: i });
            await ledger.settle(r.reservationId, null, result);
            settled = true;
          } catch (err) {
            if (isProcessDeath(err)) throw err;
            lastErr = err;
          }
        }
        if (!settled) {
          // WHY not release or mark unknown: the spend happened. Leaving the
          // reservation "reserved" keeps it counted against the caps and makes
          // any retry of this key DUPLICATE_IN_PROGRESS instead of a new purchase.
          await hook("onStepState", i, "settlement_failed", "SETTLEMENT_FAILED").catch(() => {});
          await releaseUnstartedAfter(i);
          log.error?.(`[generation] ${check.selected} succeeded but settlement failed (reservation ${r.reservationId}): ${lastErr?.message}`);
          throw new ApiError("SETTLEMENT_FAILED", 502,
            "The provider returned a result but it could not be recorded; it was not applied and will not be re-bought. Reconcile this reservation.",
            { reservationId: r.reservationId, result: publicResult(result) });
        }
        await hook("afterSettle", i, publicResult(result));
      }

      const enriched = {
        ...result,
        provider: check.provider,
        model: check.model,
        reservationId: r.reservationId,
        estimatedCostMicros: r.replay !== undefined ? 0 : check.priceMicros,
      };
      results.push(enriched);
      if (step.onResult) {
        try {
          await step.onResult(enriched);
        } catch (err) {
          if (isProcessDeath(err)) throw err;
          // The result is settled and stored with this key, so nothing is lost
          // and nothing is re-bought: a retry of the same request replays it.
          await hook("onStepState", i, err instanceof ApiError && err.code === "GENERATION_SUPERSEDED" ? "superseded" : "application_failed",
            err instanceof ApiError ? err.code : "RESULT_NOT_APPLIED").catch(() => {});
          await releaseUnstartedAfter(i);
          if (err instanceof ApiError) throw err;
          log.error?.(`[generation] result of reservation ${r.reservationId} not applied: ${err?.message}`);
          throw new ApiError("RESULT_NOT_APPLIED", 503,
            "The result was recorded but could not be applied; retry the same request to apply it without a new charge.",
            { reservationId: r.reservationId, result: publicResult(result) });
        }
      }
    }
    return results;
  }

  /**
   * Asks the provider about an earlier request (reconciliation). Adapters
   * that cannot look a request up return null.
   */
  async function checkProvider(kind, providerModel, providerRequestId) {
    const adapter = adapters[kind]?.[providerModel];
    if (!adapter?.checkStatus) return null;
    return adapter.checkStatus(providerRequestId);
  }

  async function run(kind, input = {}, { idempotencyKey, requestHash, hooks } = {}) {
    const [result] = await runWorkflow([{ kind, input, idempotencyKey, requestHash }], { hooks });
    return result;
  }

  return { run, runWorkflow, preflight, preflightAll, describe, capabilities, checkProvider, fault, ledger };
}
