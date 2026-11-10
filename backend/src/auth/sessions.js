import crypto from "crypto";

/**
 * Session store. A session token is 32 random bytes shown to the client once;
 * only its SHA-256 hash is stored, so a database read cannot be replayed as a
 * credential. Sessions expire and can be revoked individually or all at once.
 */
export const DEFAULT_SESSION_TTL_HOURS = 12;
export const MAX_SESSION_TTL_HOURS = 168;

export const hashToken = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

export function sessionTtlMs(env) {
  const h = Number(env.SESSION_TTL_HOURS);
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, MAX_SESSION_TTL_HOURS) : DEFAULT_SESSION_TTL_HOURS;
  return hours * 3600 * 1000;
}

export function createSessionStore(prisma, { now = () => new Date() } = {}) {
  return {
    async create(principal, { provider, ttlMs }) {
      const token = `ses_${crypto.randomBytes(32).toString("base64url")}`;
      const at = now();
      const session = await prisma.session.create({
        data: {
          tokenHash: hashToken(token),
          principalId: principal.id,
          role: principal.role,
          workspaceId: principal.workspaceId || "default",
          authProvider: provider,
          expiresAt: new Date(at.getTime() + ttlMs),
        },
      });
      return { token, session };
    },

    /** Returns { session, status } where status is active | revoked | expired | unknown. */
    async lookup(token) {
      if (!token || !token.startsWith("ses_")) return { session: null, status: "unknown" };
      const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!session) return { session: null, status: "unknown" };
      if (session.revokedAt) return { session, status: "revoked" };
      if (session.expiresAt.getTime() <= now().getTime()) return { session, status: "expired" };
      return { session, status: "active" };
    },

    /** Records activity at most once a minute (WHY: avoid a write per request). */
    async touch(session) {
      const at = now();
      if (session.lastSeenAt && at - session.lastSeenAt < 60_000) return;
      await prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: at } });
    },

    async revoke(sessionId) {
      await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now() } });
    },

    async revokeAll(principalId) {
      const { count } = await prisma.session.updateMany({
        where: { principalId, revokedAt: null },
        data: { revokedAt: now() },
      });
      return count;
    },
  };
}
