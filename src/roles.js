/**
 * Role-aware display (spec of 11 November 2026, IF01).
 *
 * WHY a copy of the role table here: the browser uses it only to decide what
 * to SHOW. Every action is still checked on the server (route-bound
 * permissions, auth-route-matrix tests); hiding a control is a courtesy, never
 * the protection. If this table drifts, the server's refusal is what counts.
 */
export const ROLE_PERMISSIONS = Object.freeze({
  owner: ["read", "edit", "approve", "schedule", "export", "publish", "references", "generate", "spend", "admin"],
  editor: ["read", "edit", "schedule", "export", "references", "generate"],
  reviewer: ["read", "approve"],
});

export const can = (role, permission) => Boolean(ROLE_PERMISSIONS[role]?.includes(permission));

/** Navigation entries the role may open; an entry with `needs` is hidden otherwise. */
export const visibleNav = (nav, role) => nav.filter((n) => !n.needs || can(role, n.needs));
