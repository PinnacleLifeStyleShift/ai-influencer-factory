/**
 * Server-side authorization.
 *
 * WHY a central rule table instead of per-route checks: a new route cannot be
 * added without matching a rule, and the catch-all rules deny by default
 * (anything not a GET needs "edit"). Spending is its own permission: editorial
 * rights alone never allow a paid provider call.
 */
export const ROLE_PERMISSIONS = Object.freeze({
  owner: ["read", "edit", "approve", "schedule", "references", "generate", "spend", "admin"],
  editor: ["read", "edit", "schedule", "references", "generate"],
  reviewer: ["read", "approve"],
});

// Ordered: first match wins. Paths are relative to /api.
const RULES = [
  { method: "POST", path: /^\/auth\/logout$/, needs: [] },
  { method: "GET", path: /^\/auth\/me$/, needs: [] },
  { method: "POST", path: /^\/auth\/sessions\/revoke-all$/, needs: ["admin"] },
  { method: "POST", path: /^\/characters\/[^/]+\/generate-(image|video)$/, needs: ["generate", "spend"] },
  { method: "POST", path: /^\/pipeline\/generate-content$/, needs: ["generate", "spend"] },
  { method: "POST", path: /^\/characters\/[^/]+\/reference-image$/, needs: ["references"] },
  { method: "POST", path: /^\/pipeline\/[^/]+\/(approve|reject)$/, needs: ["approve"] },
  { method: "POST", path: /^\/pipeline\/[^/]+\/schedule$/, needs: ["schedule"] },
  { method: "GET", path: /^\/system\//, needs: ["admin"] },
  { method: "GET", path: /.*/, needs: ["read"] },
  { method: "*", path: /.*/, needs: ["edit"] },
];

export function requiredPermissions(method, path) {
  for (const r of RULES) {
    if ((r.method === "*" || r.method === method) && r.path.test(path)) return r.needs;
  }
  return ["admin"]; // unreachable with the catch-all; fails closed if it is removed
}

export function missingPermissions(role, needs) {
  const has = new Set(ROLE_PERMISSIONS[role] || []);
  return needs.filter((p) => !has.has(p));
}
