import { assemblyCapability } from "./mediaAssembly.js";

/**
 * Capability map (completion spec recommendation): for each live capability,
 * what is BUILT, whether it is CONFIGURED (required settings present, by name
 * only), whether it is switched ON, and what VERIFIED it so far.
 *
 * WHY: a green build or a configured key was being read as "live". This keeps
 * the four apart. Values are never read into the result, only presence, so a
 * secret cannot leak through this view (capabilities test, secret marker).
 */
const present = (env, names) => names.filter((n) => !env[n]);

export function capabilityMap(env = process.env) {
  const cap = (key, label, { built, required, enabled, verifiedBy, needs }) => {
    const missing = present(env, required);
    return { key, label, built, enabled, configured: missing.length === 0, missing, verifiedBy, needs };
  };
  const assembly = assemblyCapability(env);
  return [
    cap("generation", "Paid image and video generation", {
      built: "Durable jobs, reservations, reconciliation; mock providers. No live provider adapter is approved.",
      required: ["APPROVED_PROVIDER_MODELS", "PROVIDER_PRICES_USD", "PRICE_CURRENCY", "PRICE_VERSION", "SPEND_CAP_TIMEZONE", "SPEND_CAP_PER_JOB_USD", "SPEND_CAP_DAILY_USD", "SPEND_CAP_MONTHLY_USD"],
      enabled: env.LIVE_PROVIDER_CALLS === "enabled",
      verifiedBy: "Synthetic tests with mock providers only (db-jobs, db-generation-races, db-role-journey). Never run against a real provider.",
      needs: "Owner approval of provider and model, entitlement, commercial rights, prices and caps (activation checklist B).",
    }),
    cap("publishing", "Posting to platform accounts", {
      built: "Interfaces, per-destination deliveries and reconciliation; simulation only, no real publisher adapter.",
      required: ["APPROVED_PUBLISH_DESTINATIONS", "PUBLISH_ACCOUNTS"],
      enabled: env.LIVE_PUBLISHING === "enabled",
      verifiedBy: "Simulation tests (db-publishing, e2e publishing). Nothing has been posted.",
      needs: "Outside the first release; official API access and account approval (activation checklist C).",
    }),
    cap("mediaStorage", "Private media storage and export of real files", {
      built: "Media store interface with a local synthetic fixture adapter; no object storage adapter yet.",
      required: ["MEDIA_STORE"],
      enabled: env.MEDIA_STORE === "synthetic-fixture",
      verifiedBy: "Fixture-store tests (db-review-export, db-storage-failures, db-contracts). No signed links exist.",
      needs: "Owner choice of private storage and budget, then an adapter with isolation, expiring links, limits and SSRF checks (checklist A).",
    }),
    cap("assembly", "Rendering a multi-shot package into one video", {
      built: "Deterministic ffmpeg assembly with recorded lineage; output is silent, captions not burned in.",
      required: ["MEDIA_ASSEMBLY"],
      enabled: assembly.available,
      verifiedBy: "db-assembly, db-lineage; the assembled H.264 file plays to the end in the browser check (e2e media-playback).",
      needs: assembly.available ? "Media storage must also be approved." : `Unavailable: ${assembly.reason}. The production image has no ffmpeg (checklist A).`,
    }),
    cap("analytics", "Platform analytics readings", {
      built: "Manual readings with source; provider interface without an implemented provider.",
      required: ["METRICS_API"],
      enabled: env.METRICS_API === "enabled",
      verifiedBy: "db-measurement, db-metric-intervals (manual and fixture readings).",
      needs: "Platform analytics access and a provider adapter (checklist E).",
    }),
    cap("roleInvites", "Editor and reviewer invites", {
      built: "Single-use, expiring invites; enrollment atomic with revocation.",
      required: ["ROLE_INVITES"],
      enabled: env.ROLE_INVITES === "enabled",
      verifiedBy: "db-role-invites, db-invite-revocation-race, e2e ui-auth and role-journey.",
      needs: "Owner decision to issue credentials (checklist D).",
    }),
    // Not a setting: the supported tenancy model, stated so the workspace field
    // is never read as an isolation boundary (review 14 Nov, isolation).
    { key: "multiWorkspace", label: "Multiple isolated workspaces", enabled: false, configured: false, missing: [],
      built: "No. One private workspace. Sessions carry a workspace id, but queries are not scoped by it; it is not an isolation boundary.",
      verifiedBy: "Not applicable: not offered. Single-workspace role and route checks: auth-route-matrix, db-role-journey.",
      needs: "An ownership model and a route-by-route two-workspace isolation test matrix before any multi-tenant use." },
    cap("retention", "Deleting data after a retention period", {
      built: "Policy parser; unset means nothing is deleted.",
      required: ["RETENTION_POLICY"],
      enabled: Boolean(env.RETENTION_POLICY),
      verifiedBy: "db-contracts retention test.",
      needs: "Owner retention decision per category.",
    }),
  ];
}
