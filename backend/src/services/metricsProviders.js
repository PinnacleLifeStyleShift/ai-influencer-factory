import { ApiError } from "../lib/errors.js";
import { recordObservation } from "./metrics.js";

/**
 * Platform metrics providers (official analytics APIs).
 *
 * Contract: { name, platform, implemented: true,
 *   fetch(posts) -> [{ subjectType, subjectId, metric, kind, value, observedAt, periodStart?, periodEnd? }] }
 * Readings are stored with source "api" and the provider's name.
 *
 * WHY none is implemented: reading analytics needs the same approved account,
 * official API access and scopes as publishing, and some analytics are paid.
 * Nothing restricted or private is scraped. Until a provider is approved,
 * refreshing is refused (METRICS_API_DISABLED) and the screens say so.
 */
export function defaultMetricsProviders() { return []; }

export async function refreshFromProviders(prisma, providers, env, { by, now = new Date() }) {
  const ready = providers.filter((p) => p.implemented);
  if (env.METRICS_API !== "enabled" || !ready.length) {
    throw new ApiError("METRICS_API_DISABLED", 503, "No platform analytics provider is enabled",
      { missing: [...(env.METRICS_API !== "enabled" ? ["METRICS_API=enabled"] : []), ...(!ready.length ? ["an implemented, approved analytics provider"] : [])] });
  }
  const posts = await prisma.publishDelivery.findMany({ where: { simulated: false, state: { in: ["published", "resolved_published"] } } });
  const summary = [];
  for (const p of ready) {
    const mine = posts.filter((d) => d.platform === p.platform);
    let recorded = 0; let replayed = 0; const rejected = [];
    for (const r of await p.fetch(mine)) {
      try {
        const out = await recordObservation(prisma, { ...r, source: "api", sourceDetail: p.name, observedAt: r.observedAt, platform: p.platform }, { by, allowApi: true, now });
        out.replayed ? replayed++ : recorded++;
      } catch (err) {
        rejected.push({ subjectId: r.subjectId, metric: r.metric, code: err.code || "ERROR" });
      }
    }
    summary.push({ provider: p.name, platform: p.platform, posts: mine.length, recorded, replayed, rejected });
  }
  return summary;
}
