/**
 * The role journey in the browser (completion spec, IF-F2): a reviewer on a
 * phone and an editor on desktop, keyboard only, with focus moved into the
 * opened panel and restored on close, and a refresh mid-journey. Synthetic
 * records; local servers only; every other request blocked.
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
    MEDIA_STORE: "synthetic-fixture", MEDIA_FIXTURE_DIR: FIXTURES, ROLE_INVITES: "enabled",
  });
  start("npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], root, { VITE_API_URL: API });
  await waitFor(`${API}/health`);
  await waitFor(WEB);

  // Seed (owner, through the API): a character and a scripted package ready for review.
  const session = (await (await fetch(`${API}/api/auth/session`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).json()).sessionToken;
  const api = (p, body, method = "POST") => fetch(`${API}${p}`, {
    method, headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  const c = await api("/api/characters", { name: "Juno Keyboard", character_type: "Human", niche: "Lifestyle", persona: "Fictional adult coach (synthetic test persona)." });
  const { pipelineItem: item } = await api("/api/pipeline/generate-script", { characterId: c.id, duration: "30s" });
  const p1 = await api(`/api/pipeline/${item.id}/package`, null, "GET");
  await api(`/api/pipeline/scripts/${p1.script.id}`, { expectedVersion: p1.script.version, hook: "Three small habits for a calmer morning.",
    body: "Open the curtains as soon as you wake. Drink a glass of water before coffee. Stretch for two minutes beside the bed.", callToAction: "Follow for more calm routines." }, "PUT");
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    stage: "review", videoUrl: "https://example.test/clip-5s.mp4", platform: "Instagram", caption: "Calm mornings (fictional)", hashtags: "#synthetic",
    exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
  } });
  const issued = {};
  const invite = async (role) => { const r = await api("/api/auth/invites", { role, label: `Synthetic ${role}` }); issued[role] = r.invite.id; return r.code; };

  const browser = await chromium.launch();
  const block = (pg) => pg.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "example.test") return route.fulfill({ status: 200, contentType: "video/mp4", body: fs.readFileSync(path.join(FIXTURES, "clip-5s.mp4")) });
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });
  const signIn = async (viewport, code, extra = {}) => {
    const ctx = await browser.newContext({ viewport, ...extra });
    const pg = await ctx.newPage();
    let used = false;
    pg.on("dialog", (d) => d.accept(!used && d.message().includes("access code") ? ((used = true), code) : undefined));
    await block(pg);
    await pg.goto(WEB);
    await pg.waitForResponse((r) => r.url().startsWith(`${API}/api/characters`) && r.status() === 200, { timeout: 20000 });
    return { ctx, pg };
  };
  const focused = (pg) => pg.evaluate(() => { const a = document.activeElement; return `${a?.tagName}|${a?.getAttribute("aria-label") || ""}|${(a?.textContent || "").trim().slice(0, 40)}`; });

  // Reviewer on a phone, keyboard only: navigate, open the item and its package, approve.
  const { ctx: rctx, pg: rp } = await signIn({ width: 390, height: 844 }, await invite("reviewer"), { isMobile: true, hasTouch: true });
  await rp.getByText("Signed in as reviewer").waitFor();
  await rp.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Pipeline" }).focus();
  await rp.keyboard.press("Enter");
  const card = rp.getByRole("button", { name: /Juno Keyboard/ }).first();
  await card.focus();
  assert.match(await focused(rp), /Juno Keyboard/, "the item card takes keyboard focus");
  await rp.keyboard.press("Enter");
  assert.equal(await card.getAttribute("aria-expanded"), "true", "Enter expands the card");
  const opener = rp.getByRole("button", { name: "Open content package" });
  await opener.focus();
  await rp.keyboard.press("Enter");
  const panel = rp.getByLabel("Content package");
  await panel.waitFor();
  assert.match(await focused(rp), /Content package/, "focus moves into the opened panel");
  const approve = rp.getByRole("button", { name: "Approve this exact version" });
  await approve.focus();
  await rp.keyboard.press("Enter");
  await rp.getByText(/approved by reviewer/i).first().waitFor();
  await rp.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  await rp.waitForFunction(() => document.activeElement && document.activeElement !== document.body, null, { timeout: 2000 }).catch(() => {});
  assert.match(await focused(rp), /Open content package|Juno Keyboard/, "closing returns focus to the opener (or the same item's card)");
  const overflow = await rp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll on a phone (${overflow}px)`);

  // Refresh mid-journey: the session and the approval survive; no new prompt.
  await rp.reload();
  await rp.getByText("Signed in as reviewer").waitFor();
  const after = await api(`/api/pipeline/${item.id}`, null, "GET");
  assert.equal(after.stage, "approved");
  // Which reviewer approved is in the audit trail (approvedBy shows the role).
  const reviewerId = `invite:${issued.reviewer}`;
  // Audit rows are written once the response finishes (asynchronously): poll briefly.
  let audit = null;
  for (let i = 0; i < 30 && !audit?.actorId?.startsWith("invite:"); i++) {
    audit = await prisma.auditEvent.findFirst({ where: { action: "POST /api/pipeline/:id/approve", targetId: item.id, outcome: "success" }, orderBy: { at: "desc" } });
    if (!audit?.actorId?.startsWith("invite:")) await sleep(100);
  }
  assert.deepEqual([audit?.actorId, audit?.actorRole], [reviewerId, "reviewer"], "the audit trail names the reviewer who approved");
  await rctx.close();

  // Editor on desktop, keyboard: can open the package, cannot approve (server refuses, message names the permission).
  const { ctx: ectx, pg: ep } = await signIn({ width: 1280, height: 900 }, await invite("editor"));
  await ep.getByText("Signed in as editor").waitFor();
  assert.equal(await ep.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Operations" }).count(), 0);
  await prisma.pipelineItem.update({ where: { id: item.id }, data: { stage: "review", approvedHash: null, approvedRevision: null } });
  await ep.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Pipeline" }).focus();
  await ep.keyboard.press("Enter");
  const ecard = ep.getByRole("button", { name: /Juno Keyboard/ }).first();
  await ecard.focus(); await ep.keyboard.press("Enter");
  await ep.getByRole("button", { name: "Open content package" }).focus(); await ep.keyboard.press("Enter");
  await ep.getByLabel("Content package").waitFor();
  await ep.getByRole("button", { name: "Approve this exact version" }).focus(); await ep.keyboard.press("Enter");
  await ep.getByText("Your role cannot do this: it needs the approve permission.").first().waitFor();
  assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).stage, "review", "refused: nothing changed");
  await ectx.close();

  console.log("Role journey browser e2e passed (reviewer on a phone by keyboard: card, package, approve, Escape restores focus, refresh keeps session and approval; editor on desktop: refusal names the permission, nothing changed)");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
