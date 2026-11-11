import crypto from "crypto";

/**
 * Auth providers turn a presented credential into a principal.
 *
 * Interface: { name, authenticate(credential) -> Promise<principal|null> }
 * where principal = { id, role, workspaceId }.
 *
 * WHY an interface: the owner bearer token is an interim credential for a
 * single-owner deployment. Choosing a real login provider (accounts, SSO,
 * passkeys) is an owner decision; when made, it becomes another provider here
 * and nothing downstream of sessions changes. See docs/adr/0001.
 */
export const MIN_TOKEN_LENGTH = 32;

const digest = (v) => crypto.createHash("sha256").update(String(v), "utf8").digest();

/** Constant-time comparison of two secrets of any length. */
export function secretsEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export function ownerTokenConfigured(env) {
  return Boolean(env.OWNER_API_TOKEN) && env.OWNER_API_TOKEN.length >= MIN_TOKEN_LENGTH;
}

/** The interim provider: the server-side OWNER_API_TOKEN is the owner's credential. */
export function createOwnerTokenProvider(env) {
  return {
    name: "owner-token",
    async authenticate(credential) {
      if (!ownerTokenConfigured(env) || !credential) return null;
      if (!secretsEqual(credential, env.OWNER_API_TOKEN)) return null;
      return { id: "owner", role: "owner", workspaceId: "default" };
    },
  };
}

/**
 * The owner token first, then (only when enabled) a single-use role invite.
 * The owner token is checked in constant time before any database lookup.
 */
export function createCompositeProvider(owner, invites, env) {
  return {
    name: owner.name,
    async authenticate(credential) {
      const p = await owner.authenticate(credential);
      if (p) return p;
      if (!invites || env.ROLE_INVITES !== "enabled") return null;
      return invites.redeem(credential);
    },
  };
}
