import { ApiError, sendError } from "../lib/errors.js";

/**
 * Server-side authorization, declared on each route registration.
 *
 * WHY route-bound (Package 1 of the 10 Nov spec): the earlier URL-pattern
 * table was case-sensitive and anchored, while Express routes are matched
 * case-insensitively and ignore a trailing slash. "/generate-image/" or
 * "/GENERATE-IMAGE" missed the "generate + spend" rule, fell through to plain
 * "edit" and still reached the handler. Now the permission is part of the
 * route itself (secureRouter), so every way of reaching a handler carries
 * the same declaration, and a mutation without one cannot be registered.
 * Spending is its own permission: editorial rights never allow a paid call.
 */
export const ROLE_PERMISSIONS = Object.freeze({
  owner: ["read", "edit", "approve", "schedule", "export", "publish", "references", "generate", "spend", "admin"],
  editor: ["read", "edit", "schedule", "export", "references", "generate"],
  reviewer: ["read", "approve"],
});
export const PERMISSIONS = Object.freeze(new Set(Object.values(ROLE_PERMISSIONS).flat()));

export function missingPermissions(role, needs) {
  const has = new Set(ROLE_PERMISSIONS[role] || []);
  return needs.filter((p) => !has.has(p));
}

export const PERMISSION_DECLARATION = Symbol("permissionDeclaration");

/** Route middleware enforcing a declared permission set ([] = any signed-in session). */
export function allow(needs) {
  if (!Array.isArray(needs)) throw new Error("allow() needs an array of permissions");
  for (const p of needs) if (!PERMISSIONS.has(p)) throw new Error(`Unknown permission "${p}"`);
  const mw = (req, res, next) => {
    const missing = missingPermissions(req.principal?.role, needs);
    if (missing.length) return sendError(res, new ApiError("FORBIDDEN", 403, "You do not have permission for this action", { missing }));
    return next();
  };
  mw[PERMISSION_DECLARATION] = Object.freeze([...needs]);
  return mw;
}
