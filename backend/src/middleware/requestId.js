import crypto from "crypto";

const INBOUND = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Correlation ID for every request: a well-formed inbound X-Request-Id is
 * kept (so a proxy's id ties logs together), otherwise a new one is made.
 * It is returned in the X-Request-Id header and in every error body.
 */
export function requestId() {
  return (req, res, next) => {
    const inbound = req.get("x-request-id");
    const id = inbound && INBOUND.test(inbound) ? inbound : crypto.randomUUID();
    req.requestId = id;
    res.locals.requestId = id;
    res.set("X-Request-Id", id);
    next();
  };
}
