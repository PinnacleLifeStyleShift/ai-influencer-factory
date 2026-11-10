import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter, TEST_DB_URL } from "./db-helpers.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { configFindings, readiness, pruneSessions, repoMigrations } from "../src/services/opsChecks.js";

/**
 * Operational hardening: configuration audit (names only), readiness,
 * session housekeeping, graceful shutdown, a real backup -> restore drill,
 * the read-only preflight, and the sponsor-authorization gate.
 * Disposable local Postgres only.
 */
const opts = { skip: skipReason, timeout: 120_000 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_BIN = fs.readdirSync("/usr/lib/postgresql").sort().map((v) => `/usr/lib/postgresql/${v}/bin`).filter((d) => fs.existsSync(`${d}/pg_dump`)).pop();
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const SECRET = "very-secret-owner-token-value-0123456789";

test("config audit names settings and never includes a value", () => {
  const env = { DATABASE_URL: "postgresql://admin:hunter2@db.internal:5432/prod", OWNER_API_TOKEN: SECRET, FRONTEND_URL: "http://example.com/app", LIVE_PROVIDER_CALLS: "enabled", NODE_ENV: "production" };
  const out = configFindings(env, { nodeVersion: "22.20.0" });
  const text = JSON.stringify(out);
  for (const secret of ["hunter2", "db.internal", SECRET, "example.com"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  const by = (s) => out.filter((f) => f.setting === s).map((f) => f.level);
  assert.deepEqual(by("FRONTEND_URL"), ["warning"], "non-https origin");
  assert.deepEqual(by("TRUST_PROXY"), ["warning"]);
  assert.ok(by("LIVE_PROVIDER_CALLS").includes("warning"));
  assert.deepEqual(by("SPEND_LEDGER"), ["warning"]);
  assert.deepEqual(configFindings({}, { nodeVersion: "20.11.0" }).filter((f) => f.level === "error").map((f) => f.setting).sort(),
    ["DATABASE_URL", "FRONTEND_URL", "OWNER_API_TOKEN", "node"]);
  const short = configFindings({ OWNER_API_TOKEN: "short-secret-x" });
  assert.equal(short.find((f) => f.setting === "OWNER_API_TOKEN").level, "error");
  assert.ok(!JSON.stringify(short).includes("short-secret-x"), "a too-short token is still never printed");
});

test("readiness: database answers and every committed migration is applied", opts, async () => {
  assert.deepEqual(await readiness(prisma), { ready: true });
  const extra = await readiness(prisma, { expected: [...repoMigrations(), "29990101000000_future"] });
  assert.deepEqual(extra, { ready: false, reason: "migrations_pending", missing: 1 });
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma });
  try {
    const r = await json(await fetch(`${app.base}/ready`));
    assert.deepEqual(r, { status: 200, body: { status: "ready" } });
    // The audit is admin-only and lists names only.
    const editor = (await createSessionStore(prisma).create({ id: "synthetic-editor", role: "editor", workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;
    assert.equal((await app.raw("/api/system/config-check", { token: editor })).status, 403);
    const audit = await json(await app.call("/api/system/config-check", { token: TOKEN }));
    assert.equal(audit.status, 200);
    assert.ok(!JSON.stringify(audit.body).includes(TOKEN));
  } finally { await app.close(); }
  const down = await readiness({ $queryRawUnsafe: async () => { throw new Error("connection refused at db.internal"); } });
  assert.deepEqual(down, { ready: false, reason: "database_unavailable" }, "no error details leak");
});

test("housekeeping prunes only sessions expired or revoked long ago", opts, async () => {
  const store = createSessionStore(prisma);
  const live = await store.create({ id: "p", role: "owner" }, { provider: "test", ttlMs: 3600_000 });
  const old = await store.create({ id: "p", role: "owner" }, { provider: "test", ttlMs: 3600_000 });
  await prisma.session.update({ where: { id: old.session.id }, data: { expiresAt: new Date(Date.now() - 40 * 86400_000) } });
  const recent = await store.create({ id: "p", role: "owner" }, { provider: "test", ttlMs: 3600_000 });
  await prisma.session.update({ where: { id: recent.session.id }, data: { revokedAt: new Date(Date.now() - 86400_000) } });
  assert.equal(await pruneSessions(prisma), 1);
  assert.deepEqual((await prisma.session.findMany()).map((s) => s.id).sort(), [live.session.id, recent.session.id].sort());
});

test("graceful shutdown: SIGTERM stops the server cleanly", opts, async () => {
  const port = 4900 + Math.floor(Math.random() * 90);
  const p = spawn("node", ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATABASE_URL: TEST_DB_URL, OWNER_API_TOKEN: TOKEN, FRONTEND_URL: "https://app.example.test" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 200);
  assert.match(out, /\[config\] INFO LIVE_PROVIDER_CALLS: disabled/);
  assert.ok(!out.includes(TOKEN), "the token never appears in logs");
  const code = await new Promise((resolve) => { p.on("exit", resolve); p.kill("SIGTERM"); });
  assert.equal(code, 0);
  assert.match(out, /\[shutdown\] done/);
});

// ─── Backup and restore drill ──────────────────────────────────

function withDb(url, dbName) { const u = new URL(url); u.pathname = `/${dbName}`; return u.toString(); }
const run = (script, args, env) => spawnSync("node", [path.join(ROOT, "scripts", script), ...args], { env: { ...process.env, PG_BIN, ...env }, encoding: "utf8" });

test("backup -> restore drill reproduces the data; the drill refuses production and non-empty targets", opts, async () => {
  const character = await makeCharacter(prisma);
  await prisma.content.create({ data: { title: "kept through the backup", characterId: character.id } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-backup-"));
  const scratch = `aif_restore_${Date.now()}`;
  const admin = new pg.Client({ connectionString: withDb(TEST_DB_URL, "postgres").split("?")[0] });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${scratch}`);
  try {
    const b = run("db-backup.mjs", [dir], { DATABASE_URL: TEST_DB_URL });
    assert.equal(b.status, 0, b.stderr);
    const host = new URL(TEST_DB_URL).host;
    assert.ok(!b.stdout.includes(host) && !b.stderr.includes(host), "no host or port in the output");
    const dump = fs.readdirSync(dir).find((f) => f.endsWith(".dump"));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, dump.replace(".dump", ".json")), "utf8"));
    assert.equal(manifest.counts.content, 1);
    assert.deepEqual(manifest.migrations, repoMigrations());

    const target = withDb(TEST_DB_URL, scratch);
    const same = run("db-restore-verify.mjs", [path.join(dir, dump)], { DATABASE_URL: TEST_DB_URL, RESTORE_DATABASE_URL: TEST_DB_URL });
    assert.equal(same.status, 1);
    assert.match(same.stderr, /only restores into a separate scratch database/);

    const ok = run("db-restore-verify.mjs", [path.join(dir, dump)], { DATABASE_URL: TEST_DB_URL, RESTORE_DATABASE_URL: target });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.match(ok.stdout, /RESTORE DRILL PASSED/);
    // The restored data is really there.
    const check = new pg.Client({ connectionString: target.split("?")[0] });
    await check.connect();
    const row = (await check.query(`SELECT title FROM aif_test.content`)).rows[0];
    await check.end();
    assert.equal(row.title, "kept through the backup");

    const again = run("db-restore-verify.mjs", [path.join(dir, dump)], { RESTORE_DATABASE_URL: target });
    assert.match(again.stderr, /target is not empty/);

    // A restore that does not reproduce the backup's rows fails the drill.
    await admin.query(`DROP DATABASE ${scratch} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${scratch}`);
    const mPath = path.join(dir, dump.replace(".dump", ".json"));
    fs.writeFileSync(mPath, JSON.stringify({ ...manifest, counts: { ...manifest.counts, content: 2 } }));
    const short = run("db-restore-verify.mjs", [path.join(dir, dump)], { RESTORE_DATABASE_URL: target });
    assert.equal(short.status, 2);
    assert.match(short.stderr, /RESTORE DRILL FAILED[\s\S]*content: backup had 2 rows, restore has 1/);
    fs.appendFileSync(path.join(dir, dump), "tampered");
    const tampered = run("db-restore-verify.mjs", [path.join(dir, dump)], { RESTORE_DATABASE_URL: target });
    assert.match(tampered.stderr, /checksum does not match/);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight is read-only and reports migrations, rows and blocking config by name", opts, async () => {
  await makeCharacter(prisma);
  const ready = run("preflight.mjs", [], { DATABASE_URL: TEST_DB_URL, OWNER_API_TOKEN: SECRET, FRONTEND_URL: "https://app.example.test" });
  assert.equal(ready.status, 0, ready.stderr + ready.stdout);
  assert.match(ready.stdout, /Migrations: all applied/);
  assert.match(ready.stdout, /characters=1/);
  assert.ok(!ready.stdout.includes(SECRET) && !ready.stdout.includes(new URL(TEST_DB_URL).host));
  const blocked = run("preflight.mjs", [], { DATABASE_URL: TEST_DB_URL, OWNER_API_TOKEN: "", FRONTEND_URL: "" });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /NOT READY[\s\S]*OWNER_API_TOKEN/);
  assert.equal(await prisma.character.count(), 1, "nothing was written");
});

// ─── Sponsor authorization ─────────────────────────────────────

test("campaign submissions need a recorded, authorized sponsor relationship with a disclosure", opts, async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma });
  try {
    const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
    const character = await makeCharacter(prisma);
    const camp = (await call("/api/campaigns", "POST", { name: "Synthetic campaign", brand: "Synthetic Co" })).body;
    const submit = () => call(`/api/campaigns/${camp.id}/submissions`, "POST", { character_id: character.id });
    assert.equal((await submit()).body.code, "SPONSOR_AUTHORIZATION_REQUIRED");

    const editor = (await createSessionStore(prisma).create({ id: "synthetic-editor", role: "editor", workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;
    const auth = { sponsorLegalName: "Synthetic Co Ltd", agreementReference: "Contract SC-2026-01 (signed PDF in Drive)", authorizedAt: "2026-11-01", disclosure: "#ad Paid partnership with Synthetic Co" };
    assert.equal((await app.raw(`/api/campaigns/${camp.id}/sponsor-authorization`, { method: "POST", token: editor, body: auth })).status, 403);
    const vague = await call(`/api/campaigns/${camp.id}/sponsor-authorization`, "POST", { ...auth, disclosure: "Thanks to our friends" });
    assert.ok(vague.body.details.fields.disclosure, "a disclosure must say it is paid promotion");
    assert.equal((await call(`/api/campaigns/${camp.id}/sponsor-authorization`, "POST", auth)).status, 200);
    assert.equal((await submit()).status, 201);

    // A different sponsor needs its own authorization.
    await call(`/api/campaigns/${camp.id}`, "PUT", { brand: "Other Brand" });
    assert.equal((await submit()).body.code, "SPONSOR_AUTHORIZATION_REQUIRED");
  } finally { await app.close(); }
});
