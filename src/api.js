/**
 * API client.
 *
 * - The API base URL must be configured (VITE_API_URL). In a production build
 *   there is NO fallback: an unset URL fails before any request, so a token
 *   can never be sent to a server the operator did not configure. Local dev
 *   (vite dev server) defaults to http://localhost:4000.
 * - The owner token is typed in at runtime and immediately exchanged for a
 *   revocable, expiring session (POST /api/auth/session). Only the session
 *   token is kept, in this tab's sessionStorage; the owner token is never
 *   stored and never part of the bundle. Concurrent 401 responses share ONE
 *   prompt.
 * - Paid generation calls carry an Idempotency-Key so retries cannot double-buy.
 */
export class ApiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiConfigError";
    this.code = "API_URL_NOT_CONFIGURED";
  }
}

export function resolveApiUrl(env = {}) {
  const raw = (env.VITE_API_URL || "").trim().replace(/\/+$/, "");
  if (raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    const local = ["localhost", "127.0.0.1"].includes(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  }
  return env.DEV ? "http://localhost:4000" : null;
}

const TOKEN_KEY = "aif.session";

function sessionTokenStore() {
  return {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
    set(v) {
      try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* unavailable */ }
    },
  };
}

export function newIdempotencyKey() {
  const rand = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `ui-${rand}`;
}

export function createApiClient({
  apiUrl,
  fetchImpl = (...a) => globalThis.fetch(...a),
  tokenStore = sessionTokenStore(),
  promptFn = (msg) => (typeof window !== "undefined" ? window.prompt(msg) : null),
} = {}) {
  let pendingPrompt = null;

  /** Exchanges the owner credential for a session token; "" on failure. */
  async function exchange(credential) {
    const res = await fetchImpl(`${apiUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
    });
    if (res.status !== 201) return "";
    const body = await res.json().catch(() => ({}));
    return typeof body.sessionToken === "string" ? body.sessionToken : "";
  }

  /** Returns a usable session after a 401, prompting at most once for concurrent callers. */
  function obtainToken(rejectedToken) {
    const current = tokenStore.get();
    if (current && current !== rejectedToken) return Promise.resolve(current); // already refreshed
    if (!pendingPrompt) {
      tokenStore.set("");
      pendingPrompt = Promise.resolve()
        .then(() => promptFn(`Enter the owner API token for ${apiUrl}:`))
        .then(async (v) => {
          const credential = (v || "").trim();
          const session = credential ? await exchange(credential) : "";
          if (session) tokenStore.set(session);
          return session;
        })
        .finally(() => { pendingPrompt = null; });
    }
    return pendingPrompt;
  }

  /** Signs out on the server (revokes the session), then forgets it locally. */
  async function signOut() {
    const token = tokenStore.get();
    tokenStore.set("");
    if (token && apiUrl) {
      await fetchImpl(`${apiUrl}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
  }

  async function request(path, options = {}, retried = false) {
    if (!apiUrl) {
      throw new ApiConfigError("VITE_API_URL is not configured for this build; refusing to send requests");
    }
    const { idempotencyKey, ...init } = options;
    const token = tokenStore.get();
    const res = await fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...init.headers,
      },
    });
    if (res.status === 401 && !retried) {
      const next = await obtainToken(token);
      if (next) return request(path, options, true);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || `API error ${res.status}`);
      e.code = err.code;
      e.status = res.status;
      e.details = err.details;
      throw e;
    }
    return res.json();
  }

  return { request, signOut, apiUrl };
}

const client = createApiClient({ apiUrl: resolveApiUrl(import.meta.env) });
const request = client.request;
export const signOut = client.signOut;

// ─── Characters ───────────────────────────────────────────
export const characters = {
  list: () => request("/api/characters"),
  get: (id) => request(`/api/characters/${id}`),
  create: (data) => request("/api/characters", { method: "POST", body: JSON.stringify(data) }),
  update: (id, data) => request(`/api/characters/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id) => request(`/api/characters/${id}`, { method: "DELETE" }),
  generateImage: (id, { idempotencyKey } = {}) =>
    request(`/api/characters/${id}/generate-image`, { method: "POST", idempotencyKey }),
  images: (id) => request(`/api/characters/${id}/images`),
  addImage: (id, imageUrl) => request(`/api/characters/${id}/images`, { method: "POST", body: JSON.stringify({ imageUrl }) }),
  versions: (id) => request(`/api/characters/${id}/versions`),
  publishVersion: (id, data = {}) => request(`/api/characters/${id}/versions`, { method: "POST", body: JSON.stringify(data) }),
  restoreVersion: (id, n) => request(`/api/characters/${id}/versions/${n}/restore`, { method: "POST", body: "{}" }),
  setReferenceImage: (id, data) =>
    request(`/api/characters/${id}/reference-image`, { method: "POST", body: JSON.stringify(data) }),
};

// ─── Character image rights ─────────────────────────────
export const characterImages = {
  rights: (imageId) => request(`/api/character-images/${imageId}/rights`),
  recordRights: (imageId, data) => request(`/api/character-images/${imageId}/rights`, { method: "POST", body: JSON.stringify(data) }),
  approveRights: (imageId, recordId) => request(`/api/character-images/${imageId}/rights/approve`, { method: "POST", body: JSON.stringify({ recordId }) }),
};

// ─── Content ──────────────────────────────────────────────
export const content = {
  list: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/content${qs ? `?${qs}` : ""}`);
  },
  get: (id) => request(`/api/content/${id}`),
  create: (data) => request("/api/content", { method: "POST", body: JSON.stringify(data) }),
  update: (id, data) => request(`/api/content/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id) => request(`/api/content/${id}`, { method: "DELETE" }),
};

// ─── Campaigns ────────────────────────────────────────────
export const campaigns = {
  list: () => request("/api/campaigns"),
  get: (id) => request(`/api/campaigns/${id}`),
  create: (data) => request("/api/campaigns", { method: "POST", body: JSON.stringify(data) }),
  update: (id, data) => request(`/api/campaigns/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id) => request(`/api/campaigns/${id}`, { method: "DELETE" }),
  submit: (campaignId, data) =>
    request(`/api/campaigns/${campaignId}/submissions`, { method: "POST", body: JSON.stringify(data) }),
};

// ─── Dashboard ────────────────────────────────────────────
export const dashboard = {
  get: () => request("/api/dashboard"),
};

// ─── Pipeline ────────────────────────────────────────────
export const pipeline = {
  list: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/pipeline${qs ? `?${qs}` : ""}`);
  },
  get: (id) => request(`/api/pipeline/${id}`),
  discoverTrends: (data) => request("/api/pipeline/discover-trends", { method: "POST", body: JSON.stringify(data) }),
  listTrends: () => request("/api/pipeline/trends"),
  generateScript: (data) => request("/api/pipeline/generate-script", { method: "POST", body: JSON.stringify(data) }),
  listScripts: () => request("/api/pipeline/scripts"),
  generateContent: (data, { idempotencyKey } = {}) =>
    request("/api/pipeline/generate-content", { method: "POST", body: JSON.stringify(data), idempotencyKey }),
  update: (id, data) => request(`/api/pipeline/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  generateCaption: (data) =>
    request("/api/pipeline/generate-caption", { method: "POST", body: JSON.stringify(data) }),
  approve: (id, data = {}) =>
    request(`/api/pipeline/${id}/approve`, { method: "POST", body: JSON.stringify(data) }),
  reject: (id, data = {}) =>
    request(`/api/pipeline/${id}/reject`, { method: "POST", body: JSON.stringify(data) }),
  schedule: (id, data) =>
    request(`/api/pipeline/${id}/schedule`, { method: "POST", body: JSON.stringify(data) }),
  delete: (id) => request(`/api/pipeline/${id}`, { method: "DELETE" }),
};
