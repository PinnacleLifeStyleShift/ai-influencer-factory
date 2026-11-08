import { ApiError } from "./errors.js";

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
