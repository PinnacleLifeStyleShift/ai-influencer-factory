import { Router } from "express";
import { ApiError, sendError } from "../lib/errors.js";
import { sessionTtlMs } from "../auth/sessions.js";

/** POST /api/auth/session — exchange a provider credential for a session. Mounted before requireSession. */
export function createSessionHandler({ env, provider, sessions }) {
  return async (req, res, next) => {
    try {
      const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
      const principal = m ? await provider.authenticate(m[1].trim()) : null;
      if (!principal) return sendError(res, new ApiError("AUTH_REQUIRED", 401, "Invalid credential"));
      const { token, session } = await sessions.create(principal, { provider: provider.name, ttlMs: sessionTtlMs(env) });
      // Lets the audit trail attribute the new session to its principal.
      req.principal = { id: principal.id, role: principal.role, workspaceId: session.workspaceId, sessionId: session.id };
      res.status(201).json({
        sessionToken: token,
        expiresAt: session.expiresAt,
        principal: { id: principal.id, role: principal.role, workspaceId: session.workspaceId },
      });
    } catch (err) {
      next(err);
    }
  };
}

/** Routes that need an existing session. */
export function authRoutes({ sessions }) {
  const router = Router();
  router.get("/me", (req, res) => res.json({ principal: req.principal }));
  router.post("/logout", async (req, res, next) => {
    try {
      await sessions.revoke(req.principal.sessionId);
      res.json({ success: true });
    } catch (err) { next(err); }
  });
  router.post("/sessions/revoke-all", async (req, res, next) => {
    try {
      const revoked = await sessions.revokeAll(req.principal.id);
      res.json({ success: true, revoked });
    } catch (err) { next(err); }
  });
  return router;
}
