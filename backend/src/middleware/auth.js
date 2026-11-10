import { ApiError, sendError } from "../lib/errors.js";
import { MIN_TOKEN_LENGTH, ownerTokenConfigured, secretsEqual } from "../auth/providers.js";

export { MIN_TOKEN_LENGTH };

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  return m ? m[1].trim() : "";
}

/**
 * Fails closed when no credential can ever be issued: without a configured
 * owner token no session can exist, so every protected request is refused.
 */
export function requireAuthConfigured(env) {
  return (_req, res, next) =>
    ownerTokenConfigured(env)
      ? next()
      : sendError(res, new ApiError("AUTH_NOT_CONFIGURED", 503, "API authentication is not configured on the server"));
}

/**
 * Requires an active session. The owner token itself is refused here (it is
 * only exchanged at POST /api/auth/session) so that every API call is tied to
 * a session that can expire and be revoked.
 */
export function requireSession({ env, sessions }) {
  return async (req, res, next) => {
    try {
      const token = bearer(req);
      if (!token) return sendError(res, new ApiError("AUTH_REQUIRED", 401, "Authentication required"));
      const { session, status } = await sessions.lookup(token);
      if (status === "revoked") return sendError(res, new ApiError("SESSION_REVOKED", 401, "This session was signed out"));
      if (status === "expired") return sendError(res, new ApiError("SESSION_EXPIRED", 401, "This session has expired"));
      if (status !== "active") {
        if (ownerTokenConfigured(env) && secretsEqual(token, env.OWNER_API_TOKEN)) {
          return sendError(res, new ApiError("SESSION_REQUIRED", 401,
            "Exchange the owner token for a session at POST /api/auth/session"));
        }
        return sendError(res, new ApiError("AUTH_REQUIRED", 401, "Authentication required"));
      }
      req.principal = {
        id: session.principalId,
        role: session.role,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        provider: session.authProvider,
      };
      sessions.touch(session).catch(() => {});
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
