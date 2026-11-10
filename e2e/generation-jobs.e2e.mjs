/**
 * Package D browser check against a local stack (backend + Vite + disposable
 * Postgres). Synthetic data only; off-machine requests blocked; no provider
 * is configured, so nothing can be bought.
 *
 * Seeds a job abandoned by a "dead" worker (lease expired): step 1 was
 * accepted by the provider, step 2 was reserved but never sent. Then, in the
 * UI: recovery marks step 1 "outcome unknown" (money kept) and releases step
 * 2; the provider check is refused (the adapter cannot look requests up); the
 * owner resolves step 1 with evidence; the audit line survives a reload.
 * Writes docs/screenshots/pkg-d-generation-jobs.png.
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

  // Seeded after startup so the operator triggers recovery from the UI.
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const reserve = (key, micros) => prisma.generationReservation.create({ data: {
    provider: "mockimg", model: "synthetic-v1", amountMicros: BigInt(micros), state: "reserved", day, month: day.slice(0, 7),
    idempotencyKey: key, currency: "USD", priceVersion: "e2e-fixture-v1", capTimezone: "UTC",
  } });
  const r1 = await reserve("e2e-job-step-0", 1_500_000);
  const r2 = await reserve("e2e-job-step-1", 2_000_000);
  const job = await prisma.generationJob.create({ data: {
    kind: "content", targetType: "pipeline_item", targetId: "synthetic-item-0001", workflowKey: "e2e-workflow",
    state: "running", leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 60_000), createdBy: "owner",
    steps: { create: [
      { index: 0, kind: "image", provider: "mockimg", model: "synthetic-v1", idempotencyKey: "e2e-job-step-0", reservationId: r1.id, state: "accepted", providerRequestId: "req-synthetic-42" },
      { index: 1, kind: "video", provider: "mockimg", model: "synthetic-v1", idempotencyKey: "e2e-job-step-1", reservationId: r2.id, state: "reserved" },
    ] },
  } });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("dialog", (d) => d.accept(d.message().includes("owner API token") ? TOKEN : undefined));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    return route.abort();
  });

  const openJobs = async () => {
    await page.goto(WEB);
    await page.getByRole("button", { name: "Generation Jobs" }).first().click();
    await page.getByRole("heading", { name: "Generation jobs" }).waitFor();
  };
  await openJobs();
  const card = page.getByLabel(`Job ${job.id}`);
  await card.getByText("running").first().waitFor();

  await page.getByRole("button", { name: "Recover abandoned jobs" }).click();
  await page.getByRole("status").getByText("Recovery checked abandoned jobs").waitFor();
  await card.getByText("awaiting reconciliation").waitFor();
  await card.getByText("Outcome unknown: may have been charged").waitFor();
  await card.getByText("Never sent (money released)").waitFor();
  const [s1, s2] = await Promise.all([r1, r2].map((r) => prisma.generationReservation.findUnique({ where: { id: r.id } })));
  assert.equal(s1.state, "outcome_unknown", "maybe-sent money stays counted");
  assert.equal(s2.state, "released", "never-sent money is released");

  // The production adapters cannot look requests up: refused, nothing changes.
  await card.getByRole("button", { name: "Check with provider" }).click();
  await page.getByRole("status").getByText(/resolve it manually with evidence/).waitFor();

  // Owner resolution with evidence.
  await card.getByRole("button", { name: "Resolve…" }).click();
  const form = card.getByRole("group", { name: "Resolve step" });
  await form.getByRole("button", { name: "Record resolution" }).click();
  await form.getByRole("alert").getByText(/evidence is required/).waitFor();
  await form.getByLabel("What the provider shows").selectOption("charged_no_result");
  await form.getByLabel("Actual cost (optional)").fill("1.20");
  await form.getByLabel(/Evidence/).fill("Provider dashboard shows req-synthetic-42 billed $1.20, failed with no output.");
  await form.getByRole("button", { name: "Record resolution" }).click();
  await page.getByRole("status").getByText("Resolution recorded").waitFor();
  await card.getByText("Resolved: charged, no result").waitFor();
  const settled = await prisma.generationReservation.findUnique({ where: { id: r1.id } });
  assert.equal(settled.state, "settled");
  assert.equal(Number(settled.actualMicros), 1_200_000);

  await page.reload();
  await openJobs();
  await card.getByText(/resolved by .* as charged no result: “Provider dashboard shows req-synthetic-42/).waitFor();
  assert.equal(await card.getByRole("button", { name: "Resolve…" }).count(), 0, "a decided step cannot be resolved again");

  await card.screenshot({ path: path.join(root, "docs/screenshots/pkg-d-generation-jobs.png") });
  console.log("Generation jobs e2e passed (recovery, blocked check, evidence-required resolution, audit after reload); screenshot written");
  await browser.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.exit(exitCode);
