/**
 * Publishing browser check (brief section 10) in SIMULATION mode: no real
 * publisher exists, off-machine requests are blocked, and simulated results
 * must never be shown or stored as published.
 *
 * Covers: per-destination publisher status, "Publish now" blocked until the
 * approved time, a simulated run to two destinations (one original), honest
 * labels, the calendar entry still only "scheduled", and reload.
 * Writes docs/screenshots/pkg-f-publishing.png.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // preinstalled, not a project dependency

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(root, "backend/test/fixtures/media");
const { createPrismaClient } = await import(path.join(root, "backend/src/lib/prisma.js"));
const { localOf } = await import(path.join(root, "backend/src/lib/zonedTime.js"));
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
  start("node", ["src/server.js"], path.join(root, "backend"), {
    PORT: String(API_PORT), DATABASE_URL: process.env.TEST_DATABASE_URL, OWNER_API_TOKEN: TOKEN, FRONTEND_URL: WEB,
    MEDIA_STORE: "synthetic-fixture", MEDIA_FIXTURE_DIR: FIXTURES, PUBLISHING_SIMULATION: "enabled",
  });
  start("npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], root, { VITE_API_URL: API });
  await waitFor(`${API}/health`);
  await waitFor(WEB);

  const session = (await (await fetch(`${API}/api/auth/session`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).json()).sessionToken;
  const api = (p, body, method = "POST") => fetch(`${API}${p}`, {
    method, headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  const c = await api("/api/characters", { name: "Nova Vale", character_type: "Human", niche: "Lifestyle", persona: "Fictional adult morning-routine coach (synthetic test persona)." });
  const { pipelineItem: item } = await api("/api/pipeline/generate-script", { characterId: c.id, duration: "30s" });
  const p1 = await api(`/api/pipeline/${item.id}/package`, null, "GET");
  await api(`/api/pipeline/scripts/${p1.script.id}`, {
    expectedVersion: p1.script.version, hook: "Three small habits for a calmer morning.",
    body: "Open the curtains as soon as you wake. Drink a glass of water before coffee. Stretch for two minutes beside the bed.",
    callToAction: "Follow for more calm routines.",
  }, "PUT");
  // Approved time a minute boundary ~70 s ahead, so the "not yet" state is visible first.
  const at = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    stage: "review", videoUrl: "https://example.test/clip-5s.mp4", platform: "Instagram", crossPostDestinations: ["TikTok"],
    caption: "Calm mornings with Nova (fictional)", hashtags: "#morningroutine #synthetic",
    exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
    scheduledAt: at, scheduleTimezone: "UTC", scheduleLocal: localOf(at.getTime(), "UTC"), scheduledDate: localOf(at.getTime(), "UTC").slice(0, 10),
  } });
  const fresh = await api(`/api/pipeline/${item.id}`, null, "GET");
  assert.equal((await api(`/api/pipeline/${item.id}/approve`, { revision: fresh.revision, snapshotHash: fresh.snapshotHash })).success, true);
  assert.equal((await api(`/api/pipeline/${item.id}/exports`, {})).success, true);
  const sched = await api(`/api/pipeline/${item.id}/schedule`, {});
  assert.equal(sched.success, true, JSON.stringify(sched));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 }, deviceScaleFactor: 2 });
  page.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "example.test") return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });
  const openPanel = async () => {
    await page.goto(WEB);
    await page.getByRole("button", { name: "Pipeline" }).first().click();
    await page.locator("div.cursor-pointer").filter({ hasText: "Nova Vale" }).first().click();
    await page.getByRole("button", { name: "Open content package" }).click();
    await page.getByLabel("Publishing").waitFor();
    return page.getByLabel("Publishing");
  };
  let panel = await openPanel();
  const rows = panel.locator("tbody tr");
  assert.equal(await rows.count(), 2, "two destinations for one original");
  await rows.filter({ hasText: "Instagram" }).getByText("Simulation only").waitFor();
  await rows.filter({ hasText: "TikTok" }).getByText("Simulation only").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Publish now" }).isDisabled(), true);
  await panel.getByText("Available at the approved time.").waitFor();

  // Wait for the approved time, then publish (simulated).
  while (Date.now() < at.getTime() + 500) await sleep(1000);
  panel = await openPanel();
  await panel.getByRole("button", { name: "Publish now" }).click();
  await panel.getByRole("status").getByText("Publish run finished; see each destination").waitFor();
  await panel.getByText("Simulated: nothing was posted").first().waitFor();
  assert.equal(await panel.getByText("Simulated: nothing was posted").count(), 2);
  await panel.getByText("Job: simulated · nothing left to send").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Publish now" }).isDisabled(), true, "no second run");
  assert.equal(await panel.getByRole("link", { name: "simulated link" }).count(), 2);

  // Nothing is recorded as published.
  const entry = await prisma.content.findUnique({ where: { id: sched.content.id } });
  assert.equal(entry.status, "scheduled");
  assert.equal((await prisma.publishDelivery.count({ where: { simulated: true, state: "simulated" } })), 2);
  assert.equal(await prisma.publishJob.count(), 1);

  await page.reload();
  panel = await openPanel();
  await panel.getByText("Job: simulated").waitFor();
  await panel.screenshot({ path: path.join(root, "docs/screenshots/pkg-f-publishing.png") });
  console.log("Publishing e2e passed (simulation only: status per destination, due-time block, one job / two deliveries, nothing marked published, reload); screenshot written");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
