import crypto from "crypto";
import { ApiError } from "../lib/errors.js";

/**
 * Budget ledger. Amounts are integer micro-USD (1 USD = 1_000_000) so no
 * floating-point money arithmetic is used.
 *
 * Reservation is synchronous inside one Node process, which makes the
 * check-and-reserve step atomic for concurrent requests in that process.
 *
 * This in-memory ledger is NOT durable: it forgets spend on restart and is not
 * shared between replicas. The generation gate therefore refuses live paid
 * calls unless the ledger reports `durable: true`. A database-backed ledger
 * (spec WP4) is required before any approved paid generation.
 */
export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * MICROS_PER_USD + Number(frac.padEnd(6, "0"));
}

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}
function monthKey(d) {
  return d.toISOString().slice(0, 7);
}

export function createMemoryLedger({ durable = false, now = () => new Date() } = {}) {
  const reservations = new Map(); // id -> record
  const byIdempotencyKey = new Map();

  function committedFor(predicate) {
    let total = 0;
    for (const r of reservations.values()) {
      if (r.state === "released") continue;
      if (!predicate(r)) continue;
      total += r.state === "settled" ? r.actualMicros : r.amountMicros;
    }
    return total;
  }

  return {
    durable,

    reserve({ amountMicros, caps, provider, model, idempotencyKey }) {
      if (idempotencyKey && byIdempotencyKey.has(idempotencyKey)) {
        const existing = reservations.get(byIdempotencyKey.get(idempotencyKey));
        if (existing && existing.state !== "released") {
          throw new ApiError("DUPLICATE_REQUEST", 409, "A generation with this idempotency key already exists", {
            reservationId: existing.id,
            state: existing.state,
          });
        }
      }

      if (amountMicros > caps.perJobMicros) {
        throw new ApiError("BUDGET_EXCEEDED", 402, "Estimated job cost exceeds the per-job cap");
      }
      const at = now();
      const day = dayKey(at);
      const month = monthKey(at);
      const daySpent = committedFor((r) => r.day === day);
      const monthSpent = committedFor((r) => r.month === month);
      if (daySpent + amountMicros > caps.dailyMicros) {
        throw new ApiError("BUDGET_EXCEEDED", 402, "Daily spending cap would be exceeded");
      }
      if (monthSpent + amountMicros > caps.monthlyMicros) {
        throw new ApiError("BUDGET_EXCEEDED", 402, "Monthly spending cap would be exceeded");
      }

      const id = crypto.randomUUID();
      reservations.set(id, {
        id, provider, model, amountMicros, actualMicros: null,
        state: "reserved", day, month, idempotencyKey: idempotencyKey || null,
      });
      if (idempotencyKey) byIdempotencyKey.set(idempotencyKey, id);
      return { reservationId: id };
    },

    /** Provider confirmed completion. Without a verified actual price, the estimate is kept. */
    settle(id, actualMicros) {
      const r = reservations.get(id);
      if (!r) return;
      r.state = "settled";
      r.actualMicros = Number.isInteger(actualMicros) ? actualMicros : r.amountMicros;
    },

    /** Request definitely never reached the provider: free the reservation. */
    release(id) {
      const r = reservations.get(id);
      if (r && r.state === "reserved") r.state = "released";
    },

    /** Outcome unknown: keep the reservation counted until reconciled. */
    markUnknown(id) {
      const r = reservations.get(id);
      if (r && r.state === "reserved") r.state = "outcome_unknown";
    },

    get(id) {
      const r = reservations.get(id);
      return r ? { ...r } : null;
    },

    totals() {
      const at = now();
      return {
        dayMicros: committedFor((r) => r.day === dayKey(at)),
        monthMicros: committedFor((r) => r.month === monthKey(at)),
      };
    },
  };
}
