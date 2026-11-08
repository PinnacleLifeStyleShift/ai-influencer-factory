import { describe, it, expect, vi } from "vitest";
import { createApiClient, resolveApiUrl, ApiConfigError, newIdempotencyKey } from "../api.js";

const API = "http://localhost:4000";
const jsonRes = (status, body) => ({ status, ok: status >= 200 && status < 300, statusText: String(status), json: async () => body });

function memoryStore(initial = "") {
  let v = initial;
  return { get: () => v, set: (x) => { v = x; } };
}

/** Fake server: 401 unless the expected bearer token is sent. */
function fakeFetch(expected = "owner-token") {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (init.headers.Authorization !== `Bearer ${expected}`) return jsonRes(401, { error: "Authentication required", code: "AUTH_REQUIRED" });
    return jsonRes(200, { ok: true, url });
  });
  return { fn, calls };
}

describe("API base URL", () => {
  it("never falls back to a production host", () => {
    expect(resolveApiUrl({})).toBeNull();
    expect(resolveApiUrl({ PROD: true })).toBeNull();
  });
  it("defaults to localhost only in the dev server", () => {
    expect(resolveApiUrl({ DEV: true })).toBe("http://localhost:4000");
  });
  it("accepts https or local http, rejects plain http to remote hosts", () => {
    expect(resolveApiUrl({ VITE_API_URL: "https://api.example.test/" })).toBe("https://api.example.test");
    expect(resolveApiUrl({ VITE_API_URL: "http://127.0.0.1:4000" })).toBe("http://127.0.0.1:4000");
    expect(resolveApiUrl({ VITE_API_URL: "http://api.example.test" })).toBeNull();
    expect(resolveApiUrl({ VITE_API_URL: "not a url" })).toBeNull();
  });
  it("an unconfigured client refuses to send anything (no token leaves the page)", async () => {
    const { fn } = fakeFetch();
    const prompt = vi.fn();
    const client = createApiClient({ apiUrl: null, fetchImpl: fn, tokenStore: memoryStore("secret"), promptFn: prompt });
    await expect(client.request("/api/characters")).rejects.toBeInstanceOf(ApiConfigError);
    expect(fn).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("authentication prompt", () => {
  it("concurrent 401s share a single prompt and all retry with the new token", async () => {
    const { fn, calls } = fakeFetch("owner-token");
    let resolvePrompt;
    const prompt = vi.fn(() => new Promise((r) => { resolvePrompt = r; }));
    const store = memoryStore("");
    const client = createApiClient({ apiUrl: API, fetchImpl: fn, tokenStore: store, promptFn: prompt });

    const pending = Promise.all([1, 2, 3, 4, 5].map((i) => client.request(`/api/x/${i}`)));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    resolvePrompt("  owner-token  ");
    const results = await pending;

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toContain(API); // operator sees where the token goes
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.get()).toBe("owner-token");
    const retried = calls.filter((c) => c.headers.Authorization === "Bearer owner-token");
    expect(retried).toHaveLength(5);
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true);
  });

  it("a cancelled prompt surfaces the 401 without retrying", async () => {
    const { fn } = fakeFetch();
    const client = createApiClient({ apiUrl: API, fetchImpl: fn, tokenStore: memoryStore(""), promptFn: () => null });
    await expect(client.request("/api/x")).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a wrong token prompts once more, then gives up", async () => {
    const { fn } = fakeFetch("owner-token");
    const prompt = vi.fn(() => "still-wrong");
    const client = createApiClient({ apiUrl: API, fetchImpl: fn, tokenStore: memoryStore("stale"), promptFn: prompt });
    await expect(client.request("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("idempotency keys", () => {
  it("sends the Idempotency-Key header and keeps it on the auth retry", async () => {
    const { fn, calls } = fakeFetch("owner-token");
    const client = createApiClient({ apiUrl: API, fetchImpl: fn, tokenStore: memoryStore(""), promptFn: () => "owner-token" });
    const key = newIdempotencyKey();
    await client.request("/api/pipeline/generate-content", { method: "POST", body: "{}", idempotencyKey: key });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.headers["Idempotency-Key"] === key)).toBe(true);
  });
  it("generated keys match the server's accepted format and are unique", () => {
    const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });
});
