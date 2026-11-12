import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createMemoryLedger } from "../src/services/spendLedger.js";
import { costSummary } from "../src/services/assetLineage.js";
import { inspectMedia } from "../src/services/mediaInspect.js";

/**
 * Six-project code review of 12 November 2026, AI Influencer Factory chapter
 * (reviewed at 30f05a4). Each test reproduces one finding and failed on that
 * commit before its fix. Synthetic data only; no network.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const CAPS = { perJobMicros: 1_000_000, dailyMicros: 100_000_000, monthlyMicros: 100_000_000, timezone: "UTC" };
const entry = (amountMicros, key) => ({ provider: "mock", model: "m", amountMicros, idempotencyKey: key, requestHash: "h", currency: "USD", priceVersion: "v1" });

// ─── IF-R1: the per-job cap applies to the whole workflow ────────────────

test("IF-R1: two $0.75 steps exceed a $1.00 per-job cap even though each step fits", async () => {
  const ledger = createMemoryLedger();
  await assert.rejects(ledger.reserveGroup([entry(750_000, "a1"), entry(750_000, "a2")], CAPS), (e) => e.code === "BUDGET_EXCEEDED" && /per-job/.test(e.message));
  assert.equal((await ledger.totals()).dayMicros, 0, "nothing reserved");
  const ok = await ledger.reserveGroup([entry(400_000, "b1"), entry(600_000, "b2")], CAPS);
  assert.equal(ok.length, 2, "exactly at the cap is allowed");
});

test("IF-R1: a partial replay counts the whole workflow against the cap", async () => {
  const ledger = createMemoryLedger();
  const [first] = await ledger.reserveGroup([entry(750_000, "c1")], CAPS);
  await ledger.settle(first.reservationId, 750_000, { imageUrl: "x" });
  // The same workflow again with a second step: the settled step is replayed, but the job total is 1.50.
  await assert.rejects(ledger.reserveGroup([entry(750_000, "c1"), entry(750_000, "c2")], CAPS), (e) => e.code === "BUDGET_EXCEEDED");
});

// ─── IF-R2: an estimate never becomes a "known actual" cost ──────────────

test("IF-R2: settling without a reported charge keeps the actual unknown, while the estimate still counts against the budget", async () => {
  const ledger = createMemoryLedger();
  const [r] = await ledger.reserveGroup([entry(500_000, "d1")], CAPS);
  await ledger.settle(r.reservationId, null, { imageUrl: "x" });
  const row = await ledger.get(r.reservationId);
  assert.equal(row.state, "settled");
  assert.equal(row.actualMicros, null, "no invoice-verified amount was reported");
  assert.equal((await ledger.totals()).dayMicros, 500_000, "budget still consumed by the estimate");
  const cost = costSummary([row]);
  assert.deepEqual([cost.actualKnownMicros, cost.unknownActual], [0, 1], "not counted as a known actual");

  const [z] = await ledger.reserveGroup([entry(500_000, "d2")], CAPS);
  await ledger.settle(z.reservationId, 0, null);
  assert.equal((await ledger.get(z.reservationId)).actualMicros, 0, "a confirmed zero stays a known zero");
});

// ─── IF-R3: structurally invalid images are refused ──────────────────────

const chunk = (type, data = Buffer.alloc(0), { badCrc = false } = {}) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(badCrc ? 0xdeadbeef : zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w = 100, h = 100) => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = 2; return d; };
const idat = () => zlib.deflateSync(Buffer.alloc(101 * 3 * 1 + 1));

test("IF-R3: PNGs without image data, with bad checksums, truncated, or absurdly large are refused; a valid one passes", () => {
  const reviewCase = Buffer.concat([SIG, chunk("IHDR", ihdr(), { badCrc: true }), chunk("IEND", Buffer.alloc(0), { badCrc: true })]);
  assert.equal(reviewCase.length, 45, "the review's 45-byte file");
  assert.equal(inspectMedia(reviewCase).ok, false, "no IDAT and invalid checksums");
  assert.equal(inspectMedia(Buffer.concat([SIG, chunk("IHDR", ihdr()), chunk("IEND")])).ok, false, "absent IDAT");
  assert.equal(inspectMedia(Buffer.concat([SIG, chunk("IHDR", ihdr()), chunk("IDAT"), chunk("IEND")])).ok, false, "empty IDAT");
  assert.equal(inspectMedia(Buffer.concat([SIG, chunk("IHDR", ihdr()), chunk("IDAT", idat(), { badCrc: true }), chunk("IEND")])).ok, false, "invalid CRC");
  const valid = Buffer.concat([SIG, chunk("IHDR", ihdr(1, 1)), chunk("IDAT", zlib.deflateSync(Buffer.alloc(4))), chunk("IEND")]);
  const good = inspectMedia(valid);
  assert.equal(good.ok, true, JSON.stringify(good.problems));
  assert.equal(inspectMedia(valid.subarray(0, valid.length - 6)).ok, false, "truncated");
  assert.equal(inspectMedia(Buffer.concat([SIG, chunk("IHDR", ihdr(100_000, 100_000)), chunk("IDAT", idat()), chunk("IEND")])).ok, false, "pixel limit");
  assert.equal(inspectMedia(fs.readFileSync(path.join(FIXTURES, "still.png"))).ok, true, "the real fixture still passes");
});

test("IF-R3: a JPEG with no scan data, a truncated JPEG and a malformed MP4 box are refused", () => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  const noScan = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  assert.equal(inspectMedia(noScan).ok, false, "frame header but no scan");
  const scan = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]), Buffer.alloc(32, 0x55)]);
  assert.equal(inspectMedia(Buffer.concat([Buffer.from([0xff, 0xd8]), sof, scan])).ok, false, "truncated (no end marker)");
  const mp4 = fs.readFileSync(path.join(FIXTURES, "clip-5s.mp4"));
  const bad = Buffer.from(mp4); bad.writeUInt32BE(0xffffff00, 0); // first box claims far more than the file
  assert.equal(inspectMedia(bad, { expectedKind: "video" }).ok, false);
});

// ─── IF-R6 / IF-R7: provider adapters (credentials and deadlines) ───────

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; delete process.env.FAL_KEY; delete process.env.PROVIDER_REQUEST_TIMEOUT_MS; });

test("IF-R6: the fal adapter never sends its key to a host the provider response names, other than fal's own queue", async () => {
  const { videoAdapters } = await import("../src/services/videoGeneration.js");
  process.env.FAL_KEY = "synthetic-fal-key";
  for (const bad of ["https://evil.example/steal", "https://127.0.0.1/status", "https://queue.fal.run:8443/x", "http://queue.fal.run/fal-ai/kling-video/requests/1/status", "https://user:pw@queue.fal.run/fal-ai/kling-video/requests/1/status"]) {
    const sent = [];
    globalThis.fetch = async (url, init = {}) => {
      sent.push({ url: String(url), auth: init.headers?.Authorization, redirect: init.redirect });
      if (sent.length === 1) return new Response(JSON.stringify({ request_id: "r1", status_url: bad, response_url: bad }), { status: 200 });
      return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
    };
    const err = await videoAdapters["fal:kling-v2.1-i2v"].generate({ imageUrl: "https://example.test/a.png", prompt: "x", options: {} }, { onAccepted: async () => {} }).catch((e) => e);
    assert.ok(err instanceof Error, `${bad}: refused`);
    assert.equal(sent.length, 1, `${bad}: only the submit call was made; the key went nowhere else`);
    assert.equal(sent[0].redirect, "error", "credentialed calls never follow redirects");
    assert.notEqual(err.submitted, false, "already accepted: the outcome is unknown, not 'never sent'");
  }
});

test("IF-R7: a provider request that never answers, or a body that stalls, is cut off by a deadline", async () => {
  const { providerFetch, readJson } = await import("../src/services/providerHttp.js");
  process.env.PROVIDER_REQUEST_TIMEOUT_MS = "200";
  globalThis.fetch = () => new Promise(() => {}); // never resolves, ignores the signal
  const t0 = Date.now();
  const hung = await providerFetch("https://queue.fal.run/x", {}).catch((e) => e);
  assert.equal(hung.code, "PROVIDER_TIMEOUT");
  assert.ok(Date.now() - t0 < 2000, "bounded");

  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 200 }); // body never ends
  const res = await providerFetch("https://queue.fal.run/x", {});
  const stalled = await readJson(res).catch((e) => e);
  assert.equal(stalled.code, "PROVIDER_TIMEOUT");

  const deadline = { at: Date.now() - 1 }; // overall budget already spent
  const late = await providerFetch("https://queue.fal.run/x", {}, { deadline }).catch((e) => e);
  assert.equal(late.code, "PROVIDER_TIMEOUT");
});
