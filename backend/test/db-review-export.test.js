import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem, futureSchedule } from "./db-helpers.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";
import { assertDeliverable } from "../src/services/calendar.js";

/**
 * Package E: schedule bound to approval (instant + zone), DST handling,
 * cancellation fencing, and export of exactly the approved version with
 * verified media. Synthetic media fixtures; disposable local Postgres; no
 * network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXTURES, f))).digest("hex");
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

async function withApp(fn, { store = createFixtureMediaStore(FIXTURES) } = {}) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma, mediaStore: store });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
const call = (app, p, { method = "GET", body, token = TOKEN } = {}) =>
  app.call(p, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
const as = (app, token, p, { method = "GET", body } = {}) => app.raw(p, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
const getItem = async (app, id) => (await call(app, `/api/pipeline/${id}`)).body;
const approve = async (app, id) => {
  const item = await getItem(app, id);
  const r = await call(app, `/api/pipeline/${id}/approve`, { method: "POST", body: { revision: item.revision, snapshotHash: item.snapshotHash } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.pipelineItem;
};
const roleToken = async (role) => (await createSessionStore(prisma).create({ id: `synthetic-${role}`, role, workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;
const videoItem = (overrides = {}) => makeReviewItem(prisma, {
  imageUrl: "https://example.test/still.png", videoUrl: "https://example.test/clip-5s.mp4",
  exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false }, ...overrides,
});

// ─── Schedule bound to approval ───────────────────────────────

test("the schedule instant and zone are part of the approved snapshot", opts, () => withApp(async (app) => {
  const raw = await videoItem();
  const approved = await approve(app, raw.id);
  const hashBefore = approved.snapshotHash;

  // Changing the time (even keeping the date) clears approval: version-bound.
  const later = { local: `${raw.scheduleLocal.slice(0, 11)}${raw.scheduleLocal.slice(11, 13) === "23" ? "22" : "23"}:00`, timezone: "America/Los_Angeles" };
  const edit = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { schedule: later } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.pipelineItem.stage, "review");
  assert.equal(edit.body.pipelineItem.approvalCurrent, false);
  assert.notEqual(edit.body.pipelineItem.snapshotHash, hashBefore);
  assert.equal((await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST" })).body.code, "INVALID_TRANSITION");

  // Same wall time in a different zone is a different instant: also a change.
  await approve(app, raw.id);
  const zone = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { schedule: { ...later, timezone: "America/New_York" } } });
  assert.equal(zone.body.pipelineItem.approvalCurrent, false);

  // A schedule edited behind the API's back is caught by the hash.
  await approve(app, raw.id);
  await prisma.pipelineItem.update({ where: { id: raw.id }, data: { scheduledAt: new Date(Date.now() + 40 * 86400_000) } });
  assert.equal((await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST" })).body.code, "APPROVAL_STALE");
}));

test("scheduling uses exactly the approved instant; a different date or no time is refused", opts, () => withApp(async (app) => {
  const none = await videoItem({ scheduledAt: null, scheduleTimezone: null, scheduleLocal: null, scheduledDate: null });
  await approve(app, none.id);
  assert.equal((await call(app, `/api/pipeline/${none.id}/schedule`, { method: "POST" })).body.code, "SCHEDULE_TIME_REQUIRED");

  const raw = await videoItem();
  await approve(app, raw.id);
  assert.equal((await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST", body: { scheduledDate: "2030-01-01" } })).body.code, "SCHEDULE_NOT_APPROVED");
  const ok = await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST", body: { scheduledDate: raw.scheduledDate } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.content.scheduledAt, raw.scheduledAt.toISOString());
  assert.equal(ok.body.content.scheduleTimezone, "America/Los_Angeles");
  assert.equal(ok.body.content.status, "scheduled");

  const past = await videoItem({ ...futureSchedule(-1) });
  await approve(app, past.id);
  assert.equal((await call(app, `/api/pipeline/${past.id}/schedule`, { method: "POST" })).body.code, "SCHEDULE_IN_PAST");
}));

test("daylight saving: ambiguous times need a choice, nonexistent times are refused", opts, () => withApp(async (app) => {
  const raw = await videoItem();
  const amb = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { schedule: { local: "2027-11-07T01:30", timezone: "America/Los_Angeles" } } });
  assert.equal(amb.status, 422);
  assert.equal(amb.body.code, "SCHEDULE_TIME_AMBIGUOUS");
  assert.deepEqual(amb.body.details.options.map((o) => [o.ambiguity, o.utc, o.offset]), [
    ["earlier", "2027-11-07T08:30:00.000Z", "UTC-07:00"], ["later", "2027-11-07T09:30:00.000Z", "UTC-08:00"],
  ]);
  const later = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { schedule: { local: "2027-11-07T01:30", timezone: "America/Los_Angeles", ambiguity: "later" } } });
  assert.equal(later.status, 200);
  assert.equal(later.body.pipelineItem.scheduledAt, "2027-11-07T09:30:00.000Z");
  assert.equal(later.body.pipelineItem.scheduleLocal, "2027-11-07T01:30");

  const gap = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { schedule: { local: "2027-03-14T02:30", timezone: "America/Los_Angeles" } } });
  assert.equal(gap.status, 422);
  assert.equal(gap.body.code, "SCHEDULE_TIME_NONEXISTENT");
  const badZone = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { schedule: { local: "2027-03-14T09:00", timezone: "PST" } } });
  assert.equal(badZone.status, 400);
  const stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
  assert.equal(stored.scheduledAt.toISOString(), "2027-11-07T09:30:00.000Z", "refused edits change nothing");
}));

// ─── Cancellation fences delivery ─────────────────────────────

test("cancelling a schedule fences delivery and needs a new approval to reschedule", opts, () => withApp(async (app) => {
  const raw = await videoItem();
  await approve(app, raw.id);
  const s = (await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST" })).body;
  const contentId = s.content.id;
  assert.ok(await assertDeliverable(prisma, contentId), "a live schedule passes the fence");

  // The calendar cannot be used to cancel or delete around the fence.
  assert.equal((await call(app, `/api/content/${contentId}`, { method: "PUT", body: { status: "cancelled" } })).body.code, "USE_CANCEL_SCHEDULE");
  assert.equal((await call(app, `/api/content/${contentId}`, { method: "DELETE" })).body.code, "USE_CANCEL_SCHEDULE");
  assert.equal((await call(app, `/api/pipeline/${raw.id}`, { method: "DELETE" })).body.code, "ALREADY_SCHEDULED");

  const reviewer = await roleToken("reviewer");
  assert.equal((await as(app, reviewer, `/api/pipeline/${raw.id}/cancel-schedule`, { method: "POST", body: { reason: "nope" } })).status, 403);
  assert.equal((await call(app, `/api/pipeline/${raw.id}/cancel-schedule`, { method: "POST", body: {} })).status, 400, "reason required");

  const c = await call(app, `/api/pipeline/${raw.id}/cancel-schedule`, { method: "POST", body: { reason: "Holiday clash" } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.content.status, "cancelled");
  assert.equal(c.body.content.cancelReason, "Holiday clash");
  assert.equal(c.body.pipelineItem.stage, "review");
  assert.equal(c.body.pipelineItem.approvalCurrent, false);
  await assert.rejects(assertDeliverable(prisma, contentId), { code: "SCHEDULE_CANCELLED" });
  assert.equal((await call(app, `/api/pipeline/${raw.id}/cancel-schedule`, { method: "POST", body: { reason: "again" } })).body.code, "INVALID_TRANSITION");
  // A cancelled approval cannot export either.
  assert.equal((await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).body.code, "EXPORT_NOT_APPROVED");

  // Re-approve and reschedule: a new entry; the cancelled one stays cancelled.
  await approve(app, raw.id);
  const again = await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST" });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.content.id, contentId);
  assert.equal((await prisma.content.findUnique({ where: { id: contentId } })).status, "cancelled");
  await assert.rejects(assertDeliverable(prisma, contentId), { code: "SCHEDULE_CANCELLED" });

  // A change sneaked in behind a live schedule also fails the fence.
  await prisma.pipelineItem.update({ where: { id: raw.id }, data: { caption: "tampered" } });
  await assert.rejects(assertDeliverable(prisma, again.body.content.id), { code: "APPROVAL_STALE" });
}));

// ─── Export ───────────────────────────────────────────────────

const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

test("export: approved version only, verified media, identical on repeat, superseded after a change", opts, () => withApp(async (app) => {
  const raw = await videoItem({ caption: "Calm mornings, fictional coach", hashtags: "#calm #synthetic" });
  assert.equal((await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).body.code, "EXPORT_NOT_APPROVED");
  await approve(app, raw.id);

  const first = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const m = first.body.export.manifest;
  assert.equal(m.media.length, 1);
  assert.deepEqual([m.media[0].mime, m.media[0].width, m.media[0].height, m.media[0].durationSec], ["video/mp4", 1080, 1920, 5]);
  assert.equal(m.media[0].sha256, sha("clip-5s.mp4"), "checksum of the real bytes");
  assert.equal(m.disclosure, "This is a fictional, AI-generated character.");
  assert.equal(m.destination.platform, "Instagram");
  assert.equal(m.destination.schedule.utc, raw.scheduledAt.toISOString());
  assert.match(m.destination.schedule.note, /nothing has been published/);
  for (const k of ["prompt", "motionPrompt", "imagePrompt", "providerRequestId", "reservationId", "generationClaim", "reviewNotes", "notes"]) {
    assert.ok(!keysDeep(m).has(k), `manifest must not contain ${k}`);
  }

  const second = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.export.manifestHash, first.body.export.manifestHash, "same approved content, same manifest");
  assert.equal(await prisma.exportManifest.count(), 1);

  const dl = await app.call(`/api/pipeline/${raw.id}/exports/${first.body.export.id}/download`, { token: TOKEN });
  assert.equal(dl.headers.get("x-export-current"), "true");
  assert.match(dl.headers.get("content-disposition"), /attachment; filename="export-.*\.json"/);
  assert.deepEqual(await dl.json(), m);
  const txt = await (await app.call(`/api/pipeline/${raw.id}/exports/${first.body.export.id}/download?format=text`, { token: TOKEN })).text();
  assert.match(txt, /Planned only; not published/);
  assert.match(txt, new RegExp(sha("clip-5s.mp4")));

  // After any change the old export is superseded and the stale approval cannot export.
  await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { caption: "Changed" } });
  const list = (await call(app, `/api/pipeline/${raw.id}/exports`)).body;
  assert.equal(list[0].current, false);
  const oldTxt = await (await app.call(`/api/pipeline/${raw.id}/exports/${first.body.export.id}/download?format=text`, { token: TOKEN })).text();
  assert.match(oldTxt, /SUPERSEDED/);
  assert.equal((await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).body.code, "EXPORT_NOT_APPROVED");
  await prisma.pipelineItem.update({ where: { id: raw.id }, data: { stage: "approved" } }); // forged stage, old approval cleared
  assert.equal((await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).body.code, "APPROVAL_STALE");
}));

test("export refuses broken, truncated, mislabelled or wrongly shaped media (no success, nothing recorded)", opts, () => withApp(async (app) => {
  const cases = [
    [{ videoUrl: "https://example.test/missing.mp4" }, /broken link/],
    [{ videoUrl: "https://example.test/truncated.mp4" }, /truncated/],
    [{ videoUrl: null, imageUrl: "https://example.test/fake.png" }, /not a recognised/],
    [{ videoUrl: "https://example.test/still.png" }, /expected video/],
    [{ exportSettings: { format: "mp4", aspectRatio: "16:9", burnInCaptions: false } }, /aspect ratio/],
    [{ videoUrl: "https://cdn.provider.invalid/clip.mp4" }, /not in the synthetic media store/],
  ];
  for (const [overrides, problem] of cases) {
    const raw = await videoItem(overrides);
    await approve(app, raw.id);
    const r = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
    assert.equal(r.status, 422, JSON.stringify(overrides));
    assert.equal(r.body.code, "EXPORT_MEDIA_INVALID");
    assert.match(r.body.details.failures[0].problems.join(" "), problem);
  }
  assert.equal(await prisma.exportManifest.count(), 0);
}));

test("export without configured media storage says so instead of claiming success", opts, async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma }); // default: disabled store
  try {
    const raw = await videoItem();
    await approve(app, raw.id);
    const r = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
    assert.equal(r.body.code, "MEDIA_STORE_NOT_CONFIGURED");
    assert.equal(await prisma.exportManifest.count(), 0);
  } finally { await app.close(); }
});

test("export permissions: reviewers can read exports but not create them", opts, () => withApp(async (app) => {
  const raw = await videoItem();
  await approve(app, raw.id);
  const reviewer = await roleToken("reviewer");
  const editor = await roleToken("editor");
  assert.equal((await as(app, reviewer, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).status, 403);
  assert.equal((await as(app, reviewer, `/api/pipeline/${raw.id}/exports`)).status, 200);
  assert.equal((await as(app, editor, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).status, 201);
}));

test("export records provenance and the actual known cost, and needs publication rights for references sent", opts, () => withApp(async (app) => {
  const raw = await videoItem();
  const res = await prisma.generationReservation.create({ data: {
    provider: "mockvid", model: "synthetic-v1", amountMicros: 1_000_000n, actualMicros: 800_000n, state: "settled",
    day: "2026-11-10", month: "2026-11", currency: "USD", priceVersion: "fixture-v1", capTimezone: "UTC", idempotencyKey: "exp-cost-1",
  } });
  const image = await prisma.characterImage.create({ data: { characterId: raw.characterId, imageUrl: "https://example.test/ref.png", status: "reference", source: "manual", fingerprint: "f".repeat(64) } });
  await prisma.generationApplication.create({ data: {
    reservationId: res.id, pipelineItemId: raw.id, kind: "video", mediaUrl: raw.videoUrl, revision: raw.revision,
    characterVersionId: raw.characterVersionId, promptHash: "p".repeat(64), referencesSent: [image.fingerprint], conditioning: "references_sent",
  } });
  await prisma.rightsRecord.create({ data: { imageId: image.id, basis: "owned_original", holder: "Synthetic Studio", permittedUses: ["provider_input"], recordedBy: "owner", approvedBy: "owner", approvedAt: new Date() } });
  await approve(app, raw.id);

  const blocked = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
  assert.equal(blocked.body.code, "RIGHTS_INCOMPLETE", "provider_input alone does not permit publication");

  await prisma.rightsRecord.create({ data: { imageId: image.id, basis: "owned_original", holder: "Synthetic Studio", permittedUses: ["provider_input", "publication"], recordedBy: "owner", approvedBy: "owner", approvedAt: new Date(), recordedAt: new Date(Date.now() + 1000) } });
  const ok = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const f = ok.body.export.manifest.media[0];
  assert.equal(f.provider, "mockvid:synthetic-v1");
  assert.deepEqual(f.cost, { currency: "USD", actualMicros: 800_000, status: "actual", priceVersion: "fixture-v1" });
  assert.deepEqual(f.inputs.referencesSent, [image.fingerprint]);
  assert.equal(ok.body.export.manifest.cost.actualKnownMicros, 800_000);
  assert.deepEqual(ok.body.export.manifest.rights.map((r) => [r.basis, r.permittedUses.includes("publication")]), [["owned_original", true]]);
  assert.ok(!JSON.stringify(ok.body.export.manifest).includes("ref.png"), "reference images themselves are not exported");
}));

test("multi-shot package: lengths measured from the files, then exported per shot", opts, () => withApp(async (app) => {
  const shotMedia = [
    { shotIndex: 0, shotKey: "a", kind: "video", url: "https://example.test/clip-5s.mp4", durationSec: 5, durationSource: "requested", reservationId: null },
    { shotIndex: 1, shotKey: "b", kind: "video", url: "https://example.test/clip-10s.mp4", durationSec: 5, durationSource: "requested", reservationId: null },
  ];
  const raw = await videoItem({ shotMedia });
  // The recorded 5 s for shot 2 disagrees with its 10 s file: export refuses.
  await approve(app, raw.id);
  const wrong = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
  assert.equal(wrong.body.code, "EXPORT_MEDIA_INVALID");
  assert.match(wrong.body.details.failures[0].problems[0], /differs from the file's 10s/);

  const measured = await call(app, `/api/pipeline/${raw.id}/measure-media`, { method: "POST" });
  assert.equal(measured.status, 200, JSON.stringify(measured.body));
  assert.deepEqual(measured.body.results.map((r) => r.durationSec), [5, 10]);
  const item = await getItem(app, raw.id);
  assert.equal(item.stage, "review", "measuring changes the package, so approval is cleared");
  assert.deepEqual(item.shotMedia.map((m) => m.durationSource), ["measured", "measured"]);

  await approve(app, raw.id);
  const ok = await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.export.manifest.media.map((f) => [f.role, f.shotIndex, f.durationSec]), [["shot", 0, 5], ["shot", 1, 10]]);
}));
