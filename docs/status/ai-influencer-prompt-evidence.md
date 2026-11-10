# Evidence packet: AI Influencer project prompt (10 November 2026)

This is the response to the owner's AI Influencer project prompt and the implementation specification of 10 November. **Base:** PR #9 head `fb53e4c`. **Final:** `main` at `2851948` (PRs #1–#16 merged on 10 November 2026).

Statuses are kept separate, as the prompt requires:

- **Code present.**
- **Locally tested.**
- **Hosted CI:** green at the exact head.
- **Deployed:** `2851948` on both Railway services (api and frontend), 10 November 2026. Production database migrated (all 16 migrations applied). **The API refuses every request until the owner sets `OWNER_API_TOKEN`.**
- **Accepted by the intended user:** none yet.

## PRs added for this prompt (all merged into `main`)

| PR | Branch | Package | Locally tested | Hosted CI |
| --- | --- | --- | --- | --- |
| [#10](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/10) | `pkg-i-route-authorization` | 1: route-bound authorization (release blocker) | Full suite + 8 browser checks | Green `209a556` |
| [#11](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/11) | `pkg-j-reconciliation-cas` | Reconciliation compare-and-swap (publishing defect) | Full suite 188/188 + 8 browser checks | Green `dc0f850` |
| [#12](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/12) | `pkg-k-rights-revocation` | 2: revocation holds, pre-submit rights recheck, shot-plan edges | 194/194 (isolated worktree) | Green `90f70fc` |
| [#13](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/13) | `pkg-l-media-assembly` | 4: AssetVersion, deterministic assembly | 199/199 + 8 browser checks (isolated) | Green `8036d58`; **5 assembly tests skipped there (no ffmpeg)**; ffmpeg added to CI in #14 |
| [#14](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/14) | `pkg-m-operations` | Operations, kill switch, redaction, migration gates | Browser checks 8/8 (isolated); backend fix for 3 unit tests included | Green `aa55c64`: 206/206, 0 skipped |
| [#15](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/15) | `pkg-n-strict-contracts` | Unknown-field refusal, export request contract, export integrity, retention policy | 210/210 | Green `8bc5fe6`: 210/210, 0 skipped |
| [#16](https://github.com/PinnacleLifeStyleShift/ai-influencer-factory/pull/16) | `fix-migrate-empty-history` | Fix for the first production migration (see below) | Migration tests 10/10 | Green `0d8ca61` |

## Story and acceptance matrix

| Story / AC | Status | Evidence (tests) |
| --- | --- | --- |
| IF01-01 route variants cannot bypass generate/spend/admin | Done (#10) | `auth-route-matrix`: 9 variant types × roles and sessions |
| IF01-02 denied mutations write nothing, reserve nothing, call no provider | Done (#10) | `auth-route-matrix` row snapshot + provider count |
| IF02-01/02 reload resolves the pinned version; editing a character doesn't change approved packages | Done (earlier PRs #3/#4) | `db-characters` |
| IF03-01 expired/unsupported rights block before reservation | Done; **also rechecked right before submission** (#12) | `db-characters` revocation tests |
| IF03-02 revocation flags unpublished packages without rewriting history | Done (#12) | `db-characters` revocation test |
| IF04-01/02 a source-free concept has no measured rank; a missing citation stays unsupported | Done (#4) | `db-packages` |
| IF05-01/02 concurrent saves conflict; a script change clears approval | Done (#4) | `db-packages` |
| IF06-01/02 durations, duplicates, missing references; reorder changes the digest | Done (#4, edge tests in #12) | `shot-plan-edges`, `db-packages` |
| IF07-01/02 caps across processes; same key/different payload conflicts; expired rights stop before reserving | Done (#5, #12) | `db-jobs`, `db-generation-races`, `db-characters` |
| IF08-01/02 a crash at each boundary never re-buys; a stale worker can't overwrite | Done (#5) | `db-jobs` |
| IF09-01 the approved hash binds rendered assets and presentation fields | Done (#6, rendered file in #13) | `db-review-export`, `db-assembly` |
| IF09-02 playback duration independently measured | Done: ffmpeg full decode plus container measurement (#13). **Browser playback not tested** (Chromium has no H.264) | `db-assembly` |
| IF10-01/02 DST gaps/folds need a choice; a passed time never means published | Done (#6) | `zoned-time`, `db-review-export` |
| IF11-01/02 stale approval or missing media blocks ready; repeat export gives identical hashes | Done (#6, #13) | `db-review-export`, `db-assembly` |
| IF12-01 parallel resolutions give one decision | Done (#11) | `db-reconciliation-race` (two PostgreSQL connections) |
| IF12-02 no sensitive payload or bootstrap token in logs or operations views | Done (#14); a query-string leak found and fixed | `db-operations` secret markers |
| IF13-01 an unavailable provider doesn't fall back | Done (gate, earlier) | `generation-gate` |
| IF13-02 expired storage links and quota failures keep accurate state | **Partial:** missing, oversized or replaced media keep accurate state, and exports re-verify their files (#15). No signed links exist (storage not approved) | `db-assembly`, `db-review-export`, `db-contracts` |
| Package 1: reject unknown security-sensitive fields | Done (#15) | `db-contracts` |
| Package 4: export with expected revision, approval and state | Done (#15): `expectedRevision` + `approvedHash`, `exportId`, `state` (synchronous: ready or an error) | `db-contracts` |
| Operations: retention defined per category; provenance deletion never looks complete | Done as a typed owner decision: unset means nothing is deleted. Export verification reports deleted or replaced files (#15) | `db-contracts` |
| IF14-01 opposing resolutions race: one commits, no duplicate audit | Done (#11) | `db-reconciliation-race` |
| IF14-02 mixed-case/trailing-slash publishing endpoints enforce the same permission | Done (#10) | `auth-route-matrix` |
| IF15-01 an absent analytics adapter leaves metrics unknown | Done (#8) | `db-measurement` |
| IF15-02 route variants can't let an editor approve sponsorship | Done (#10; sponsor gate in #9) | `auth-route-matrix`, `db-ops` |

## Real versus mock capability matrix

| Capability | State |
| --- | --- |
| Authentication | Owner-token bootstrap → server sessions; owner role only (login provider: owner decision) |
| Paid image/video generation | Interface + mocks; **off** (`LIVE_PROVIDER_CALLS`; prices, caps, provider and model are owner decisions) |
| Provider status lookup | Mock only; no real adapter declares it |
| Media storage | Synthetic local fixture store only; real storage not approved |
| Local assembly | Real ffmpeg where installed and enabled; **unavailable on the production images** (no ffmpeg) |
| Publishing | Interfaces + simulation; no real publisher |
| Platform analytics | Interface only; no provider |
| Campaign money | Real records (planned, invoiced, received), entered by the owner |
| Backups and restore drill | Scripts tested against PostgreSQL 16; never run against production |

## Migration and restore evidence (TESTED LOCALLY)

- **Migrations:** 16 committed, all additive except the one documented data change (static test).
- **Rehearsed cases:** a fresh database, a populated 277d2d3 baseline, the full stacked sequence, repeated invocation, deliberate drift, **a partially applied migration with recovery**, and **an older secure revision against the newest schema**.
- **Restore:** a backup → restore drill with row-count and migration verification, including refusals (the production target, a non-empty target, a tampered dump, missing rows).

## First production deploy (DEPLOYED)

1. **Merging #1–#15 deployed `5928246`. The API deploy failed at the migration step.** The production database already had an empty `_prisma_migrations` table, so the migration script skipped its baseline check. The baseline migration then hit `relation "characters" already exists` on its first statement. Nothing changed except one failed bookkeeping row, and the `277d2d3` API kept serving.
2. **#16 fixed the detection and deployed `2851948`:**
   - schema verified identical to the 277d2d3 baseline;
   - failed attempt marked rolled back;
   - baseline recorded as applied;
   - 15 migrations applied (`[migrate] Done.`);
   - `/ready` healthcheck passed.
3. **Startup configuration log:**
   - `OWNER_API_TOKEN` not set (ERROR: every `/api` route refuses requests);
   - `LIVE_PROVIDER_CALLS` and `LIVE_PUBLISHING` disabled;
   - media store and media assembly not configured;
   - retention unset (nothing deleted).
4. **Not yet observed in production:** an unauthenticated request being refused. This session cannot reach the Railway hosts, and no traffic had arrived yet.

## Captures (synthetic data)

Desktop and phone captures are in `docs/screenshots/`. New in this round: `pkg-m-operations.png`. The review/export screen has both a desktop and a 390 px phone capture.

**Paper handoff not done:** there was no access to the Paper artboards, so screens were built from the text contracts.

## Not run / remaining holds

- **Not run:** anything against production or live providers; browser video playback (Chromium has no H.264); signed-link expiry (no signed links exist).
- **Remaining owner actions:**
  1. **`OWNER_API_TOKEN`:** set it on the api service (at least 32 random characters). Until then the API refuses all requests.
  2. **Private media storage:** approval and its retention policy.
  3. **ffmpeg in production:** whether the API image should include it.
  4. **Paid generation:** provider/model approval, prices, caps.
  5. **Login provider, publishing accounts, analytics access.**
  6. **Provider keys:** the api service still holds keys from the old build. The owner chose to keep them; they are unused while `LIVE_PROVIDER_CALLS` is unset.
- **Next safe action:**
  1. The owner sets `OWNER_API_TOKEN`.
  2. Then check that `/api/characters` without a session returns 401, and that signing in with the token works.
  3. Then run the synthetic export workflow on the released revision.
