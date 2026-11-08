import { ApiError, sendError } from "../lib/errors.js";

/**
 * Small fixed-window in-memory rate limiter. Single-process only; a shared
 * store is needed if the API is ever run with multiple replicas.
 */
export function rateLimit({ windowMs, max, keyFn = (req) => req.ip, now = () => Date.now() }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = keyFn(req);
    let entry = hits.get(key);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - t) / 1000)));
      return sendError(res, new ApiError("RATE_LIMITED", 429, "Too many requests; try again later"));
    }
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
    }
    return next();
  };
}
