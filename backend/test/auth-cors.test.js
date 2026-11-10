import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch, fakePrisma } from "./helpers.js";

let net;
before(() => { net = interceptExternalFetch(); });
after(() => { net.restore(); assert.equal(net.calls.length, 0, "no external network calls"); });

test("health endpoints stay public", async () => {
  const app = await startApp({ env: {} });
  try {
    assert.equal((await app.call("/health")).status, 200);
    assert.equal((await app.call("/")).status, 200);
  } finally { await app.close(); }
});

test("fails closed when OWNER_API_TOKEN is not configured", async () => {
  const prisma = fakePrisma();
  const app = await startApp({ env: {}, prisma });
  try {
    const res = await app.call("/api/characters", { token: TOKEN });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "AUTH_NOT_CONFIGURED");
    assert.deepEqual(prisma.calls, []);
  } finally { await app.close(); }
});

test("rejects a too-short configured token as not configured", async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: "short" } });
  try {
    const res = await app.call("/api/characters", { token: "short" });
    assert.equal(res.status, 503);
  } finally { await app.close(); }
});

test("requires the bearer token on reads, writes and generation", async () => {
  const prisma = fakePrisma({ characters: [{ id: "c1", name: "Synthetic Test Character" }] });
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma });
  try {
    const cases = [
      ["/api/characters", "GET"],
      ["/api/dashboard", "GET"],
      ["/api/characters", "POST"],
      ["/api/content/x", "PUT"],
      ["/api/characters/c1", "DELETE"],
      ["/api/characters/c1/generate-image", "POST"],
      ["/api/characters/c1/generate-video", "POST"],
      ["/api/pipeline/generate-content", "POST"],
      ["/api/pipeline/discover-trends", "POST"],
      ["/api/system/generation-policy", "GET"],
    ];
    for (const [path, method] of cases) {
      const body = method === "GET" || method === "DELETE" ? undefined : {};
      const missing = await app.call(path, { method, body });
      assert.equal(missing.status, 401, `${method} ${path} without token`);
      assert.equal((await missing.json()).code, "AUTH_REQUIRED");
      const wrong = await app.call(path, { method, body, token: TOKEN + "x" });
      assert.equal(wrong.status, 401, `${method} ${path} with wrong token`);
    }
    assert.deepEqual(prisma.calls, [], "no database access before authentication");

    const ok = await app.call("/api/characters", { token: TOKEN });
    assert.equal(ok.status, 200);
  } finally { await app.close(); }
});

test("CORS has no wildcard default", async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN } });
  try {
    const res = await app.call("/health", { headers: { Origin: "https://evil.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally { await app.close(); }
});

test("CORS allows only listed origins and ignores '*'", async () => {
  const app = await startApp({
    env: { OWNER_API_TOKEN: TOKEN, FRONTEND_URL: "https://app.example.test/, *" },
  });
  try {
    const good = await app.call("/health", { headers: { Origin: "https://app.example.test" } });
    assert.equal(good.headers.get("access-control-allow-origin"), "https://app.example.test");
    const bad = await app.call("/health", { headers: { Origin: "https://evil.example" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  } finally { await app.close(); }
});

test("CORS preflight allows the Idempotency-Key header for listed origins only", async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, FRONTEND_URL: "https://app.example.test" } });
  try {
    const pre = await app.call("/api/pipeline/generate-content", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
      },
    });
    assert.ok(pre.status === 204 || pre.status === 200);
    assert.match(pre.headers.get("access-control-allow-headers") || "", /Idempotency-Key/i);
    assert.match(pre.headers.get("access-control-allow-methods") || "", /PATCH/);
    const evil = await app.call("/api/pipeline/generate-content", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  } finally { await app.close(); }
});

test("route variants are not distinct routes, and CORS is not an identity control", async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, FRONTEND_URL: "https://app.example.test" } });
  try {
    // Without a session every variant is refused; a mixed-case mount is no route at all.
    for (const p of ["/api/characters/x/generate-image", "/api/characters/x/generate-image/", "/api/characters/x/GENERATE-IMAGE"]) {
      assert.equal((await app.raw(p, { method: "POST", body: {} })).status, 401, p);
    }
    assert.equal((await app.raw("/API/characters/x/generate-image", { method: "POST", body: {} })).status, 404);
    assert.equal((await app.raw("/api//characters", { body: undefined })).status, 404, "repeated separator refused");
    // An allowed origin gets CORS headers but no identity: still 401 without a session.
    const r = await app.raw("/api/characters", { headers: { Origin: "https://app.example.test" } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://app.example.test");
  } finally { await app.close(); }
});
