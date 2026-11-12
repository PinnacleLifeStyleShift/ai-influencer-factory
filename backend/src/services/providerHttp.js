/**
 * Bounded, credential-safe HTTP for provider adapters (review IF-R6, IF-R7).
 *
 * WHY:
 *  - Deadlines (IF-R7): a provider request or body read that never finishes
 *    would outlive the generation lease, keep money reserved and block
 *    shutdown. Every call has a per-request timeout (PROVIDER_REQUEST_TIMEOUT_MS,
 *    default 60 s), optionally capped by an overall deadline for the whole
 *    workflow step. A timeout AFTER a submission may have been accepted is
 *    not "never sent": callers leave it to the gate, which records the
 *    outcome as unknown (never re-buys).
 *  - Destinations (IF-R6): a URL taken from a provider response is checked
 *    against that provider's own https origin and path BEFORE a credential
 *    is attached; credentialed calls never follow redirects.
 * Tests: review-1112 (IF-R6, IF-R7).
 */
const perRequestMs = () => Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS) || 60_000;

export function timeoutError(ms) {
  const e = new Error(`provider request timed out after ${ms} ms`);
  e.code = "PROVIDER_TIMEOUT";
  return e;
}

/** An overall budget for one workflow step: { at: epochMs }. */
export const deadlineIn = (ms) => ({ at: Date.now() + ms });
const budget = (deadline) => (deadline ? Math.min(perRequestMs(), deadline.at - Date.now()) : perRequestMs());

function bounded(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { onTimeout?.(); reject(timeoutError(ms)); }, Math.max(0, ms));
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** fetch with a deadline and no redirects. Same arguments as fetch. */
export async function providerFetch(url, init = {}, { deadline } = {}) {
  const ms = budget(deadline);
  if (ms <= 0) throw timeoutError(0);
  const controller = new AbortController();
  return bounded(globalThis.fetch(url, { ...init, redirect: "error", signal: controller.signal }), ms, () => controller.abort());
}

/** Body reads are bounded too: a stalled stream is a timeout, not a hang. */
export const readJson = (res, { deadline } = {}) => bounded(res.json(), budget(deadline));
export const readText = (res, { deadline } = {}) => bounded(res.text(), budget(deadline));

/**
 * A URL a provider returned must be that provider's own https origin (exact
 * host, default port, no credentials) and expected path, else no key is sent.
 */
export function assertProviderUrl(raw, { host, pathPrefix = "/" }) {
  let u;
  try { u = new URL(raw); } catch { u = null; }
  if (!u || u.protocol !== "https:" || u.hostname !== host || u.port !== "" || u.username || u.password || !u.pathname.startsWith(pathPrefix)) {
    const e = new Error(`provider returned an unexpected URL (expected https://${host}${pathPrefix}…); no credentials were sent`);
    e.code = "UNSAFE_PROVIDER_URL";
    throw e;
  }
  return u.toString();
}
