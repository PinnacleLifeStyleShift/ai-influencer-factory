/**
 * Browser playback of reviewed media (spec of 11 November 2026, AC-IF09-02).
 *
 * Two checks. (1) A synthetic 5 s VP9/WebM clip is served for an item's video.
 * (2) An actual H.264 file made by the app's own assembly (ffmpeg, from the
 * synthetic MP4 clips) plays end to end; its browser duration matches the
 * server's measurement (inspectMedia) within 0.1 s. The Pipeline screen plays it; the duration the
 * browser reports is checked against the length measured by ffprobe when the
 * fixture was made (5.0 s), independently of anything the app recorded. The
 * player is reachable by keyboard and plays and pauses.
 * Synthetic data, local servers only, every other request blocked.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // preinstalled, not a project dependency

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPrismaClient } = await import(path.join(root, "backend/src/lib/prisma.js"));
const { assemble, assemblyCapability } = await import(path.join(root, "backend/src/services/mediaAssembly.js"));
const { inspectMedia } = await import(path.join(root, "backend/src/services/mediaInspect.js"));
const MEDIA = path.join(root, "backend/test/fixtures/media");
const CLIP = fs.readFileSync(path.join(root, "backend/test/fixtures/media/clip-5s.webm"));
const MEASURED_SEC = 5.0; // ffprobe of the fixture
const TOKEN = "e2e-owner-token-0123456789abcdefghijklmnop"; // synthetic
const API_PORT = 4400 + Math.floor(Math.random() * 300);
const WEB_PORT = 5400 + Math.floor(Math.random() * 300);
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");

const procs = [];
const start = (cmd, args, cwd, env) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stdout.on("data", () => {}); p.stderr.on("data", () => {});
  procs.push(p);
};
async function waitFor(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).status < 500) return; } catch { /* not up */ } await sleep(200); }
  throw new Error(`timeout ${url}`);
}

let exitCode = 0;
const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);
try {
  start("node", ["src/server.js"], path.join(root, "backend"), { PORT: String(API_PORT), DATABASE_URL: process.env.TEST_DATABASE_URL, OWNER_API_TOKEN: TOKEN, FRONTEND_URL: WEB });
  start("npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], root, { VITE_API_URL: API });
  await waitFor(`${API}/health`);
  await waitFor(WEB);

  const character = await prisma.character.create({ data: { characterId: "INFL-PLAY", name: "Ivy Playback", status: "active" } });
  await prisma.pipelineItem.create({ data: {
    stage: "review", characterId: character.id, disclosure: "This is a fictional, AI-generated character.", platform: "Instagram",
    caption: "Synthetic playback check", videoUrl: "https://example.test/clip-5s.webm",
  } });

  // The real assembled output: H.264 from the app's assembly, measured as the server measures it.
  const cap = assemblyCapability({ MEDIA_ASSEMBLY: "ffmpeg" });
  if (!cap.available) throw new Error(`assembly unavailable for the H.264 check: ${cap.reason}`);
  const rendered = await assemble([
    { bytes: fs.readFileSync(path.join(MEDIA, "clip-5s.mp4")), trimSec: 5 },
    { bytes: fs.readFileSync(path.join(MEDIA, "clip-10s.mp4")), trimSec: 4 },
  ], { aspectRatio: "9:16", tool: cap.tool });
  const server = inspectMedia(rendered.bytes, { expectedKind: "video" });
  if (!server.ok) throw new Error(`assembled file failed inspection: ${server.problems.join("; ")}`);
  const renderedCharacter = await prisma.character.create({ data: { characterId: "INFL-RENDER", name: "Rex Rendered", status: "active" } });
  await prisma.pipelineItem.create({ data: {
    stage: "review", characterId: renderedCharacter.id, disclosure: "This is a fictional, AI-generated character.", platform: "Instagram",
    caption: "Synthetic assembled playback check", videoUrl: "https://example.test/rendered-check.mp4",
  } });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.href === "https://example.test/clip-5s.webm") return route.fulfill({ status: 200, contentType: "video/webm", body: CLIP });
    if (u.href === "https://example.test/rendered-check.mp4") return route.fulfill({ status: 200, contentType: "video/mp4", body: rendered.bytes });
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });

  await page.goto(WEB);
  await page.getByRole("button", { name: "Pipeline" }).first().click();
  await page.locator("div.cursor-pointer").filter({ hasText: "Ivy Playback" }).first().click();
  const video = page.locator('video[src="https://example.test/clip-5s.webm"]').first();
  await video.waitFor();
  const duration = await video.evaluate((v) => new Promise((resolve, reject) => {
    if (v.readyState >= 1) return resolve(v.duration);
    v.addEventListener("loadedmetadata", () => resolve(v.duration), { once: true });
    v.addEventListener("error", () => reject(new Error(`media error ${v.error?.code}`)), { once: true });
  }));
  assert.ok(Math.abs(duration - MEASURED_SEC) <= 0.1, `browser duration ${duration}s vs measured ${MEASURED_SEC}s`);

  // Keyboard: the player takes focus and has native controls; play advances time, pause stops it.
  await video.focus();
  assert.equal(await video.evaluate((v) => document.activeElement === v && v.controls), true, "player is focusable with controls");
  const played = await video.evaluate(async (v) => {
    v.muted = true; await v.play();
    await new Promise((r) => setTimeout(r, 800));
    v.pause();
    return { t: v.currentTime, paused: v.paused };
  });
  assert.ok(played.t > 0.3 && played.paused, `played ${played.t}s then paused`);

  // (2) The assembled H.264 file, end to end.
  await page.locator("div.cursor-pointer").filter({ hasText: "Rex Rendered" }).first().click();
  const h264 = page.locator('video[src="https://example.test/rendered-check.mp4"]').first();
  await h264.waitFor();
  const full = await h264.evaluate((v) => new Promise((resolve, reject) => {
    v.addEventListener("error", () => reject(new Error(`media error ${v.error?.code}`)), { once: true });
    const go = async () => {
      v.muted = true; v.playbackRate = 8;
      v.addEventListener("ended", () => resolve({ duration: v.duration, endedAt: v.currentTime, w: v.videoWidth, h: v.videoHeight }), { once: true });
      await v.play();
    };
    if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
  }));
  assert.ok(Math.abs(full.duration - server.durationSec) <= 0.1, `H.264: browser ${full.duration}s vs server ${server.durationSec}s`);
  assert.ok(full.endedAt >= server.durationSec - 0.1, `played to the end (${full.endedAt}s)`);
  assert.deepEqual([full.w, full.h], [server.width, server.height], "decoded frames have the measured size");

  console.log(`Media playback e2e passed (VP9: ${duration.toFixed(2)}s = ${MEASURED_SEC}s; assembled H.264 played to the end: browser ${full.duration.toFixed(2)}s = server ${server.durationSec}s, ${full.w}x${full.h}; focusable controls; play and pause)`);
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
