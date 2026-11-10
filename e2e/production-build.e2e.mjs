/**
 * Production-build check: builds the frontend exactly as deployed, serves it
 * with the production static server (`serve` + dist/serve.json headers) and
 * opens every page against a local API. Fails on any Content-Security-Policy
 * violation or page error, so the security headers cannot silently break the
 * app. Off-machine requests are blocked (fonts may fail to load; that is not
 * a CSP violation).
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // preinstalled, not a project dependency

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).status < 500) return; } catch { /* not up */ } await sleep(200); }
  throw new Error(`timeout ${url}`);
}

let exitCode = 0;
try {
  const build = spawnSync("npx", ["vite", "build"], { cwd: root, env: { ...process.env, VITE_API_URL: API }, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  start("node", ["src/server.js"], path.join(root, "backend"), { PORT: String(API_PORT), DATABASE_URL: process.env.TEST_DATABASE_URL, OWNER_API_TOKEN: TOKEN, FRONTEND_URL: WEB });
  start("npx", ["serve", "dist", "-s", "-l", String(WEB_PORT)], root, {});
  await waitFor(`${API}/ready`);
  await waitFor(WEB);
  const headers = (await fetch(WEB)).headers;
  assert.match(headers.get("content-security-policy") || "", /script-src 'self'/);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const violations = []; const errors = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await page.route("**/*", (route) => (["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort()));
  await page.goto(WEB);
  for (const name of ["Dashboard", "Characters", "Pipeline", "Generation Jobs", "Content Calendar", "Campaigns", "Measurement", "Operations"]) {
    await page.getByRole("button", { name }).first().click();
    await page.waitForLoadState("networkidle");
  }
  // The app really talked to its API under the policy.
  await page.getByRole("button", { name: "Characters" }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Operations" }).first().click();
  await page.getByLabel("Generation switch").waitFor();
  await page.screenshot({ path: path.join(root, "docs/screenshots/pkg-m-operations.png") });
  assert.deepEqual(violations, [], "no Content-Security-Policy violations");
  assert.deepEqual(errors, [], "no page errors");
  console.log("Production build e2e passed (served with security headers; every page opened with no CSP violation or page error)");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
