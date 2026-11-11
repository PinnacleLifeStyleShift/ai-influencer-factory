import crypto from "crypto";
import { ApiError } from "../lib/errors.js";
import { hashToken } from "./sessions.js";

/**
 * Owner-issued invitations for editors and reviewers (spec of 11 November
 * 2026, IF01). WHY this shape:
 *  - Issuing a credential is an owner decision, so the feature is off unless
 *    ROLE_INVITES=enabled and the route needs "admin".
 *  - Never "owner": the only owner credential is OWNER_API_TOKEN, so an
 *    invite cannot escalate. Weakening this lets an editor mint an owner.
 *  - Single use, and enrollment is ATOMIC with revocation (review IF-CR01):
 *    enroll() locks the invite row (SELECT ... FOR UPDATE), re-checks used,
 *    revoked and expiry with the clock read under the lock, creates the
 *    session and marks the invite used in ONE transaction; revoke() takes the
 *    same row lock. So revocation either happens first (enrollment refused)
 *    or waits and then ends the new session. A failed session write rolls the
 *    claim back, leaving the invite usable. Session lookup also re-checks the
 *    invite (defence in depth). Tests: db-invite-revocation-race.
 *  - Only a hash is stored and the code is returned once, like sessions.
 */
export const INVITE_ROLES = ["editor", "reviewer"];
export const MAX_INVITE_TTL_HOURS = 72;
export const DEFAULT_INVITE_TTL_HOURS = 24;

export const invitesEnabled = (env) => env.ROLE_INVITES === "enabled";

const invalid = (fields) => new ApiError("VALIDATION_FAILED", 400, "Invite is invalid", { fields });
const safe = (i) => ({ id: i.id, role: i.role, label: i.label, createdBy: i.createdBy, createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: i.usedAt, revokedAt: i.revokedAt });

export function createInviteService(prisma, { now = () => new Date() } = {}) {
  return {
    async create(body, { by, workspaceId = "default" }) {
      const { role, label, ttlHours = DEFAULT_INVITE_TTL_HOURS } = body || {};
      const fields = {};
      if (!INVITE_ROLES.includes(role)) fields.role = "must be editor or reviewer";
      if (typeof label !== "string" || !label.trim() || label.length > 80) fields.label = "is required (who it is for, at most 80 characters)";
      if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_INVITE_TTL_HOURS) fields.ttlHours = `must be a whole number of hours from 1 to ${MAX_INVITE_TTL_HOURS}`;
      if (Object.keys(fields).length) throw invalid(fields);
      const code = crypto.randomBytes(32).toString("base64url");
      const invite = await prisma.roleInvite.create({ data: {
        codeHash: hashToken(code), role, label: label.trim(), workspaceId, createdBy: by,
        expiresAt: new Date(now().getTime() + ttlHours * 3600_000),
      } });
      return { code, invite: safe(invite) };
    },

    async list() {
      return (await prisma.roleInvite.findMany({ orderBy: { createdAt: "desc" }, take: 100 })).map(safe);
    },

    /**
     * Claims the invite and enrolls its session atomically. Returns
     * { token, session, principal } or null when the code is unknown, used,
     * revoked or expired. `hooks.afterClaim` exists for race tests only.
     */
    async enroll(code, { sessions, ttlMs, hooks = {} }) {
      if (!code) return null;
      const codeHash = hashToken(code);
      return prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw`
          SELECT id, role, workspace_id, used_at, revoked_at, expires_at
          FROM role_invites WHERE code_hash = ${codeHash} FOR UPDATE`;
        if (!row || row.used_at || row.revoked_at || new Date(row.expires_at) <= now()) return null;
        await hooks.afterClaim?.();
        const principal = { id: `invite:${row.id}`, role: row.role, workspaceId: row.workspace_id };
        const { token, session } = await sessions.create(principal, { provider: "role-invite", ttlMs, client: tx });
        await tx.roleInvite.update({ where: { id: row.id }, data: { usedAt: now() } });
        return { token, session, principal };
      });
    },

    /** Claim only, without a session. Kept for the race reproduction; not used by routes. */
    async redeem(code) {
      if (!code) return null;
      const at = now();
      const invite = await prisma.roleInvite.findUnique({ where: { codeHash: hashToken(code) } });
      if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt <= at) return null;
      const { count } = await prisma.roleInvite.updateMany({ where: { id: invite.id, usedAt: null, revokedAt: null }, data: { usedAt: at } });
      if (count !== 1) return null;
      return { id: `invite:${invite.id}`, role: invite.role, workspaceId: invite.workspaceId, authProvider: "role-invite" };
    },

    /** Revokes the invite and any session it created. */
    async revoke(id) {
      // Same row lock as enroll(): waits for an enrollment in progress, so the
      // session it creates is found and ended here.
      return prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw`SELECT id FROM role_invites WHERE id = ${id} FOR UPDATE`;
        if (!row) throw new ApiError("NOT_FOUND", 404, "Invite not found");
        const at = now();
        await tx.roleInvite.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
        const { count } = await tx.session.updateMany({ where: { principalId: `invite:${id}`, revokedAt: null }, data: { revokedAt: at } });
        return { invite: safe(await tx.roleInvite.findUnique({ where: { id } })), sessionsRevoked: count };
      });
    },
  };
}
