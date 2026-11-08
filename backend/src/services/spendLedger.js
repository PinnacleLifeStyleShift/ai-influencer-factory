import crypto from "crypto";
import { ApiError } from "../lib/errors.js";

/**
 * Budget ledgers. Amounts are integer micro-USD (1 USD = 1_000_000).
 *
 * Interface (all methods async):
 *   reserveGroup(entries, caps) -> [{ reservationId } | { replay: result }]
 *     Atomically reserves every entry or none. Each entry is
 *     { amountMicros, provider, model, idempotencyKey?, requestHash? }.
 *     - A key whose earlier reservation SETTLED with the same requestHash is
 *       replayed (its stored result is returned; nothing new is reserved).
 *     - A key that is still reserved / outcome_unknown -> DUPLICATE_IN_PROGRESS.
 *     - A key reused with a different requestHash -> IDEMPOTENCY_KEY_REUSED.
 *     - A key whose reservation was RELEASED (never sent) may be reserved again.
 *   settle(id, actualMicros|null, result)   provider confirmed a result
 *   release(id)                             request never left this server
 *   markUnknown(id)                         outcome unknown: stays counted
 *   get(id), totals()
 *
 * `durable` tells the generation gate whether reservations survive restarts
 * and are shared between processes. Paid calls are refused unless it is true.
 */
export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * MICROS_PER_USD + Number(frac.padEnd(6, "0"));
}

const dayKey = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);

/** Shared decision logic for an existing row with the same idempotency key. */
function existingKeyOutcome(existing, entry) {
  if (!existing || existing.state === "released") return null;
  if (existing.requestHash && entry.requestHash && existing.requestHash !== entry.requestHash) {
    throw new ApiError("IDEMPOTENCY_KEY_REUSED", 422,
      "This idempotency key was already used for a different request");
  }
  if (existing.state === "settled") return { replay: existing.result ?? null, reservationId: existing.id };
  throw new ApiError("DUPLICATE_IN_PROGRESS", 409,
    existing.state === "outcome_unknown"
      ? "An earlier attempt has an unknown outcome and must be reconciled before retrying"
      : "An identical request is already in progress",
    { reservationId: existing.id, state: existing.state });
}

function assertCaps(entries, caps, daySpent, monthSpent) {
  let total = 0;
  for (const e of entries) {
    if (e.amountMicros > caps.perJobMicros) {
      throw new ApiError("BUDGET_EXCEEDED", 402, "Estimated job cost exceeds the per-job cap");
    }
    total += e.amountMicros;
  }
  if (daySpent + total > caps.dailyMicros) {
    throw new ApiError("BUDGET_EXCEEDED", 402, "Daily spending cap would be exceeded");
  }
  if (monthSpent + total > caps.monthlyMicros) {
    throw new ApiError("BUDGET_EXCEEDED", 402, "Monthly spending cap would be exceeded");
  }
}

// ─── In-memory ledger (tests / local only; NOT durable) ────────────────────

export function createMemoryLedger({ durable = false, now = () => new Date() } = {}) {
  const rows = new Map();
  const byKey = new Map();

  const committed = (pred) => {
    let t = 0;
    for (const r of rows.values()) {
      if (r.state === "released" || !pred(r)) continue;
      t += r.state === "settled" ? r.actualMicros : r.amountMicros;
    }
    return t;
  };

  return {
    durable,
    kind: "memory",

    // Synchronous body: atomic within one Node process.
    async reserveGroup(entries, caps) {
      const out = [];
      const toReserve = [];
      for (const e of entries) {
        const existing = e.idempotencyKey ? rows.get(byKey.get(e.idempotencyKey)) : null;
        const outcome = existingKeyOutcome(existing, e);
        if (outcome) out.push(outcome);
        else { out.push(null); toReserve.push(e); }
      }
      const at = now();
      assertCaps(toReserve, caps, committed((r) => r.day === dayKey(at)), committed((r) => r.month === monthKey(at)));
      for (let i = 0; i < entries.length; i++) {
        if (out[i]) continue;
        const e = entries[i];
        const id = crypto.randomUUID();
        rows.set(id, {
          id, provider: e.provider, model: e.model, amountMicros: e.amountMicros, actualMicros: null,
          state: "reserved", day: dayKey(at), month: monthKey(at),
          idempotencyKey: e.idempotencyKey || null, requestHash: e.requestHash || null, result: null,
        });
        if (e.idempotencyKey) byKey.set(e.idempotencyKey, id);
        out[i] = { reservationId: id };
      }
      return out;
    },

    async settle(id, actualMicros, result = null) {
      const r = rows.get(id);
      if (!r) return;
      r.state = "settled";
      r.actualMicros = Number.isInteger(actualMicros) ? actualMicros : r.amountMicros;
      r.result = result;
    },
    async release(id) {
      const r = rows.get(id);
      if (r && r.state === "reserved") r.state = "released";
    },
    async markUnknown(id) {
      const r = rows.get(id);
      if (r && r.state === "reserved") r.state = "outcome_unknown";
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async totals() {
      const at = now();
      return { dayMicros: committed((r) => r.day === dayKey(at)), monthMicros: committed((r) => r.month === monthKey(at)) };
    },
  };
}

// ─── PostgreSQL ledger (durable, shared across processes) ──────────────────

// Arbitrary constant: a transaction-scoped advisory lock serialises every
// reservation, so cap checks and inserts are atomic across processes.
const LEDGER_LOCK_KEY = 815_120_001;

function rowOut(r) {
  if (!r) return null;
  return {
    ...r,
    amountMicros: Number(r.amountMicros),
    actualMicros: r.actualMicros === null ? null : Number(r.actualMicros),
  };
}

export function createPrismaLedger(prisma, { now = () => new Date() } = {}) {
  const sumWhere = async (tx, where) => {
    const rows = await tx.generationReservation.findMany({
      where: { ...where, state: { not: "released" } },
      select: { state: true, amountMicros: true, actualMicros: true },
    });
    return rows.reduce((t, r) =>
      t + Number(r.state === "settled" && r.actualMicros !== null ? r.actualMicros : r.amountMicros), 0);
  };

  return {
    durable: true,
    kind: "postgres",

    async reserveGroup(entries, caps) {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`;
        const out = [];
        const toReserve = [];
        const reuse = new Map(); // index -> released row id to reuse
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const existing = e.idempotencyKey
            ? rowOut(await tx.generationReservation.findUnique({ where: { idempotencyKey: e.idempotencyKey } }))
            : null;
          const outcome = existingKeyOutcome(existing, e);
          if (outcome) out.push(outcome);
          else {
            out.push(null);
            toReserve.push(e);
            if (existing) reuse.set(i, existing.id);
          }
        }
        const at = now();
        const day = dayKey(at);
        const month = monthKey(at);
        assertCaps(toReserve, caps, await sumWhere(tx, { day }), await sumWhere(tx, { month }));

        for (let i = 0; i < entries.length; i++) {
          if (out[i]) continue;
          const e = entries[i];
          const data = {
            provider: e.provider, model: e.model, amountMicros: BigInt(e.amountMicros), actualMicros: null,
            state: "reserved", day, month, requestHash: e.requestHash || null, result: undefined,
          };
          const row = reuse.has(i)
            ? await tx.generationReservation.update({ where: { id: reuse.get(i) }, data: { ...data, result: null } })
            : await tx.generationReservation.create({ data: { ...data, idempotencyKey: e.idempotencyKey || null } });
          out[i] = { reservationId: row.id };
        }
        return out;
      });
    },

    async settle(id, actualMicros, result = null) {
      const r = await prisma.generationReservation.findUnique({ where: { id } });
      if (!r) return;
      await prisma.generationReservation.update({
        where: { id },
        data: {
          state: "settled",
          actualMicros: Number.isInteger(actualMicros) ? BigInt(actualMicros) : r.amountMicros,
          result: result ?? undefined,
        },
      });
    },
    async release(id) {
      await prisma.generationReservation.updateMany({ where: { id, state: "reserved" }, data: { state: "released" } });
    },
    async markUnknown(id) {
      await prisma.generationReservation.updateMany({ where: { id, state: "reserved" }, data: { state: "outcome_unknown" } });
    },
    async get(id) {
      return rowOut(await prisma.generationReservation.findUnique({ where: { id } }));
    },
    async totals() {
      const at = now();
      return { dayMicros: await sumWhere(prisma, { day: dayKey(at) }), monthMicros: await sumWhere(prisma, { month: monthKey(at) }) };
    },
  };
}

/** Stable hash of a request description, used to detect idempotency-key reuse. */
export function requestHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
