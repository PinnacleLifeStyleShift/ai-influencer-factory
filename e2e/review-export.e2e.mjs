/**
 * Package E browser check against a local stack (backend + Vite + disposable
 * Postgres), with the synthetic media store (local fixture files only).
 * Off-machine requests are blocked; nothing is generated, posted or bought.
 *
 * Covers: a daylight-saving ambiguous time needing a choice, a nonexistent
 * time refused, local/UTC/viewer time on review, approval of the exact
 * version, export with checksum-verified media and a downloadable manifest,
 * a plan-only calendar entry, keyboard-driven cancellation that supersedes the
 * export, and the phone layout. Writes docs/screenshots/pkg-e-review-*.png.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // preinstalled, not a project dependency

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(root, "backend/test/fixtures/media");
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
    MEDIA_STORE: "synthetic-fixture", MEDIA_FIXTURE_DIR: FIXTURES,
  });
  start("npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], root, { VITE_API_URL: API });
  await waitFor(`${API}/health`);
  await waitFor(WEB);

  // Seed: a character, a script with no unsupported claims, and a synthetic clip.
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
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    stage: "review", videoUrl: "https://example.test/clip-5s.mp4", platform: "Instagram",
    caption: "Calm mornings with Nova (fictional)", hashtags: "#morningroutine #synthetic",
    exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
  } });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2, timezoneId: "Europe/London", acceptDownloads: true });
  const page = await context.newPage();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(d.message().includes("owner API token") ? TOKEN : undefined); });
  const block = (pg) => pg.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "example.test") return route.fulfill({ status: 200, contentType: "video/mp4", body: fs.readFileSync(path.join(FIXTURES, "clip-5s.mp4")) });
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });
  await block(page);

  const openPackage = async (pg) => {
    await pg.goto(WEB);
    await pg.getByRole("button", { name: "Pipeline" }).first().click();
    await pg.locator("div.cursor-pointer").filter({ hasText: "Nova Vale" }).first().click();
    await pg.getByRole("button", { name: "Open content package" }).click();
    await pg.getByLabel("Review, schedule and export").waitFor();
    return pg.getByLabel("Review, schedule and export");
  };
  let panel = await openPackage(page);
  const editor = panel.getByRole("group", { name: "Destination schedule" });

  // A time skipped by daylight saving is refused with a clear message.
  await editor.getByLabel("Date and time at the destination").fill("2027-03-14T02:30");
  await editor.getByLabel("Destination time zone (IANA)").fill("America/Los_Angeles");
  await editor.getByRole("button", { name: "Save schedule (clears approval)" }).click();
  await editor.getByRole("alert").getByText(/does not exist in America\/Los_Angeles/).waitFor();

  // A time that happens twice needs an explicit choice.
  await editor.getByLabel("Date and time at the destination").fill("2027-11-07T01:30");
  await editor.getByRole("button", { name: "Save schedule (clears approval)" }).click();
  await editor.getByText("This time happens twice. Which one?").waitFor();
  await editor.getByRole("button", { name: /Second \(UTC-08:00, 09:30 UTC\)/ }).click();
  const times = panel.getByLabel("Scheduled time");
  await times.getByText("2027-11-07T09:30:00Z").waitFor();
  await times.getByText(/America\/Los_Angeles/).waitFor();
  await times.getByText(/Europe\/London/).waitFor(); // the viewer's own zone, shown separately

  // Approve exactly this version, then export it.
  await panel.getByRole("button", { name: "Approve this exact version" }).click();
  await panel.getByText(/approved by owner\. The approval covers media, caption, disclosure, destination and time/).waitFor();
  await panel.getByRole("button", { name: "Export approved version" }).click();
  await panel.getByRole("status").getByText(/Export verified: 1 file\(s\) checked/).waitFor();
  const exportsList = panel.getByRole("list", { name: "Exports" });
  await exportsList.getByText("Current").waitFor();
  const [download] = await Promise.all([page.waitForEvent("download"), exportsList.getByRole("button", { name: "JSON" }).first().click()]);
  const manifest = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  const fixtureSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXTURES, "clip-5s.mp4"))).digest("hex");
  assert.equal(manifest.media[0].sha256, fixtureSha, "the manifest's checksum is the clip's real checksum");
  assert.equal(manifest.destination.schedule.utc, "2027-11-07T09:30:00.000Z");
  assert.equal(manifest.disclosure, "This is a fictional, AI-generated character.");

  // Calendar: a plan only.
  await panel.getByRole("button", { name: "Add to calendar at the approved time" }).click();
  await panel.getByText("On the calendar · planned only, not published").waitFor();
  await panel.screenshot({ path: path.join(root, "docs/screenshots/pkg-e-review-desktop.png") });

  // Keyboard-only cancellation (confirmation dialog accepted).
  const reason = panel.getByLabel("Reason for cancelling");
  await reason.focus();
  await page.keyboard.type("Clashes with a holiday");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await panel.getByRole("status").getByText("Schedule cancelled").waitFor();
  assert.ok(dialogs.some((m) => m.includes("can never be delivered")), "cancellation asked for confirmation");
  await panel.getByText(/Not approved \(in review\)/).waitFor();
  await exportsList.getByText("Superseded").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Export approved version" }).isDisabled(), true);
  const entry = await prisma.content.findFirst({ where: { pipelineItems: { some: { id: item.id } } } });
  assert.equal(entry.status, "cancelled");
  assert.equal(entry.cancelReason, "Clashes with a holiday");

  // Recovery after reload, then the phone layout.
  await page.reload();
  panel = await openPackage(page);
  await panel.getByLabel("Scheduled time").getByText("2027-11-07T09:30:00Z").waitFor();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  const mp = await phone.newPage();
  mp.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await block(mp);
  const mpanel = await openPackage(mp);
  await mpanel.getByRole("button", { name: "Approve this exact version" }).waitFor();
  const overflow = await mp.evaluate(() => document.querySelector('[aria-label="Review, schedule and export"]').scrollWidth - document.querySelector('[aria-label="Review, schedule and export"]').clientWidth);
  if (overflow > 1) console.log(await mp.evaluate(() => { const root = document.querySelector('[aria-label="Review, schedule and export"]'); const r = root.getBoundingClientRect(); return [...root.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > r.right + 1).slice(0, 8).map((e) => `${e.tagName}.${e.className.slice?.(0, 40)} w=${Math.round(e.getBoundingClientRect().width)} txt=${(e.textContent || "").slice(0, 40)}`); }));
  assert.ok(overflow <= 1, `review panel fits a phone screen (overflow ${overflow}px)`);
  const pageOverflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(pageOverflow <= 1, `no horizontal page scroll on a phone (${pageOverflow}px)`);
  await mpanel.screenshot({ path: path.join(root, "docs/screenshots/pkg-e-review-mobile.png") });

  console.log("Review/export e2e passed (DST choice + refusal, approval, verified export + download, plan-only calendar, keyboard cancel, reload, phone); screenshots written");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
