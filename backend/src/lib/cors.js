/**
 * Explicit CORS origin policy. There is no wildcard default: when FRONTEND_URL
 * is unset, cross-origin browser requests are not granted CORS access.
 * CORS is not access control; authentication is enforced separately.
 */
export function buildCorsOptions(env = process.env) {
  const allowed = String(env.FRONTEND_URL || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s && s !== "*");

  return {
    origin(origin, callback) {
      // Same-origin / non-browser requests carry no Origin header.
      if (!origin) return callback(null, false);
      return callback(null, allowed.includes(origin));
    },
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 600,
  };
}
