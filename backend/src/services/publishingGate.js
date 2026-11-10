import { ApiError } from "../lib/errors.js";
import { DESTINATIONS } from "../lib/revision.js";

/**
 * Publishing gate. Fails closed: a real (non-simulated) delivery needs ALL of
 *   1. an implemented adapter for the destination,
 *   2. LIVE_PUBLISHING=enabled,
 *   3. the destination listed in APPROVED_PUBLISH_DESTINATIONS (owner approval),
 *   4. an account record in PUBLISH_ACCOUNTS (JSON, no secrets) with
 *      accountRef, verified scopes, eligibilityVerifiedAt (when official API
 *      eligibility was checked) and approvalReference (where it was approved).
 * Simulated adapters need only PUBLISHING_SIMULATION=enabled and never count
 * as published. Content and destination approval is checked separately, per
 * delivery, against the approved snapshot.
 */
function accounts(env) {
  try { return env.PUBLISH_ACCOUNTS ? JSON.parse(env.PUBLISH_ACCOUNTS) : {}; } catch { return null; }
}

export function createPublishingGate({ env = process.env, publishers }) {
  function check(platform) {
    const adapter = publishers[platform];
    if (!adapter || !adapter.implemented) {
      return { ready: false, adapter, missing: [adapter?.reason || `No publisher for ${platform}`], code: "PUBLISHER_NOT_IMPLEMENTED" };
    }
    if (adapter.simulated) {
      return env.PUBLISHING_SIMULATION === "enabled"
        ? { ready: true, adapter, simulated: true, account: { accountRef: "simulated" } }
        : { ready: false, adapter, missing: ["PUBLISHING_SIMULATION=enabled"], code: "PUBLISHING_DISABLED" };
    }
    const missing = [];
    if (env.LIVE_PUBLISHING !== "enabled") missing.push("LIVE_PUBLISHING=enabled");
    const approved = (env.APPROVED_PUBLISH_DESTINATIONS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!approved.includes(platform)) missing.push(`${platform} in APPROVED_PUBLISH_DESTINATIONS`);
    const all = accounts(env);
    const a = all?.[platform];
    if (all === null) missing.push("PUBLISH_ACCOUNTS must be valid JSON");
    else if (!a) missing.push(`PUBLISH_ACCOUNTS.${platform}`);
    else {
      if (typeof a.accountRef !== "string" || !a.accountRef) missing.push(`PUBLISH_ACCOUNTS.${platform}.accountRef`);
      if (!Array.isArray(a.scopes) || !a.scopes.length) missing.push(`PUBLISH_ACCOUNTS.${platform}.scopes (verified)`);
      const at = new Date(a.eligibilityVerifiedAt);
      if (!a.eligibilityVerifiedAt || Number.isNaN(at.getTime()) || at > new Date()) missing.push(`PUBLISH_ACCOUNTS.${platform}.eligibilityVerifiedAt (official API eligibility check date)`);
      if (typeof a.approvalReference !== "string" || a.approvalReference.length < 5) missing.push(`PUBLISH_ACCOUNTS.${platform}.approvalReference`);
    }
    return missing.length
      ? { ready: false, adapter, missing, code: "PUBLISHING_DISABLED" }
      : { ready: true, adapter, simulated: false, account: { accountRef: a.accountRef } };
  }
  return {
    preflight(platform) {
      const c = check(platform);
      if (!c.ready) throw new ApiError(c.code, 503, `Publishing to ${platform} is not enabled`, { platform, missing: c.missing });
      return c;
    },
    describe() {
      return DESTINATIONS.map((p) => {
        const c = check(p);
        return { platform: p, implemented: Boolean(c.adapter?.implemented), simulated: Boolean(c.adapter?.simulated), ready: c.ready, missing: c.missing || [] };
      });
    },
  };
}
