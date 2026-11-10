# Remediation: overnight review addendum of 10 November 2026 (AIF 1–3)

This is the response to the AI Influencer Factory section of the review addendum. **Base:** `main` at `022d448`. **Branch:** `aif-remediation`, PR #18.

> **Released 10 November 2026 at the owner's instruction ("Merge 18 and deploy"):** merged as `3fb3562` and deployed on both services. See "Release record" below.

## Source versus serving

| State | Revision | Notes |
| --- | --- | --- |
| Candidate | `e4ab51f` (head of `aif-remediation`) | Contains AIF 1–3 and two additive migrations. Hosted CI green (backend, frontend, browser, Docker). |
| Merged | `3fb3562` | PR #18. |
| Serving (api and frontend) | `3fb3562` | Checked through Railway deployment metadata. `OWNER_API_TOKEN` is present by variable name. `MEDIA_STORE` and `MEDIA_ASSEMBLY` are unset, so the assembly and export path is off in production. |

## Dispositions

| Issue | Disposition | Reproduced first (failing on `022d448`) | Now |
| --- | --- | --- | --- |
| **AIF 1** rights and cost lineage through assembly | Fixed: confirmed source defect, full integration reproduction | `db-lineage`: 7/7 failed. The rendered form of the paid shot exported with status 201, empty rights and cost 0. The raw path also counted one reused result as 5.50 instead of 2.00. | 7/7 pass |
| **AIF 2** period metrics by activity interval | Fixed: confirmed source defect, HTTP-level reproduction | `db-metric-intervals`: the full-day reading ending at the report end was missing, and late readings were dropped. | pass |
| **AIF 3** overlapping metric double counting | Fixed: confirmed source defect, HTTP-level reproduction | `db-metric-intervals`: a repeated window counted 200; daily plus weekly readings were summed; concurrent writes all stayed effective. | pass |

Before the fix, `db-metric-intervals` failed 9 of 10 tests. The cumulative-snapshot test already passed, because cumulative selection was correct.

### AIF 1: what changed

- **Lineage at assembly.** Assembly writes `asset_lineage_inputs` in the same transaction as the rendered `AssetVersion`. Each input clip gets a row with its checksum and a stable source:
  - a generation application, keyed by its reservation, from the shot's recorded `reservationId`, or else the item's application for that media;
  - another `AssetVersion` (nested assembly), which must belong to the same character;
  - `manual`: a clip with no generation record, treated exactly as the raw path treats it.

  An unverifiable source refuses the assembly. Nothing is matched by URL equality across items.
- **Export follows the lineage** (`src/services/assetLineage.js`). It checks cycles (named as such), depth (at most 8), character and deleted records.
  - The rendered file's bytes must equal the asset's recorded hash.
  - Missing lineage, a deleted generation record, a cycle or another character's asset returns `LINEAGE_UNVERIFIED`. It never becomes "rights-free" or "no cost".
- **Rights are re-checked at export** for every reference actually sent, through any nesting. The check uses the shared `missingForUse(…, "publication")` rule, so expired and **revoked** records now block. The previous export check did not look at `revokedAt`.
- **Cost counts each reservation once**, in either form (raw clips or rendered), per currency. Unknown actual cost is counted separately, never as zero. Mixed currencies are never added together: `actualKnownMicros` is null and `byCurrency` lists each.
- **Manifest is now `export-manifest@2`.** Rendered files carry `assembledFrom` (provider, conditioning, references, cost per input). Reservation ids stay out of the manifest. The readable manifest shows the total once.
- **Refunds and adjustments:** none are supported by the ledger today. The settled `actualMicros` is used.

### AIF 2 and AIF 3: what changed

- **Selection.**
  - Cumulative snapshots: still by snapshot time (`observedAt < end`).
  - Period readings: by activity interval (`periodStart < end` and `periodEnd > start`, half-open, in the report's time zone).
  - A reading recorded a week later still counts for its own day.
  - Partly overlapping readings are excluded, not prorated, and named in `warnings`.
- **Identity.** A window of a series is (subject, platform, metric, source, periodStart, periodEnd). `observedAt` and `recordedAt` are kept for provenance only.
  - The same value again is a replay.
  - A different value is a new row that supersedes the effective one (`superseded_at`, `superseded_by_id`), with history kept.
  - Writes take a per-window advisory lock, so concurrent writers leave exactly one effective reading.
- **Aggregation.** Overlapping windows of one series, or one window with different values, give `periodActivity.value = null` with a named `conflict`, and the source total becomes unavailable (`conflicts` count). Coverage is computed from the same effective set that is counted. Distinct platforms and posts remain separate series.
- **UI.** The Measurement screen shows "unavailable" or "not added" and the warnings. The browser check asserts the UI and the API agree.
- **Legacy duplicates.** Rows stored under the old identity:
  - equal values count once, with a warning;
  - differing values are reported as a conflict until the owner records a corrected reading.
  - `node scripts/metrics-classify-legacy.mjs` is a read-only dry run that lists them. Nothing is deleted.
- **Historical reports.** Reports produced before this change may have dropped end-of-window readings or double counted repeated ones. Treat them as qualified until regenerated. No production metrics were inspected.

## Migrations (additive)

- `20261111000000_metric_revisions`: two nullable columns and one index on `metric_observations`.
- `20261111010000_asset_lineage`: a new table, `asset_lineage_inputs`.

**Rollback:** the previous revision runs against this schema, since its columns and tables are unused there (covered by the existing rollback-compatibility test). Rolling back stops lineage checks; it does not lose data.

**Rendered assets from before this change** have no lineage, so they export only after being assembled again. Assembly is deterministic and records the lineage for the existing asset. Production has no rendered assets: assembly is off there.

## Commands and results (TESTED LOCALLY, PostgreSQL 16, Node 22, ffmpeg installed)

| Command | Result |
| --- | --- |
| `cd backend && npm test` (throwaway Postgres) | 230/230, 0 skipped (17 new tests) |
| `npm test` (vitest) | 13/13 |
| `npm run build` | ok |
| `npm run test:e2e` (8 browser flows) | 8/8. The Measurement flow now also checks overlapping readings (UI = API). |

**Mutation checks** (each broke one rule; tests failed):

| # | Rule broken | Tests failed |
| --- | --- | --- |
| M1 | Select period readings by `observedAt` | 8 |
| M2 | No supersession | 2 |
| M3 | Overlaps summed | 1 |
| M4 | No advisory lock | 1 |
| M5 | Rendered export skips lineage | 7 |
| M6 | Cost not de-duplicated (both places) | 2 |
| M7 | Revocation ignored | 1 |
| M8 | No cycle check | 1 |
| M9 | Another character's render allowed | 1 |

**Safety:**
- All tests block outbound network and assert zero external calls.
- The mock provider is not called; generation records are synthetic rows.
- `LIVE_PROVIDER_CALLS`, `LIVE_PUBLISHING`, `MEDIA_STORE` and `MEDIA_ASSEMBLY` stay unset in production.

**Environment difference:** the backup-drill test needs the repository's own throwaway cluster (`scripts/with-test-postgres.sh`). On an ad-hoc local database it fails the same way on unchanged code.

## Holds and owner decisions

- **Assembly and media storage** stay off until the owner approves activation, as AIF 1 requires.
- **Partial-overlap policy:** the policy is "exclude, do not prorate, warn". Prorating would need a decision on the source granularity.
- **Release request** (if wanted), for the head of `aif-remediation`:
  - **Services:** both (api and frontend).
  - **Migrations:** the two above, additive.
  - **User-visible changes:**
    - period reports count end-of-window and late readings;
    - repeated readings count once;
    - overlapping readings show as conflicts.
  - **Flags:** unchanged.
  - **Backup and rollback:** take a backup first; the previous revision is compatible.
  - **Post-release read-only checks:**
    - `/ready` returns 200;
    - an unauthenticated `/api/metrics/report` returns 401;
    - run the dry-run classification.

## Release record (DEPLOYED)

- **Merged and deployed:** `3fb3562`, 10 November 2026, about 16:30 UTC, api and frontend.
- **Migrations:** `20261111000000_metric_revisions` and `20261111010000_asset_lineage` applied (`[migrate] Done.`).
- **API:** started with no configuration error and passed the `/ready` health check.
- **Still disabled at startup:** `LIVE_PROVIDER_CALLS`, `LIVE_PUBLISHING`, `MEDIA_STORE` and `MEDIA_ASSEMBLY`; retention is unset (nothing deleted).
- **Backup:** no backup was taken immediately before this release; the release plan asked for one. The migrations are additive and the previous revision is compatible. The owner should take a backup now as a restore point.
- **Observed in production HTTP logs, before this release (`022d448`, token set):**
  - unauthenticated `GET /api/system/operations` returned 401;
  - `/health` and `/ready` returned 200.
- **Not yet run:**
  - the legacy-duplicate dry run (`scripts/metrics-classify-legacy.mjs`), which needs the production database URL from the owner's own machine;
  - an unauthenticated request against `3fb3562` specifically.
