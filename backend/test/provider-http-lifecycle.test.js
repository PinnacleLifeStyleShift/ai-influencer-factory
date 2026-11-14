import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * Portfolio review of 14 November 2026, AI Influencer Factory chapter, P2
 * "provider body timeouts do not fully cancel work". A real local HTTP server
 * (no external network) sends headers at once and then misbehaves in the body.
 * The caller must time out AND the body read must actually stop (the server
 * sees its socket closed); bodies beyond the byte limit stop before being
 * materialised; ordinary fragmented JSON still parses.
 */
let server; let base; const closed = new Map(); const sentBytes = new Map();
before(async () => {
  server = http.createServer((req, res) => {
    const id = req.url;
    req.socket.on("close", () => closed.set(id, true));
    if (req.url.startsWith("/stall")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{\"status\":"); // headers + a little body, then nothing
      return;
    }
    if (req.url.startsWith("/huge")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      let n = 0; const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = () => {
        while (n < 2000 && res.write(chunk)) { n++; sentBytes.set(id, n * chunk.length); }
        if (n < 2000 && !res.destroyed) res.once("drain", pump); else res.end();
      };
      res.on("close", () => sentBytes.set(id, n * chunk.length));
      return pump();
    }
    if (req.url.startsWith("/fragments")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      const parts = ['{"status":', '"COMPLETED",', '"video":{"url":', '"https://example.test/v.mp4"}}'];
      let i = 0;
      const next = () => { if (i < parts.length) { res.write(parts[i++]); setTimeout(next, 20); } else res.end(); };
      return next();
    }
    if (req.url.startsWith("/malformed")) { res.writeHead(200); return res.end("{not json"); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); delete process.env.PROVIDER_REQUEST_TIMEOUT_MS; delete process.env.PROVIDER_MAX_RESPONSE_BYTES; });

const waitFor = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

test("a body that stalls after the headers times out and the underlying read is cancelled", async () => {
  const { providerFetch, readJson } = await import("../src/services/providerHttp.js");
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = "300";
  const res = await providerFetch(`${base}/stall-1`, {});
  const t0 = Date.now();
  const err = await readJson(res).catch((e) => e);
  assert.equal(err.code, "PROVIDER_TIMEOUT");
  assert.ok(Date.now() - t0 < 2000, "bounded");
  assert.ok(await waitFor(() => closed.get("/stall-1")), "the connection was closed: no read continues in the background");
});

test("a body beyond the byte limit stops before it is fully read", async () => {
  const { providerFetch, readJson } = await import("../src/services/providerHttp.js");
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = "10000";
  process.env.PROVIDER_MAX_RESPONSE_BYTES = String(256 * 1024);
  const res = await providerFetch(`${base}/huge-1`, {});
  const err = await readJson(res).catch((e) => e);
  assert.equal(err.code, "PROVIDER_RESPONSE_TOO_LARGE");
  assert.ok(await waitFor(() => closed.get("/huge-1")), "the connection was closed");
  assert.ok((sentBytes.get("/huge-1") || 0) < 2000 * 64 * 1024, "the server never finished sending ~128 MB");
  delete process.env.PROVIDER_MAX_RESPONSE_BYTES;
});

test("ordinary JSON sent in small fragments still parses; malformed JSON is an error, not a hang", async () => {
  const { providerFetch, readJson } = await import("../src/services/providerHttp.js");
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = "5000";
  const ok = await readJson(await providerFetch(`${base}/fragments`, {}));
  assert.equal(ok.video.url, "https://example.test/v.mp4");
  const bad = await readJson(await providerFetch(`${base}/malformed`, {})).catch((e) => e);
  assert.ok(bad instanceof Error);
  assert.notEqual(bad.code, "PROVIDER_TIMEOUT");
});

test("a request the caller abandons is cancelled too (caller signal)", async () => {
  const { providerFetch, readJson } = await import("../src/services/providerHttp.js");
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = "10000";
  const caller = new AbortController();
  const res = await providerFetch(`${base}/stall-2`, {}, { signal: caller.signal });
  const pending = readJson(res).catch((e) => e);
  caller.abort();
  const err = await pending;
  assert.ok(err instanceof Error);
  assert.ok(await waitFor(() => closed.get("/stall-2")), "the connection was closed on cancellation");
});

// Every adapter that uses the helper, not only one JSON call: each provider's
// first request is redirected to the stalling local server (synthetic keys).
test("every image and video adapter times out on a stalled body and closes the connection", async () => {
  const { imageAdapters } = await import("../src/services/imageGeneration.js");
  const { videoAdapters } = await import("../src/services/videoGeneration.js");
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = "300";
  Object.assign(process.env, { HIGGSFIELD_API_KEY: "synthetic", HIGGSFIELD_SECRET: "synthetic", LEONARDO_API_KEY: "synthetic", FAL_KEY: "synthetic", KLING_ACCESS_KEY: "synthetic", KLING_SECRET_KEY: "synthetic" });
  const realFetch = globalThis.fetch;
  try {
    const cases = [
      ["higgsfield:soul", () => imageAdapters["higgsfield:soul"].generate({ prompt: "x", options: {} }, {})],
      ["leonardo:phoenix", () => imageAdapters["leonardo:phoenix"].generate({ prompt: "x", options: {} }, {})],
      ["fal:kling-v2.1-i2v", () => videoAdapters["fal:kling-v2.1-i2v"].generate({ imageUrl: "https://example.test/a.png", prompt: "x", options: {} }, {})],
      ["kling:kling-v2-1", () => videoAdapters["kling:kling-v2-1"].generate({ imageUrl: "https://example.test/a.png", prompt: "x", options: {} }, {})],
    ];
    for (const [name, run] of cases) {
      const path = `/stall-adapter-${name.replace(/[^a-z0-9]/gi, "-")}`;
      globalThis.fetch = (_url, init) => realFetch(`${base}${path}`, init);
      const t0 = Date.now();
      const err = await run().catch((e) => e);
      assert.ok(err instanceof Error, `${name}: fails rather than hangs`);
      assert.ok(Date.now() - t0 < 3000, `${name}: bounded (${Date.now() - t0} ms)`);
      assert.notEqual(err.submitted, false, `${name}: a timeout after sending is not "never sent"`);
      assert.ok(await waitFor(() => closed.get(path)), `${name}: connection closed`);
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["HIGGSFIELD_API_KEY", "HIGGSFIELD_SECRET", "LEONARDO_API_KEY", "FAL_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY"]) delete process.env[k];
  }
});
