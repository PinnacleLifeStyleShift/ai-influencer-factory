/**
 * Measurement browser check (brief section 10, second half). Synthetic data
 * only; off-machine requests blocked; no analytics provider is connected.
 *
 * Covers: report facts (period, time zone, UTC window, refresh, originals vs
 * posts, posts without readings); recording a manual reading in the viewer's
 * zone; sources kept apart and fixtures excluded unless asked; retracting a
 * reading; the analytics refresh refusing (not connected); campaign money as
 * planned / invoiced / received; the dashboard without an "earned" total; the
 * phone layout. Writes docs/screenshots/pkg-g-measurement.png and
 * pkg-g-campaign-money.png.
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

  // Seed: one original posted to Instagram and TikTok (confirmed), and a campaign.
  const character = await prisma.character.create({ data: { characterId: "INFL-E2E", name: "Nova Vale", status: "active" } });
  const content = await prisma.content.create({ data: { title: "Calm mornings", characterId: character.id, status: "published", scheduleKey: "e2e-k" } });
  const posted = new Date(Date.now() - 3 * 86400_000);
  const job = await prisma.publishJob.create({ data: {
    contentId: content.id, pipelineItemId: "synthetic", snapshotHash: "h", manifestHash: "m", state: "published",
    deliveries: { create: [
      { platform: "Instagram", state: "published", remotePostId: "ig-777", permalink: "https://example.test/ig/777", confirmedAt: posted },
      { platform: "TikTok", state: "published", remotePostId: "tt-777", permalink: "https://example.test/tt/777", confirmedAt: posted },
    ] },
  }, include: { deliveries: true } });
  const ig = job.deliveries.find((d) => d.platform === "Instagram");
  const campaign = await prisma.campaign.create({ data: { name: "Synthetic Sponsor Co", brand: "Synthetic", payoutAmount: "500", status: "active" } });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 2, timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  page.on("dialog", (d) => {
    const msg = d.message();
    d.accept(msg.includes("owner API token") ? TOKEN : msg.includes("wrong") ? "Read the wrong post" : undefined);
  });
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });

  await page.goto(WEB);
  // Dashboard: money by state, no "earned".
  await page.getByText("Only money received is income").waitFor();
  assert.equal(await page.getByText(/Total Earned/i).count(), 0);
  await page.getByText(/2 confirmed post\(s\)/).waitFor();

  await page.getByRole("button", { name: "Measurement" }).first().click();
  const facts = page.getByLabel("Report facts");
  await facts.getByText(/in America\/Los_Angeles/).waitFor();
  await facts.getByText("1 original(s) posted as 2 post(s)").waitFor();
  await facts.getByText(/2 post\(s\) without any reading/).waitFor();

  // Record a manual reading (entered in the viewer's own time).
  const form = page.getByRole("group", { name: "Record a reading" });
  await form.getByLabel("What was measured").selectOption(`post:${ig.id}`);
  await form.getByLabel("Value").fill("1200");
  const local = new Date(Date.now() - 3600_000).toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 16).replace(" ", "T");
  await form.getByLabel("Read at (your time)").fill(local);
  await form.getByRole("button", { name: "Record reading" }).click();
  await form.getByRole("alert").getByText(/sourceDetail is required/).waitFor(); // where was it read?
  await form.getByLabel("Where the number was read").fill("Instagram Insights, post screen");
  await form.getByRole("button", { name: "Record reading" }).click();
  await page.getByRole("status").getByText("Reading recorded").waitFor();
  await facts.getByText(/1 post\(s\) without any reading: TikTok tt-777/).waitFor();
  const totals = page.getByLabel("Totals by source");
  await totals.getByText("Manual reading").waitFor();
  await totals.getByText("1,200 (1 post)").waitFor();

  // A fixture is excluded unless asked for, and labelled when shown.
  await form.getByLabel("Source").selectOption("fixture");
  await form.getByLabel("Value").fill("999999");
  await form.getByRole("button", { name: "Record reading" }).click();
  await page.getByRole("status").getByText("Reading recorded").waitFor();
  assert.equal(await totals.getByText("Fixture (not real)").count(), 0);
  await page.getByLabel("Include fixtures").check();
  await totals.getByText("Fixture (not real)").waitFor();
  await page.getByLabel("Include fixtures").uncheck();

  // Retract the fixture; the platform refresh says it is not connected.
  const recent = page.getByRole("table", { name: "Recent readings" });
  await recent.locator("tr", { hasText: "999,999" }).getByRole("button", { name: "Retract" }).click();
  await page.getByRole("status").getByText("Reading retracted").waitFor();
  await page.getByRole("button", { name: "Refresh from platform" }).click();
  await page.getByRole("status").getByText(/No platform analytics provider is enabled/).waitFor();
  await page.getByLabel("Report period").getByText(/Last refreshed/).waitFor();
  await page.screenshot({ path: path.join(root, "docs/screenshots/pkg-g-measurement.png"), fullPage: false });

  // Campaign money: planned -> invoiced -> received.
  await page.getByRole("button", { name: "Campaigns" }).first().click();
  await page.getByRole("button", { name: "Money" }).first().click();
  const money = page.getByRole("group", { name: "Campaign money" });
  await money.getByText("planned").first().waitFor();
  await money.getByLabel("Invoice number").fill("INV-100");
  await money.getByLabel("Amount").first().fill("300");
  await money.getByRole("button", { name: "Record invoice" }).click();
  await money.getByRole("status").getByText("Invoice recorded").waitFor();
  await money.getByLabel("For invoice").selectOption({ label: "INV-100" });
  await money.getByLabel("Amount").nth(1).fill("120");
  await money.getByLabel("Payment reference").fill("BANK-REF-1");
  await money.getByRole("button", { name: "Record money received" }).click();
  await money.getByRole("status").getByText(/evidence is required/).waitFor();
  await money.getByLabel("Evidence").fill("Bank statement line, synthetic test");
  await money.getByRole("button", { name: "Record money received" }).click();
  await money.getByRole("status").getByText("Receipt recorded").waitFor();
  await money.getByText(/outstanding 180\.00 USD/).waitFor();
  await money.getByText(/received/).first().waitFor();
  await page.locator(`text=planned 500.00 USD`).first().waitFor();
  const stored = await prisma.campaignReceipt.findFirst({ where: { campaignId: campaign.id } });
  assert.equal(Number(stored.amountMicros), 120_000_000);
  await money.screenshot({ path: path.join(root, "docs/screenshots/pkg-g-campaign-money.png") });

  // Phone: the measurement page has no horizontal page scroll.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await phone.newPage();
  mp.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await mp.route("**/*", (route) => (["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort()));
  await mp.goto(WEB);
  await mp.getByRole("button", { name: "Measurement" }).first().click();
  await mp.getByLabel("Report facts").waitFor();
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll on a phone (${overflow}px)`);

  console.log("Measurement e2e passed (report facts, manual reading with source, fixtures excluded, retract, provider refusal, campaign money states, dashboard, phone); screenshots written");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
