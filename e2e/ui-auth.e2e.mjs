/**
 * Browser check of UI authentication against a real local backend.
 * Run via: backend/scripts/with-test-postgres.sh node ../e2e/ui-auth.e2e.mjs
 * (needs TEST_DATABASE_URL from the disposable Postgres; no external network).
 *
 * Verifies: the app's parallel initial requests produce ONE token prompt,
 * every API call goes only to the configured local API, requests carry the
 * token after the prompt, and data loads.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright"); // preinstalled, not a project dependency
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "e2e-owner-token-0123456789abcdefghijklmnop"; // synthetic
const API_PORT = 4300 + Math.floor(Math.random() * 500);
const WEB_PORT = 5300 + Math.floor(Math.random() * 500);
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");

const procs = [];
function start(cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  procs.push(p);
  return p;
}
async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

try {
  start("node", ["src/server.js"], path.join(root, "backend"), {
    PORT: String(API_PORT), DATABASE_URL: process.env.TEST_DATABASE_URL,
    OWNER_API_TOKEN: TOKEN, FRONTEND_URL: WEB, ROLE_INVITES: "enabled",
  });
  start("npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], root, { VITE_API_URL: API });
  await waitFor(`${API}/health`);
  console.log("api up");
  await waitFor(WEB);
  console.log("web up");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(TOKEN); });
  const apiRequests = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) apiRequests.push({ url: r.url(), auth: r.headers().authorization || "" }); });
  const external = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    external.push(u.href);
    return route.abort();
  });

  await page.goto(WEB);
  await page.waitForResponse((r) => r.url().startsWith(`${API}/api/characters`) && r.status() === 200, { timeout: 20000 });
  await page.waitForTimeout(500);

  assert.equal(dialogs.length, 1, `expected one token prompt, got ${dialogs.length}`);
  assert.ok(dialogs[0].includes(API), "prompt names the API the token is sent to");
  assert.ok(apiRequests.length >= 3, "app made its parallel initial requests");
  assert.ok(apiRequests.every((r) => r.url.startsWith(API)), "API calls only to the configured local API");
  assert.ok(apiRequests.some((r) => r.url.endsWith("/api/auth/session") && r.auth === `Bearer ${TOKEN}`), "owner token used only to create a session");
  assert.ok(apiRequests.filter((r) => !r.url.endsWith("/api/auth/session")).every((r) => r.auth === "" || r.auth.startsWith("Bearer ses_")),
    "API calls carry a session, never the owner token");
  const stored = await page.evaluate(() => sessionStorage.getItem("aif.session"));
  assert.match(stored, /^ses_/, "a session is stored");
  const all = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href);
  assert.ok(!all.includes(TOKEN), "the owner token is not stored or in the URL");

  // Reload: token is reused from sessionStorage, no new prompt.
  await page.reload();
  await page.waitForResponse((r) => r.url().startsWith(`${API}/api/characters`) && r.status() === 200);
  assert.equal(dialogs.length, 1, "no prompt after reload in the same tab");

  // Two-role sign-in: the owner issues a reviewer invite in Team access; a
  // separate browser signs in with the code once and gets reviewer rights.
  await page.getByText("Signed in as owner").waitFor();
  await page.getByRole("button", { name: "Operations" }).first().click();
  assert.equal(await page.getByRole("button", { name: "Operations" }).first().getAttribute("aria-current"), "page");
  // Capability panel: every live capability shown as off, with what it needs.
  const caps = page.getByRole("table", { name: "Capability states" });
  await caps.getByText("Paid image and video generation").waitFor();
  assert.equal(await caps.getByText("✓ on").count(), 1, "only invites are switched on in this test server");
  await page.getByLabel("Capabilities").screenshot({ path: path.join(root, "docs/screenshots/spec-1111-capabilities.png") });
  const team = page.getByLabel("Team access");
  await team.getByLabel("Who it is for").fill("Synthetic reviewer");
  await team.getByRole("button", { name: "Create invite" }).click();
  const code = await team.getByLabel("Invite code").inputValue();
  assert.ok(code.length >= 32, "a code is shown once");
  await page.setViewportSize({ width: 1280, height: 900 });
  // Synthetic, throwaway code; blurred anyway so no credential-shaped value is captured.
  await team.getByLabel("Invite code").evaluate((el) => { el.style.filter = "blur(5px)"; });
  await team.screenshot({ path: path.join(root, "docs/screenshots/spec-1111-team-access.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll on a phone (${overflow}px)`);
  await team.screenshot({ path: path.join(root, "docs/screenshots/spec-1111-team-access-phone.png") });
  await page.setViewportSize({ width: 1280, height: 900 });

  const reviewer = await browser.newContext();
  const rp = await reviewer.newPage();
  const rDialogs = [];
  rp.on("dialog", async (d) => { rDialogs.push(d.message()); await d.accept(rDialogs.length === 1 ? code : undefined); });
  await rp.route("**/*", (route) => (["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort()));
  await rp.goto(WEB);
  await rp.waitForResponse((r) => r.url().startsWith(`${API}/api/characters`) && r.status() === 200, { timeout: 20000 });
  assert.match(rDialogs[0], /access code/, "the prompt accepts an access code");
  const rToken = await rp.evaluate(() => sessionStorage.getItem("aif.session"));
  const me = await (await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${rToken}` } })).json();
  assert.equal(me.principal.role, "reviewer");
  await rp.getByText("Signed in as reviewer").waitFor();
  assert.equal(await rp.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Operations" }).count(), 0, "owner-only navigation is hidden");
  // Hiding is a courtesy; the server still refuses the reviewer directly.
  const denied = await fetch(`${API}/api/system/operations`, { headers: { Authorization: `Bearer ${rToken}` } });
  assert.equal(denied.status, 403, "a reviewer cannot open owner operations");
  assert.deepEqual((await denied.json()).details.missing, ["admin"]);
  const again = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { Authorization: `Bearer ${code}` } });
  assert.equal(again.status, 401, "the code works once");
  await reviewer.close();

  console.log(`UI auth e2e passed: ${apiRequests.length} API requests, ${dialogs.length} prompt, external requests blocked: ${external.length}; two-role sign-in (owner issues reviewer invite, reviewer signs in once, owner-only navigation hidden, server refuses with the missing permission)`);
  await browser.close();
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(process.exitCode ?? 0);
