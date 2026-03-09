const API_URL = import.meta.env.VITE_API_URL || "https://api-production-5a00.up.railway.app";

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
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
