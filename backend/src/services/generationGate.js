import { ApiError } from "../lib/errors.js";
import { createMemoryLedger, usdToMicros } from "./spendLedger.js";

/**
 * Single entry point for every paid provider call (spec section 6, WP4).
 *
 * Checks run in this order and every one fails closed:
 *   1. a provider/model is SELECTED for this media kind (image default:
 *      Higgsfield, the owner-confirmed primary direction; video: none)
 *   2. that provider/model has an adapter
 *   3. that provider/model is in APPROVED_PROVIDER_MODELS (empty by default:
 *      the exact Higgsfield model/API route is not yet approved)
 *   4. live provider calls are switched on (LIVE_PROVIDER_CALLS=enabled)
 *   5. the spending ledger is durable
 *   6. a price is configured for the provider/model (unknown price blocks)
 *   7. per-job, daily and monthly caps are configured and not exceeded
 *
 * There is NO automatic fallback to another provider. If the selected
 * provider fails, the error is reported and nothing else is tried.
 *
 * Environment (all unset by default, so nothing can be spent):
 *   IMAGE_PROVIDER            e.g. "higgsfield:soul" (default "higgsfield:soul")
 *   VIDEO_PROVIDER            e.g. "fal:kling-v2.1-i2v" (default: none)
 *   APPROVED_PROVIDER_MODELS  comma list of provider:model the owner approved
 *   LIVE_PROVIDER_CALLS       must equal "enabled" to make network calls
 *   PROVIDER_PRICES_USD       JSON map {"provider:model": "0.05"} (estimate per job)
 *   SPEND_CAP_PER_JOB_USD, SPEND_CAP_DAILY_USD, SPEND_CAP_MONTHLY_USD
 */

export const DEFAULT_SELECTION = Object.freeze({
  image: "higgsfield:soul",
  video: "",
});

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePrices(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
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

export function createGenerationGate({ env = process.env, ledger, adapters, log = console } = {}) {
  if (!ledger) throw new Error("createGenerationGate requires a ledger");
  if (!adapters) throw new Error("createGenerationGate requires adapters");

  function selectionFor(kind) {
    const key = kind === "image" ? "IMAGE_PROVIDER" : "VIDEO_PROVIDER";
    const configured = env[key];
    return (configured === undefined ? DEFAULT_SELECTION[kind] : configured).trim();
  }

  function describe() {
    const approved = parseList(env.APPROVED_PROVIDER_MODELS);
    const prices = parsePrices(env.PROVIDER_PRICES_USD);
    return {
      liveCallsEnabled: env.LIVE_PROVIDER_CALLS === "enabled",
      ledgerDurable: Boolean(ledger.durable),
      automaticFallback: false,
      selection: { image: selectionFor("image") || null, video: selectionFor("video") || null },
      approved,
      pricesConfigured: Object.keys(prices),
      capsConfigured: {
        perJob: usdToMicros(env.SPEND_CAP_PER_JOB_USD) !== null,
        daily: usdToMicros(env.SPEND_CAP_DAILY_USD) !== null,
        monthly: usdToMicros(env.SPEND_CAP_MONTHLY_USD) !== null,
      },
    };
  }

  /** Throws the first blocking ApiError, or returns everything needed to submit. */
  function preflight(kind) {
    const selected = selectionFor(kind);
    if (!selected) {
      throw new ApiError("PROVIDER_NOT_SELECTED", 503, `No ${kind} provider has been selected`);
    }
    const adapter = adapters[kind]?.[selected];
    if (!adapter) {
      throw new ApiError("PROVIDER_UNAVAILABLE", 503, `No adapter is available for ${selected}`);
    }
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
    if (priceMicros === null) {
      throw new ApiError("PRICE_UNKNOWN", 503, `No verified price is configured for ${selected}`);
    }
    const caps = {
      perJobMicros: usdToMicros(env.SPEND_CAP_PER_JOB_USD),
      dailyMicros: usdToMicros(env.SPEND_CAP_DAILY_USD),
      monthlyMicros: usdToMicros(env.SPEND_CAP_MONTHLY_USD),
    };
    if (Object.values(caps).some((v) => v === null)) {
      throw new ApiError("BUDGET_NOT_CONFIGURED", 503, "Spending caps are not configured");
    }
    return { selected, adapter, priceMicros, caps };
  }

  async function run(kind, input = {}) {
    const { selected, adapter, priceMicros, caps } = preflight(kind);
    const [provider, model] = selected.split(":");

    const { reservationId } = ledger.reserve({
      amountMicros: priceMicros,
      caps,
      provider,
      model,
      idempotencyKey: input.idempotencyKey,
    });

    let result;
    try {
      result = await adapter.generate(input);
    } catch (err) {
      if (err instanceof ProviderError && err.submitted === false) {
        ledger.release(reservationId);
        throw new ApiError("PROVIDER_UNAVAILABLE", 503, `${selected} could not be called: ${err.message}`);
      }
      // Request may have reached the provider. Keep the money reserved, do not
      // retry, do not fall back. Reconciliation is required.
      ledger.markUnknown(reservationId);
      log.error?.(`[generation] ${selected} outcome unknown (reservation ${reservationId})`);
      throw new ApiError("OUTCOME_UNKNOWN", 502, `${selected} did not return a confirmed result; not retried`, {
        reservationId,
      });
    }

    ledger.settle(reservationId, null);
    return { ...result, provider, model, reservationId, estimatedCostMicros: priceMicros };
  }

  return { run, preflight, describe, ledger };
}

let defaultGate = null;

/** Lazily built from adapters registered by the service modules. */
export function getDefaultGate() {
  if (!defaultGate) {
    throw new Error("Generation gate not initialised; call initDefaultGate() at startup");
  }
  return defaultGate;
}

export function initDefaultGate({ env = process.env, adapters, ledger } = {}) {
  defaultGate = createGenerationGate({ env, adapters, ledger: ledger || createMemoryLedger({ durable: false }) });
  return defaultGate;
}

export function setDefaultGate(gate) {
  defaultGate = gate;
}
