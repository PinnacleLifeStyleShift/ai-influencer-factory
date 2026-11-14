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

// Each response remembers the controller that can cancel its whole lifecycle.
const lifecycle = new WeakMap();
const maxBytes = () => Number(process.env.PROVIDER_MAX_RESPONSE_BYTES) || 5 * 1024 * 1024;

/**
 * fetch with a deadline and no redirects. Same arguments as fetch, plus an
 * optional caller `signal`. ONE AbortController governs the connection, the
 * headers and the body (review 14 Nov, P2): a timeout, a caller cancellation
 * or an oversized body aborts the request and closes the socket, instead of
 * only rejecting the caller while the read carries on in the background.
 */
export async function providerFetch(url, init = {}, { deadline, signal } = {}) {
  const ms = budget(deadline);
  if (ms <= 0) throw timeoutError(0);
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  const res = await bounded(globalThis.fetch(url, { ...init, redirect: "error", signal: controller.signal }), ms, () => controller.abort());
  lifecycle.set(res, { controller, deadline, signal });
  return res;
}

/**
 * Reads the body as a stream, bounded in time and size. On timeout, caller
 * cancellation or too many bytes, the read is cancelled and the request
 * aborted, so nothing keeps reading or allocating after the caller gave up.
 * A timeout here does not mean the provider did no work: callers keep the
 * reservation and the provider reference for reconciliation (never refund).
 */
async function readBody(res, { deadline } = {}) {
  const life = lifecycle.get(res) || {};
  const controller = life.controller;
  const limit = maxBytes();
  const declared = Number(res.headers?.get?.("content-length"));
  const stop = (reader) => { try { reader?.cancel().catch(() => {}); } catch { /* already closed */ } controller?.abort(); };
  if (Number.isFinite(declared) && declared > limit) { stop(null); throw tooLarge(limit); }
  if (!res.body?.getReader) return Buffer.from(await bounded(res.arrayBuffer(), budget(deadline ?? life.deadline), () => controller?.abort()));
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  const work = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) { stop(reader); throw tooLarge(limit); }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  })();
  const cancelled = life.signal ? new Promise((_, reject) => {
    const onAbort = () => { stop(reader); const e = new Error("provider request cancelled by the caller"); e.code = "PROVIDER_CANCELLED"; reject(e); };
    if (life.signal.aborted) onAbort(); else life.signal.addEventListener("abort", onAbort, { once: true });
  }) : null;
  return bounded(cancelled ? Promise.race([work, cancelled]) : work, budget(deadline ?? life.deadline), () => stop(reader));
}
function tooLarge(limit) {
  const e = new Error(`provider response is larger than ${limit} bytes; the read was stopped`);
  e.code = "PROVIDER_RESPONSE_TOO_LARGE";
  return e;
}

export const readText = async (res, opts) => (await readBody(res, opts)).toString("utf8");
export const readJson = async (res, opts) => JSON.parse(await readText(res, opts));

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
