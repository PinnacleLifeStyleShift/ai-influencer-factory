/**
 * Stable, machine-readable API errors. Messages are safe to show in the UI and
 * must never contain credentials, full provider responses or private prompts.
 */
export class ApiError extends Error {
  constructor(code, httpStatus, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function sendError(res, err, fallbackMessage = "Internal server error") {
  const requestId = res.locals?.requestId;
  if (res.locals) res.locals.errorCode = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
  if (err instanceof ApiError) {
    const body = { error: err.message, code: err.code };
    if (err.details) body.details = err.details;
    if (requestId) body.requestId = requestId;
    return res.status(err.httpStatus).json(body);
  }
  return res.status(500).json({ error: fallbackMessage, code: "INTERNAL_ERROR", ...(requestId ? { requestId } : {}) });
}

/**
 * Single error path for route handlers.
 * WHY: database errors carry query details; they are mapped to stable codes
 * and only their message is logged, never the error object or request body.
 */
export function routeError(res, err, fallbackMessage, label = "route") {
  if (err instanceof ApiError) return sendError(res, err);
  if (err?.code === "P2025") return sendError(res, new ApiError("NOT_FOUND", 404, "Not found"));
  if (err?.code === "P2002") return sendError(res, new ApiError("CONFLICT", 409, "A record with these values already exists"));
  if (err?.code === "P2003") return sendError(res, new ApiError("VALIDATION_FAILED", 400, "A referenced record does not exist"));
  console.error(`${label} error [${res.locals?.requestId || "-"}]: ${err?.code || ""} ${String(err?.message || err).split("\n")[0].slice(0, 300)}`);
  return sendError(res, err, fallbackMessage);
}
