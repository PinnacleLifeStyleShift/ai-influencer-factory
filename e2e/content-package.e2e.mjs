/**
 * Package C browser check against a local stack (backend + Vite + disposable
 * Postgres). Synthetic data only; off-machine requests blocked; example.test
 * media served locally. Paid generation stays blocked (default gate), so the
 * UI must show the server's refusal.
 *
 * Covers: opening a package, storyboard + clip status, claims flag, editing
 * the script into a new version, and recovery after reload.
 * Writes docs/screenshots/pkg-c-content-package.png.
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
const { createPrismaClient } = await import(path.join(root, "backend/src/lib/prisma.js"));
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
    expectedVersion: p1.script.version,
    hook: "Three small habits for a calmer morning.",
    body: "Open the curtains as soon as you wake. Studies show 90% of people skip water before coffee. Stretch for two minutes beside the bed.",
    callToAction: "Follow for more calm routines.",
  }, "PUT");
  // Synthetic clips with reported lengths for every shot but the last (display only).
  const p2 = await api(`/api/pipeline/${item.id}/package`, null, "GET");
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    shotMedia: p2.storyboard.slice(0, -1).map((s) => ({
      shotIndex: s.index, shotKey: s.shotKey, kind: "video", url: `https://example.test/clip-${s.index}.mp4`,
      durationSec: s.durationSec <= 5 ? 5 : 10, durationSource: "provider_reported", reservationId: null,
    })),
  } });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  page.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "example.test") return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });

  const openPackage = async () => {
    await page.goto(WEB);
    await page.getByRole("button", { name: "Pipeline" }).first().click();
    // The pipeline list entry (not the character dropdown option with the same name).
    await page.locator("div.cursor-pointer").filter({ hasText: "Nova Vale" }).first().click();
    await page.getByRole("button", { name: "Open content package" }).click();
    await page.getByLabel("Content package").waitFor();
  };
  await openPackage();
  const panel = page.getByLabel("Content package");
  await panel.getByText(/Studies show 90% of people skip water before coffee\.” needs a source/).waitFor();
  await panel.getByText("shots missing or too short").waitFor();
  assert.ok(await panel.getByRole("button", { name: "Generate clip" }).count() >= 1);

  // Paid generation is blocked by default: the UI shows the server's refusal.
  await panel.getByRole("button", { name: "Generate clip" }).first().click();
  await panel.getByText(/has not been approved for paid generation/).waitFor();

  // Edit the script: remove the unsourced claim -> new version, claims pass.
  await panel.getByLabel("Body").fill("Open the curtains as soon as you wake. Drink a glass of water before coffee. Stretch for two minutes beside the bed.");
  await panel.getByRole("button", { name: "Save script as new version" }).click();
  await panel.getByText("Saved as a new script version").waitFor();
  await panel.getByText(/script v3/).waitFor();
  await panel.getByText("Every flagged line has a source or fiction framing.").waitFor();

  await page.reload();
  await openPackage();
  await page.getByLabel("Content package").getByText(/script v3/).waitFor();
  const body = await page.getByLabel("Content package").getByLabel("Body").inputValue();
  assert.match(body, /Drink a glass of water/, "edit survived the reload");

  await page.getByLabel("Content package").screenshot({ path: path.join(root, "docs/screenshots/pkg-c-content-package.png") });
  console.log("Content package e2e passed (storyboard, claims, blocked generation, script versioning, reload); screenshot written");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
