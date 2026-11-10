# ADR 0004: Ideas with provenance, versioned scripts, shot plans and content packages

Status: accepted (reversible). Date: 2026-11-09.

## Ideas

- **Three kinds** (`trends.kind`):
  - `manual_idea`: the operator's own idea.
  - `observation`: requires `sourceUrl` (safe https), `observedAt` (not in the future), `platform` and the exact `observation` text. Nothing is fetched by the server.
  - `simulated_fixture`: the old generator, labelled at the API and in the UI ("Simulated, not a real trend").
- **Scores:** `trendScore` is now nullable, and **no route writes a number into it**. The migration clears the random scores on existing fixture rows. The list is ordered by creation time, not score.
- **UI:** "Discover Trends" is renamed "Generate simulated ideas", and a manual-idea input is added.

## Scripts and shot plans

- **Versions:** each edit (`PUT /api/pipeline/scripts/:id`, with `expectedVersion` for optimistic concurrency) creates an immutable `script_versions` row. The row holds hook, body, CTA, speaking pace (80–240 wpm), target length (5–180 s), evidence entries and the **shot plan**.
- **The shot plan** has one shot for the hook, one per body sentence and one for the CTA. Each shot has:
  - its length: speech time at the chosen pace (at least 1.5 s), plus visual hold time spread evenly only to reach the target;
  - scene and visual action (from the pinned character version's styling);
  - dialogue, caption and transition;
  - the character version and reference fingerprints;
  - audio: voice only, no third-party music.
- **Length checks:**
  - **Tolerance: ±max(1 s, 10 % of the target).**
  - A script whose speech alone exceeds the target is **flagged, never relabelled**.
- **Re-pinning:** unscheduled items move to the new version, which bumps their revision and clears approval. Shot media is kept only for shots whose content (dialogue, action, scene) is unchanged. Scheduled items keep the version they were approved with, and edits are refused while a generation for the script's items is running.

## Content package

- **Fields:** a pipeline item pins `scriptVersionId`, and carries `shotMedia` (per shot: clip URL, length, `durationSource`, reservation), a `disclosure` (default: "This is a fictional, AI-generated character.") and `exportSettings`. **All of these are in the approval snapshot hash**, so any change, including a background generation, clears approval.
- **Per-shot generation:**
  - `POST /api/pipeline/generate-content { type: "video", shotIndex }` reuses the fenced, idempotent workflow (separate keys per shot).
  - It requests a 5 s or 10 s clip, whichever covers the shot, and records whether the clip's length was **reported** by the provider or only **requested**.
- **Measured length:** the sum, over shots, of the part of each clip the shot uses. It counts as **verified** only when every length was reported.
- **Approval of a multi-shot package needs** every shot covered, the measured total within tolerance, and verified lengths. Real adapters do not report length yet, so this needs a measurement step on stored media (Package E).
- **Package view:** `GET /api/pipeline/:id/package` returns the storyboard, script, media status, length checks, claims check, disclosure, destination, export settings, caption and hashtags. The UI re-reads it after every action, so it survives refreshes and errors.
- **Composition:** "composed" here means an assembly of shots with clips. Rendering one output file is not built; it needs media storage, which needs approval.

## Claims

- **Approval requires** a non-empty disclosure (`DISCLOSURE_REQUIRED`) and a passing claims check (`CLAIMS_UNSUPPORTED`).
- **Factual lines** (percentages, studies or research, proven or clinical, guarantees, cures, money or weight figures, …) need an evidence entry with a source URL.
- **First-person experience lines** ("I tried", "my clients", "changed my life", …) need fiction framing: a disclosure naming the character as fictional, synthetic or AI-generated.
- **This scan is a floor, not a judge:** the operator review rubric still applies.
- **Why it matters:** the existing script generator's templates produce such lines (for example "How I went from struggling to thriving…").
