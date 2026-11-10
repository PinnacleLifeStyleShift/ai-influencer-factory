import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocal, localOf, offsetLabel } from "../src/lib/zonedTime.js";

// Daylight-saving edge cases for destination schedules (no database needed).
const iso = (r) => r.instants.map((d) => d.toISOString());

test("ordinary wall times resolve to one instant", () => {
  const r = resolveLocal("2026-07-01T09:00", "America/Los_Angeles");
  assert.equal(r.status, "ok");
  assert.deepEqual(iso(r), ["2026-07-01T16:00:00.000Z"]);
  assert.equal(offsetLabel(r.instants[0].getTime(), "America/Los_Angeles"), "UTC-07:00");
  assert.equal(localOf(r.instants[0].getTime(), "America/Los_Angeles"), "2026-07-01T09:00");
});

test("a time that happens twice (clocks go back) is ambiguous, earlier first", () => {
  const la = resolveLocal("2026-11-01T01:30", "America/Los_Angeles");
  assert.equal(la.status, "ambiguous");
  assert.deepEqual(iso(la), ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"]);
  const london = resolveLocal("2026-10-25T01:30", "Europe/London");
  assert.deepEqual(iso(london), ["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
  // Half-hour shift (Lord Howe Island).
  const lh = resolveLocal("2026-04-05T01:45", "Australia/Lord_Howe");
  assert.equal(lh.status, "ambiguous");
  assert.equal(lh.instants[1] - lh.instants[0], 30 * 60_000);
});

test("a time skipped by clocks going forward does not exist", () => {
  assert.equal(resolveLocal("2026-03-08T02:30", "America/Los_Angeles").status, "nonexistent");
  assert.equal(resolveLocal("2026-03-29T01:30", "Europe/London").status, "nonexistent");
  assert.equal(resolveLocal("2026-10-04T02:15", "Australia/Lord_Howe").status, "nonexistent");
  // The minute before the gap exists.
  assert.equal(resolveLocal("2026-03-08T01:59", "America/Los_Angeles").status, "ok");
});

test("invalid dates, formats and zones are refused", () => {
  for (const [l, z] of [["2026-02-30T09:00", "UTC"], ["2026-01-01 09:00", "UTC"], ["2026-01-01T24:00", "UTC"], ["2026-01-01T09:00", "Mars/Olympus"], ["2026-01-01T09:00", ""], ["2026-01-01T09:00", "PST"], ["2026-01-01T09:00", "EST"]]) {
    assert.equal(resolveLocal(l, z).status, "invalid", `${l} ${z}`);
  }
});
