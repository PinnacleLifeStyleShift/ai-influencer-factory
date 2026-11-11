import { secureRouter } from "../lib/secureRouter.js";
import { onlyFields } from "../lib/requests.js";
import { ApiError, sendError } from "../lib/errors.js";
import { sessionTtlMs } from "../auth/sessions.js";
import { invitesEnabled } from "../auth/invites.js";

/** POST /api/auth/session — exchange a provider credential for a session. Mounted before requireSession. */
export function createSessionHandler({ env, provider, sessions }) {
  return async (req, res, next) => {
    try {
      const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
      const principal = m ? await provider.authenticate(m[1].trim()) : null;
      if (!principal) return sendError(res, new ApiError("AUTH_REQUIRED", 401, "Invalid credential"));
      const { token, session } = await sessions.create(principal, { provider: principal.authProvider || provider.name, ttlMs: sessionTtlMs(env) });
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
export function authRoutes({ sessions, invites, env }) {
  const router = secureRouter();
  router.get("/me", [], (req, res) => res.json({ principal: req.principal }));
  router.post("/logout", [], async (req, res, next) => {
    try {
      await sessions.revoke(req.principal.sessionId);
      res.json({ success: true });
    } catch (err) { next(err); }
  });
  router.post("/sessions/revoke-all", ["admin"], onlyFields([]), async (req, res, next) => {
    try {
      const revoked = await sessions.revokeAll(req.principal.id);
      res.json({ success: true, revoked });
    } catch (err) { next(err); }
  });
  // Invites for editors and reviewers: owner-issued credentials, so "admin"
  // and off unless ROLE_INVITES=enabled (db-role-invites.test.js).
  const enabled = () => {
    if (!invitesEnabled(env)) throw new ApiError("ROLE_INVITES_DISABLED", 409, "Editor and reviewer invites are off. Issuing credentials is an owner decision: set ROLE_INVITES=enabled to allow it.");
  };
  router.get("/invites", ["admin"], async (req, res, next) => {
    try { res.json({ enabled: invitesEnabled(env), invites: await invites.list() }); } catch (err) { next(err); }
  });
  router.post("/invites", ["admin"], onlyFields(["role", "label", "ttlHours"]), async (req, res, next) => {
    try {
      enabled();
      const { code, invite } = await invites.create(req.body, { by: req.principal.id, workspaceId: req.principal.workspaceId });
      // The code is returned once and never logged or stored (only its hash).
      res.status(201).json({ code, invite });
    } catch (err) { next(err); }
  });
  router.post("/invites/:id/revoke", ["admin"], onlyFields([]), async (req, res, next) => {
    try { res.json(await invites.revoke(req.params.id)); } catch (err) { next(err); }
  });
  return router;
}
