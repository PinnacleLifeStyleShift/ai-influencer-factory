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
  if (err instanceof ApiError) {
    const body = { error: err.message, code: err.code };
    if (err.details) body.details = err.details;
    if (requestId) body.requestId = requestId;
    return res.status(err.httpStatus).json(body);
  }
  return res.status(500).json({ error: fallbackMessage, code: "INTERNAL_ERROR", ...(requestId ? { requestId } : {}) });
}
