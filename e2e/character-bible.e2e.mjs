/**
 * Package B browser check against a local stack (backend + Vite + disposable
 * Postgres). Synthetic data only; requests to example.test images are served
 * locally; everything else off-machine is blocked.
 *
 * Covers: versions panel, draft-changed indicator, rights status with missing
 * items, recording + approving rights, publishing, and recovery after reload.
 * Writes docs/screenshots/pkg-b-character-bible.png.
 * Run: backend/scripts/with-test-postgres.sh node ../e2e/character-bible.e2e.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright"); // preinstalled, not a project dependency

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "e2e-owner-token-0123456789abcdefghijklmnop"; // synthetic
const API_PORT = 4800 + Math.floor(Math.random() * 300);
const WEB_PORT = 5800 + Math.floor(Math.random() * 300);
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
const svg = (label, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="hsl(${hue},45%,30%)"/><circle cx="128" cy="105" r="52" fill="hsl(${hue},40%,65%)"/><rect x="58" y="170" width="140" height="70" rx="35" fill="hsl(${hue},40%,65%)"/><text x="128" y="246" font-size="18" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`;

let exitCode = 0;
try {
  start("node", ["src/server.js"], path.join(root, "backend"), {
    PORT: String(API_PORT), DATABASE_URL: process.env.TEST_DATABASE_URL, OWNER_API_TOKEN: TOKEN, FRONTEND_URL: WEB,
  });
  start("npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], root, { VITE_API_URL: API });
  await waitFor(`${API}/health`);
  await waitFor(WEB);

  // Seed through the API, as an operator would.
  const session = (await (await fetch(`${API}/api/auth/session`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).json()).sessionToken;
  const api = (p, body, method = "POST") => fetch(`${API}${p}`, {
    method, headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  const c = await api("/api/characters", {
    name: "Nova Vale", character_type: "Human", niche: "Fitness",
    persona: "Fictional adult fitness coach (synthetic test persona). Calm and precise.",
    reference_image_url: "https://example.test/nova-ref.png",
  });
  await api(`/api/characters/${c.id}/versions`, { note: "Initial identity" });
  await api(`/api/characters/${c.id}`, { persona: "Fictional adult fitness coach (synthetic test persona). Warmer tone." }, "PUT");
  await api(`/api/characters/${c.id}/images`, { imageUrl: "https://example.test/nova-alt.png" });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  page.on("dialog", async (d) => {
    if (d.message().includes("owner API token")) return d.accept(TOKEN);
    if (d.message().includes("Note for this version")) return d.accept("Warmer tone (UI)");
    return d.accept();
  });
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "example.test") {
      const alt = u.pathname.includes("alt");
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(alt ? "candidate" : "reference", alt ? 200 : 30) });
    }
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });

  const openCharacter = async () => {
    await page.goto(WEB);
    await page.getByRole("button", { name: "Characters" }).first().click();
    await page.getByText("Nova Vale").first().click();
    await page.getByText("Published versions").waitFor();
  };
  await openCharacter();
  await page.getByText("the draft has unpublished changes").waitFor();
  assert.equal(await page.getByText("Not cleared: rights record").count(), 2, "both images start without rights");

  // Record rights on the current reference, then approve as owner.
  const refCard = page.locator("div.w-32", { hasText: "Current reference" });
  await refCard.getByRole("button", { name: "Record rights" }).click();
  await refCard.getByLabel("Rights holder").fill("Synthetic Studio (test)");
  await refCard.getByRole("button", { name: "Save rights record" }).click();
  await refCard.getByText("owner approval of the rights record").waitFor();
  await refCard.getByRole("button", { name: "Approve rights (owner)" }).click();
  await refCard.getByText("Cleared for providers").waitFor();

  await page.getByRole("button", { name: "Publish draft as new version" }).click();
  await page.getByRole("cell", { name: "v2 (current)" }).waitFor();

  // Recovered after reload: everything above comes back from the server.
  await page.reload();
  await openCharacter();
  await page.getByRole("cell", { name: "v2 (current)" }).waitFor();
  await page.getByRole("cell", { name: "v1" }).waitFor();
  await page.locator("div.w-32", { hasText: "Current reference" }).getByText("Cleared for providers").waitFor();
  assert.equal(await page.getByText("the draft has unpublished changes").count(), 0);

  await page.screenshot({ path: path.join(root, "docs/screenshots/pkg-b-character-bible.png"), fullPage: true });
  console.log("Character bible e2e passed (versions, rights, publish, reload); screenshot written");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
