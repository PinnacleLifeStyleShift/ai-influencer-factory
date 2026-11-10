import { ApiError, sendError } from "./errors.js";

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Reads an optional Idempotency-Key header; rejects malformed keys. */
export function readIdempotencyKey(req) {
  const raw = req.get("idempotency-key");
  if (raw === undefined || raw === "") return undefined;
  if (!KEY_PATTERN.test(raw)) {
    throw new ApiError("VALIDATION_FAILED", 400, "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -");
  }
  return raw;
}

/** Prisma unique-constraint violation. */
export function isUniqueViolation(err) {
  return err?.code === "P2002";
}

/**
 * Rejects request-body fields a sensitive route does not accept.
 *
 * WHY: on approval, money, rights, reconciliation and switch routes an
 * unexpected field is either a client bug or an attempt to smuggle state
 * (e.g. "approvedBy", "stage", "actualMicros"). Refusing it with a stable
 * code is safer than silently ignoring it.
 */
export function onlyFields(allowed) {
  const set = new Set(allowed);
  return (req, res, next) => {
    const body = req.body;
    if (body === undefined || body === null) return next();
    if (typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, new ApiError("VALIDATION_FAILED", 400, "The request body must be a JSON object"));
    }
    const unknown = Object.keys(body).filter((k) => !set.has(k));
    if (unknown.length) {
      return sendError(res, new ApiError("UNKNOWN_FIELDS", 400, `Unsupported field(s): ${unknown.slice(0, 10).join(", ")}`, { unknown: unknown.slice(0, 20), allowed }));
    }
    return next();
  };
}
