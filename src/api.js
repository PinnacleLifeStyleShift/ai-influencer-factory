const API_URL = import.meta.env.VITE_API_URL || "https://api-production-5a00.up.railway.app";

// Owner API token: entered by the operator at runtime and kept only in this
// browser tab's sessionStorage. It is never baked into the frontend bundle.
const TOKEN_KEY = "aif.ownerToken";

function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function setToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

export function signOut() {
  setToken("");
}

async function request(path, options = {}, retried = false) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401 && !retried && typeof window !== "undefined") {
    setToken("");
    const entered = window.prompt("Enter the owner API token for this workspace:");
    if (entered) {
      setToken(entered.trim());
      return request(path, options, true);
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || `API error ${res.status}`);
    e.code = err.code;
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// ─── Characters ───────────────────────────────────────────
export const characters = {
  list: () => request("/api/characters"),
  get: (id) => request(`/api/characters/${id}`),
  create: (data) => request("/api/characters", { method: "POST", body: JSON.stringify(data) }),
  update: (id, data) => request(`/api/characters/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id) => request(`/api/characters/${id}`, { method: "DELETE" }),
  generateImage: (id) => request(`/api/characters/${id}/generate-image`, { method: "POST" }),
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
  generateContent: (data) =>
    request("/api/pipeline/generate-content", { method: "POST", body: JSON.stringify(data) }),
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
