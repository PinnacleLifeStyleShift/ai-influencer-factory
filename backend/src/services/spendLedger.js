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

/**
 * Cap periods are calendar days/months in the configured cap timezone
 * (WHY: "daily cap" should match the owner's day, not UTC's). Rows store the
 * period keys they were counted in.
 */
export function periodKeys(date, timeZone = "UTC") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}` };
}
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** Settlement amounts: null (keep the estimate) or a non-negative integer of micro-units. */
function assertActual(actualMicros) {
  if (actualMicros === null || actualMicros === undefined) return;
  if (!Number.isInteger(actualMicros) || actualMicros < 0) {
    throw new ApiError("VALIDATION_FAILED", 400, "An actual cost must be a non-negative amount");
  }
}
const SETTLEABLE = ["reserved", "outcome_unknown"];

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

/**
 * WHY the per-job cap is checked against the WHOLE workflow (review IF-R1):
 * an operator's "maximum for one generation request" must bound the request,
 * not each of its steps; per step, two $0.75 steps passed a $1.00 job cap.
 * `workflow` is every step of the request (including steps replayed from an
 * earlier attempt); `entries` are the ones newly reserved now, which count
 * against the daily and monthly caps. Test: review-1112 IF-R1.
 */
function assertCaps(entries, caps, daySpent, monthSpent, workflow = entries) {
  const jobTotal = workflow.reduce((t, e) => t + e.amountMicros, 0);
  if (jobTotal > caps.perJobMicros) {
    throw new ApiError("BUDGET_EXCEEDED", 402, "Estimated cost of this generation request exceeds the per-job cap");
  }
  let total = 0;
  for (const e of entries) total += e.amountMicros;
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
      // A settled charge counts at its verified actual when known, else at the
      // conservative estimate; "unknown" is never recorded as an actual (IF-R2).
      t += r.state === "settled" && r.actualMicros !== null ? r.actualMicros : r.amountMicros;
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
      const { day, month } = periodKeys(at, caps.timezone);
      assertCaps(toReserve, caps, committed((r) => r.day === day), committed((r) => r.month === month), entries);
      for (let i = 0; i < entries.length; i++) {
        if (out[i]) continue;
        const e = entries[i];
        const id = crypto.randomUUID();
        rows.set(id, {
          id, provider: e.provider, model: e.model, amountMicros: e.amountMicros, actualMicros: null,
          state: "reserved", day, month,
          idempotencyKey: e.idempotencyKey || null, requestHash: e.requestHash || null, result: null,
          currency: e.currency || "USD", priceVersion: e.priceVersion || null, capTimezone: caps.timezone || null,
        });
        if (e.idempotencyKey) byKey.set(e.idempotencyKey, id);
        out[i] = { reservationId: id };
      }
      return out;
    },

    async settle(id, actualMicros, result = null) {
      assertActual(actualMicros);
      const r = rows.get(id);
      // Settles once, and only an open reservation: recorded spend never moves back.
      if (!r || !SETTLEABLE.includes(r.state)) return;
      r.state = "settled";
      r.actualMicros = Number.isInteger(actualMicros) ? actualMicros : null;
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
    async totals(timeZone = "UTC") {
      const { day, month } = periodKeys(now(), timeZone);
      return { dayMicros: committed((r) => r.day === day), monthMicros: committed((r) => r.month === month) };
    },
    async findByKey(key) {
      const id = byKey.get(key);
      return id ? { ...rows.get(id) } : null;
    },
    /** Operator/provider resolution of an open or uncertain reservation. */
    async resolve(id, { charged, actualMicros = null, result = null }) {
      assertActual(actualMicros);
      const r = rows.get(id);
      if (!r || !SETTLEABLE.includes(r.state)) throw new ApiError("NOT_RESOLVABLE", 409, "This reservation is not open or uncertain");
      if (charged) { r.state = "settled"; r.actualMicros = Number.isInteger(actualMicros) ? actualMicros : null; r.result = result; }
      else r.state = "released";
      return { ...r };
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
        const { day, month } = periodKeys(at, caps.timezone);
        assertCaps(toReserve, caps, await sumWhere(tx, { day }), await sumWhere(tx, { month }), entries);

        for (let i = 0; i < entries.length; i++) {
          if (out[i]) continue;
          const e = entries[i];
          const data = {
            provider: e.provider, model: e.model, amountMicros: BigInt(e.amountMicros), actualMicros: null,
            state: "reserved", day, month, requestHash: e.requestHash || null, result: undefined,
            currency: e.currency || "USD", priceVersion: e.priceVersion || null, capTimezone: caps.timezone || null,
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
      assertActual(actualMicros);
      const r = await prisma.generationReservation.findUnique({ where: { id } });
      if (!r) return;
      // Conditional: settles once, and only an open reservation.
      await prisma.generationReservation.updateMany({
        where: { id, state: { in: SETTLEABLE } },
        data: {
          state: "settled",
          actualMicros: Number.isInteger(actualMicros) ? BigInt(actualMicros) : null,
          result: result ?? undefined,
        },
      });
    },
    // `tx` lets recovery change money and the step in one transaction (IF-R4).
    async release(id, { tx } = {}) {
      await (tx || prisma).generationReservation.updateMany({ where: { id, state: "reserved" }, data: { state: "released" } });
    },
    async markUnknown(id, { tx } = {}) {
      await (tx || prisma).generationReservation.updateMany({ where: { id, state: "reserved" }, data: { state: "outcome_unknown" } });
    },
    async get(id) {
      return rowOut(await prisma.generationReservation.findUnique({ where: { id } }));
    },
    async totals(timeZone = "UTC") {
      const { day, month } = periodKeys(now(), timeZone);
      return { dayMicros: await sumWhere(prisma, { day }), monthMicros: await sumWhere(prisma, { month }) };
    },
    async findByKey(key) {
      return rowOut(await prisma.generationReservation.findUnique({ where: { idempotencyKey: key } }));
    },
    // `tx`: run inside the caller's transaction, so the reservation, the step
    // decision and its audit record commit together or not at all.
    async resolve(id, { charged, actualMicros = null, result = null }, { tx } = {}) {
      assertActual(actualMicros);
      const db = tx || prisma;
      const r = await db.generationReservation.findUnique({ where: { id } });
      if (!r) throw new ApiError("NOT_FOUND", 404, "Reservation not found");
      const data = charged
        ? { state: "settled", actualMicros: Number.isInteger(actualMicros) ? BigInt(actualMicros) : null, result: result ?? undefined }
        : { state: "released" };
      const { count } = await db.generationReservation.updateMany({ where: { id, state: { in: SETTLEABLE } }, data });
      if (count !== 1) throw new ApiError("NOT_RESOLVABLE", 409, "This reservation is not open or uncertain");
      return rowOut(await db.generationReservation.findUnique({ where: { id } }));
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
