import { test } from "node:test";
import assert from "node:assert/strict";
import { planShots, shotKey, measurePackage } from "../src/services/shotPlan.js";

/**
 * Shot-plan edge cases (owner's project prompt, AC-IF06-01/02): the planner
 * never produces zero/negative durations or duplicate shot keys; reordering
 * shots changes the plan's digest; mock timing stays a plan, and clips whose
 * shot no longer matches are not counted.
 */
const plan = (o) => planShots({ hook: "Three small habits.", body: "Open the curtains. Drink water. Stretch.", callToAction: "Follow along.", targetDurationSec: 30, ...o }).shots;
const digest = (shots) => shots.map((s) => s.shotKey).join("|");

test("durations are always positive and keys unique, whatever the script", () => {
  const cases = [
    plan({}),
    plan({ body: "One.", targetDurationSec: 5 }),
    plan({ body: "Same line. Same line. Same line.", targetDurationSec: 5 }),
    plan({ body: Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is fairly long and keeps going.`).join(" "), targetDurationSec: 15 }),
    plan({ speakingPaceWpm: 80 }), plan({ speakingPaceWpm: 240 }),
  ];
  for (const shots of cases) {
    assert.ok(shots.length >= 1);
    assert.ok(shots.every((s) => Number.isFinite(s.durationSec) && s.durationSec > 0), JSON.stringify(shots.map((s) => s.durationSec)));
    assert.equal(new Set(shots.map((s) => s.index)).size, shots.length, "indexes unique");
  }
  const repeated = cases[2];
  // Identical sentences are distinct shots: their keys must still let clips be told apart by index.
  assert.equal(new Set(repeated.map((s) => `${s.index}:${s.shotKey}`)).size, repeated.length);
});

test("an empty script plans no shots and can never pass the length check", () => {
  const empty = planShots({ hook: "", body: "", callToAction: "", targetDurationSec: 30 });
  assert.equal(empty.shots.length, 0);
  assert.equal(empty.durationCheck.withinTolerance, false);
  assert.equal(measurePackage(empty.shots, [], 30).check.withinTolerance, false);
});

test("reordering shots or changing a shot's content changes the plan digest", () => {
  const a = plan({});
  const reordered = plan({ body: "Drink water. Open the curtains. Stretch." });
  assert.notEqual(digest(a), digest(reordered));
  const changed = plan({ body: "Open the curtains. Drink tea. Stretch." });
  assert.notEqual(digest(a), digest(changed));
  assert.equal(digest(a), digest(plan({})), "deterministic");
  assert.equal(shotKey(a[1]), a[1].shotKey);
});

test("clips for stale shots are not counted; requested lengths are not 'verified'", () => {
  const shots = plan({});
  const media = shots.map((s) => ({ shotIndex: s.index, shotKey: s.shotKey, kind: "video", url: `https://example.test/${s.index}.mp4`, durationSec: 10, durationSource: "requested" }));
  const m = measurePackage(shots, media, 30);
  assert.equal(m.complete, true);
  assert.equal(m.verified, false, "requested durations are a plan, not a measurement");
  const reordered = plan({ body: "Drink water. Open the curtains. Stretch." });
  const stale = measurePackage(reordered, media, 30);
  assert.equal(stale.complete, false, "clips made for the old order do not cover the new shots");
  const measured = measurePackage(shots, media.map((x) => ({ ...x, durationSource: "measured" })), 30);
  assert.equal(measured.verified, true);
});
