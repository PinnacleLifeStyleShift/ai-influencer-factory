import { ApiError } from "../lib/errors.js";
import { createMemoryLedger, createPrismaLedger, usdToMicros } from "./spendLedger.js";

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

/** Error thrown by adapters. `submitted: false` means the request never left this server. */
export class ProviderError extends Error {
  constructor(message, { submitted = true } = {}) {
    super(message);
    this.name = "ProviderError";
    this.submitted = submitted;
  }
}

/** Picks the ledger. Only an explicit SPEND_LEDGER=postgres selects the durable one. */
export function selectLedger(env, prisma) {
  if (env.SPEND_LEDGER === "postgres") {
    if (!prisma) throw new Error("SPEND_LEDGER=postgres requires a Prisma client");
    return createPrismaLedger(prisma);
  }
  return createMemoryLedger({ durable: false });
}

export function createGenerationGate({ env = process.env, ledger, adapters, log = console } = {}) {
  if (!ledger) throw new Error("createGenerationGate requires a ledger");
  if (!adapters) throw new Error("createGenerationGate requires adapters");

  function selectionFor(kind) {
    const configured = env[kind === "image" ? "IMAGE_PROVIDER" : "VIDEO_PROVIDER"];
    return (configured === undefined ? DEFAULT_SELECTION[kind] ?? "" : configured).trim();
  }

  function describe() {
    return {
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
    const [provider, model] = selected.split(":");
    return { selected, provider, model, adapter, priceMicros, caps };
  }

  /** Preflights a list of kinds; throws before anything is reserved if any is blocked. */
  function preflightAll(kinds) {
    return kinds.map((k) => preflight(k));
  }

  /**
   * Runs a multi-step paid workflow.
   * steps: [{ kind, input: object | (previousResults) => object,
   *           idempotencyKey?, requestHash?, onResult?: async (result) => void }]
   * All steps are preflighted, then their total cost is reserved atomically,
   * then steps run in order. onResult persists each stage as soon as it
   * succeeds so a later failure does not lose (or re-buy) earlier output.
   */
  async function runWorkflow(steps) {
    const checks = preflightAll(steps.map((s) => s.kind));
    const caps = checks[0].caps;
    const reservations = await ledger.reserveGroup(
      steps.map((s, i) => ({
        amountMicros: checks[i].priceMicros,
        provider: checks[i].provider,
        model: checks[i].model,
        idempotencyKey: s.idempotencyKey,
        requestHash: s.requestHash,
      })),
      caps
    );

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const check = checks[i];
      const r = reservations[i];
      let result;

      if (r.replay !== undefined) {
        // Settled earlier with the same request: reuse the stored output, no new call.
        result = { ...(r.replay || {}), replayed: true };
      } else {
        const input = typeof step.input === "function" ? step.input(results) : step.input;
        try {
          result = await check.adapter.generate(input || {});
        } catch (err) {
          const notSent = err instanceof ProviderError && err.submitted === false;
          if (notSent) await ledger.release(r.reservationId);
          else await ledger.markUnknown(r.reservationId);
          // Later steps never started: free their reservations.
          for (let j = i + 1; j < steps.length; j++) {
            if (reservations[j].reservationId && reservations[j].replay === undefined) {
              await ledger.release(reservations[j].reservationId);
            }
          }
          if (notSent) {
            throw new ApiError("PROVIDER_UNAVAILABLE", 503, `${check.selected} could not be called: ${err.message}`);
          }
          log.error?.(`[generation] ${check.selected} outcome unknown (reservation ${r.reservationId})`);
          throw new ApiError("OUTCOME_UNKNOWN", 502,
            `${check.selected} did not return a confirmed result; not retried`, { reservationId: r.reservationId });
        }
        await ledger.settle(r.reservationId, null, result);
      }

      const enriched = {
        ...result,
        provider: check.provider,
        model: check.model,
        reservationId: r.reservationId,
        estimatedCostMicros: r.replay !== undefined ? 0 : check.priceMicros,
      };
      results.push(enriched);
      if (step.onResult) await step.onResult(enriched);
    }
    return results;
  }

  async function run(kind, input = {}, { idempotencyKey, requestHash } = {}) {
    const [result] = await runWorkflow([{ kind, input, idempotencyKey, requestHash }]);
    return result;
  }

  return { run, runWorkflow, preflight, preflightAll, describe, ledger };
}
