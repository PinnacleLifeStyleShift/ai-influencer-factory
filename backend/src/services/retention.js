/**
 * Retention policy, by category, as an owner decision.
 *
 * WHY typed and empty by default: how long to keep original references,
 * rendered exports, the audit trail and job/money evidence is a business,
 * legal and cost decision. Until the owner sets RETENTION_POLICY, nothing in
 * these categories is deleted (only long-dead sessions are pruned). When a
 * policy exists, a deletion job must keep provenance consistent: an export
 * whose files are gone is reported as incomplete (see verifyExport), never
 * shown as complete.
 */
export const RETENTION_CATEGORIES = Object.freeze(["originalReferences", "renderedExports", "auditTrail", "jobAndMoneyEvidence"]);

export function retentionPolicy(env = process.env) {
  let parsed = {};
  let valid = true;
  if (env.RETENTION_POLICY) { try { parsed = JSON.parse(env.RETENTION_POLICY); } catch { valid = false; } }
  return Object.fromEntries(RETENTION_CATEGORIES.map((c) => {
    const d = parsed?.[c];
    const ok = Number.isInteger(d) && d >= 30 && d <= 36500;
    return [c, ok && valid ? { retainDays: d, state: "set" } : { retainDays: null, state: valid ? "not set (owner decision): nothing is deleted" : "invalid RETENTION_POLICY: nothing is deleted" }];
  }));
}
