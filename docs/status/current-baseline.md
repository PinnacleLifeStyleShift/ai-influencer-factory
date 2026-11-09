# Current baseline

Recorded 2026-11-09. Updated for branch `pkg-d-durable-jobs` (stacked on `pkg-c-content-packages` → `pkg-b-character-bible` → `pkg-a-identity-baseline` → PR #1).
No secret values appear here; Railway variables are listed by name only.

Evidence labels:

- **VERIFIED SOURCE**: read in the repository at the stated commit.
- **TESTED LOCALLY**: run in a development container against a throwaway local Postgres with mocked providers.
- **HOSTED CI**: GitHub Actions at the exact commit (checked out and asserted).
- **AUTHOR-REPORTED**: stated in PR text, not independently re-run.
- **DEPLOYED**: read from Railway's deployment records.
- **LIVE-VERIFIED**: observed against the running service. *Nothing is live-verified:* the development sandbox cannot reach Railway hosts.

## Commits

| Item | Value | Evidence |
| --- | --- | --- |
| `main` | `277d2d38c55b8be262c9059ac8dbd78a7b95bbdd` | VERIFIED SOURCE |
| PR #1 head (`phase1-local-safety-foundation`) | `10704fa31017c7b5798bdd516e9b6cb7165eccce` | VERIFIED SOURCE, HOSTED CI (Tests + Docker build green) |
| This branch | based on `10704fa`; head commit shown in its PR | VERIFIED SOURCE |
| PR #1 merged | No | VERIFIED SOURCE |

## Deployment (Railway project `ai-influencer-factory`, environment `production`)

| Service | Deploys from | Builder | Deployed commit | Evidence |
| --- | --- | --- | --- | --- |
| `api` (root `/backend`) | `main`, automatic | Railpack | `277d2d3` (2026-03-21) | DEPLOYED |
| `ai-influencer-factory` (frontend) | `main`, automatic | Railpack | `277d2d3` (2026-03-21) | DEPLOYED |

- **Variables on `api`:** `DATABASE_URL`, `FAL_KEY`, `HIGGSFIELD_API_KEY`, `HIGGSFIELD_SECRET`, `KLING_ACCESS_KEY`, `KLING_SECRET_KEY`, `LEONARDO_API_KEY`, `RAILWAY_DOCKERFILE_PATH`. `OWNER_API_TOKEN` and `FRONTEND_URL` are **not set**. (DEPLOYED)
- **Variables on the frontend service:** `VITE_API_URL`. (DEPLOYED)
- **Database:** the project has eight Postgres services. Which one `DATABASE_URL` targets has **not been verified** (that would mean reading a secret value).
- **Known production exposure:** the deployed `277d2d3` API has no authentication, defaults CORS to `*`, and has provider keys set (VERIFIED SOURCE + DEPLOYED). Railway HTTP logs, retained from 2026-10-29, show scanner traffic and no calls to real routes (DEPLOYED logs). **No code in PR #1 or this branch secures the live API until it is deployed and live-verified.**

## Migrations (`backend/prisma/migrations`)

| Migration | Contents | Evidence |
| --- | --- | --- |
| `20260321000000_init` | Baseline = schema deployed at `277d2d3` | VERIFIED SOURCE, TESTED LOCALLY (baseline/drift tests) |
| `20261108000000_phase1_safety` | Approval, schedule, ledger, character images (additive) | TESTED LOCALLY, HOSTED CI |
| `20261109000000_generation_fencing` | Claims, `generation_applications` (additive) | TESTED LOCALLY, HOSTED CI at `10704fa` |
| `20261110000000_sessions` | `sessions` table (additive), this branch | TESTED LOCALLY |
| `20261110010000_audit_events` | `audit_events` table (additive) | TESTED LOCALLY, HOSTED CI at `8ce8ace` |
| `20261110020000_character_versions_rights` | Versions, rights, pins, recorded inputs (additive), Package B | TESTED LOCALLY, HOSTED CI at `1cfcf9d` |
| `20261110030000_content_packages` | Idea kinds, script versions, package fields; nullable trend score (fixture scores cleared), Package C | TESTED LOCALLY, HOSTED CI at `7e64744` |
| `20261110040000_generation_jobs` | Jobs, steps, reconciliation records; pricing context on reservations (additive), Package D | TESTED LOCALLY |

Deploy path: `npm start` → `scripts/migrate-deploy.mjs`. It verifies a pre-migration database is identical to the baseline before recording it, and refuses otherwise. Rollback with Railway's button alone does not work after migration (the old image's `db push` refuses); this was re-tested at `10704fa`. See the deployment checklist doc.

## Tests at this branch (TESTED LOCALLY)

- Backend `npm test`: 127/127 pass, 0 skipped.
- Frontend vitest: 10/10 pass.
- `vite build` passes.
- Playwright UI auth, character-bible, content-package and generation-jobs checks: pass.
- `npm audit`: 0 vulnerabilities in both packages.
- Both workflows run on this branch's PR; see its checks for HOSTED CI results at the exact head.

Not run here: Docker image builds (no Docker daemon in the sandbox; covered by the Docker build workflow), and anything against the live service.

## Package A exit criteria

| Criterion (brief section 5) | Status | Evidence |
| --- | --- | --- |
| Authenticated CRUD works with safe local fixtures | Met | TESTED LOCALLY (db-routes, db-hardening, db-auth) |
| Auth-provider interface, sessions, revocation, server-side authorization | Met | ADR 0001; db-auth tests |
| Absent / invalid / expired / revoked credentials refused | Met | db-auth tests |
| Wrong object IDs answer 404 | Met | db-auth, db-hardening tests |
| Wrong workspace | Not applicable yet: single workspace by design (ADR 0001) | Open for multi-workspace |
| Unauthorized generation/export fails before any provider action | Met for generation; no export route exists yet (Package E) | db-auth (`spend` refused, 0 provider calls) |
| Health discloses only health | Met | db-auth test |
| CORS is an origin policy, not authentication | Met | auth-cors tests |
| Rate limits, request schemas, body size limits, safe errors | Met (in-memory, per-process limits) | db-hardening, routes tests; ADR 0002 |
| Upload type/size limits | No upload route exists; requirement recorded for B/E | ADR 0002 |
| SSRF checks for external asset URLs | Met for input and stored provider URLs; DNS check ready for fetch points | url-safety tests |
| Stable codes, correlation IDs, no provider payloads in errors | Met | db-auth, db-hardening tests |
| Tokens out of logs, bundles, URLs; browser history/analytics | Met | e2e (owner token never stored or in URL), bundle check in CI, ADR 0002 |
| Old production URLs cannot be silently selected | Met | frontend tests, CI bundle check |
| Migrations and Docker images pass on the exact head | HOSTED CI on each push | PR checks |
| Audit evidence for actions | Met (best effort, redacted) | db-hardening tests; ADR 0002 |
| Production exposure secured | **Not met.** It needs the approved deployment and live verification | See "Known production exposure" |

## Package B exit criteria

| Criterion (brief section 6) | Status | Evidence |
| --- | --- | --- |
| A character can be versioned and recovered after reload | Met | db-characters (fresh client reads history); character-bible e2e (reload) |
| Reference history is intact | Met | db-characters (replaced reference kept; old versions keep their pins) |
| Generated artifacts record their actual inputs | Met (version or draft hash, prompt hash, references sent, conditioning) | db-characters |
| Unauthorized or unsupported reference use is blocked with an explanation | Met, before any claim, reservation or provider call | db-characters (REFERENCE_NOT_CLEARED with missing items; REFERENCE_CONDITIONING_UNSUPPORTED) |
| Content pins character version; identity changes cannot alter old content | Met; the version is part of the approval hash | db-characters (older pinned version; re-pin invalidates approval) |
| Rights/consent record instead of a checkbox | Met (append-only, owner-approved, expiry, likeness consent) | db-characters |
| Duplicate clicks, failures before/after provider, cross-character promotion | Covered by existing and new tests | db-routes, db-generation-races, db-characters |
| Operator review rubric | Written | docs/review-rubric.md |
| Real reference conditioning / identity quality | **Not met.** No approved adapter sends references; needs a provider decision and a human pilot | ADR 0003 |

## Package C exit criteria

| Criterion (brief section 7) | Status | Evidence |
| --- | --- | --- |
| A mocked 30-second package is composed from a coherent shot plan, with measured duration within a documented tolerance | Met with mocks (tolerance ±max(1 s, 10 %); lengths reported by the mock provider) | db-packages "mocked 30-second package" |
| Every claim has a source or fictional framing | Met as a pattern-based gate before approval (a floor, not a judge) | db-packages claims test; ADR 0004 |
| A fixture cannot be mistaken for a real trend | Met: kind at API and UI, no scores, label "Simulated, not a real trend" | db-packages ideas test; content-package e2e |
| Edits create version history and invalidate old approval | Met (script versions; re-pin bumps revision; background shot generation clears approval) | db-packages |
| Source-backed observations: URL, time, platform, exact observation | Met (no server-side fetching) | db-packages |
| Script editing: hook, body, CTA, pace, target length, evidence | Met | db-packages; content-package e2e |
| Shot plan with per-shot fields; planned-length mismatch flagged | Met | db-packages (long script flagged) |
| Package view survives refresh and errors | Met | content-package e2e (reload) |
| Regeneration and replacement are explicit | Met (per-shot generate/regenerate; script edits keep unchanged shots' clips) | db-packages |
| Rendering one output file / measuring real media | **Not met.** Needs media storage (approval) and a measurement step (Package E) | ADR 0004 |

## Package D exit criteria

| Criterion (brief section 8) | Status | Evidence |
| --- | --- | --- |
| Durable job states: queued, running, awaiting reconciliation, awaiting application, succeeded, failed | Met (job state derived from step states; steps journalled before each irreversible action) | db-jobs; ADR 0005 |
| "Proven not submitted" vs "outcome unknown"; nothing re-bought while uncertain | Met | db-jobs death tests (5 points); `DUPLICATE_IN_PROGRESS` while unknown |
| Vendor idempotency key where supported, plus local idempotency | Met with mocks (stable per step, sent only to adapters that declare support; no real adapter declares it yet) | db-jobs vendor-key test |
| Whole-workflow cost reserved atomically | Met (existing grouped reservation under an advisory lock) | db-jobs caps test across two instances |
| Pricing needs currency, price version and cap timezone; unknown or negative prices refused | Met (`PRICE_CONFIG_INCOMPLETE`; stored on every reservation; caps counted in the configured zone) | db-jobs pricing test; generation-gate tests |
| Settlement never erases spend; money released only for steps proven never sent | Met (settle only from reserved / outcome unknown; resolve once) | db-jobs settlement test |
| Lease ownership and fencing | Met (every step write is fenced by the lease owner; recovery takes over atomically) | db-jobs; mutation checks |
| Recover stored-but-unapplied results without re-buying | Met | db-jobs "death beforeApply", "charged with result" |
| Distinct states for unknown outcome, superseded, settlement failure, application failure | Met (API and UI labels) | Generation Jobs screen; generation-jobs e2e |
| Read-only reconciliation view, guarded resolution with evidence and audit | Met (owner only, 10+ character evidence, decided once, history shown) | db-jobs manual resolution; generation-jobs e2e |
| Process death at reservation, before submit, after acceptance, after result, before settlement, before applying | Met with mocks | db-jobs |
| Same-key and different-key requests across two DB connections | Met | db-jobs "two instances" |
| Old job replay after a newer approval; approved/scheduled items not silently regenerated | Met (`APPROVED_CONTENT` needs explicit confirmation; scheduled items refused; stale results superseded) | db-routes, db-packages, db-generation-races |
| Recovery uses the durable ledger even if the app restarts with the default gate | Met (bug found by the e2e and fixed) | db-jobs regression test |
| Provider status lookups for real adapters | **Not met.** No approved adapter has a verified lookup endpoint; operators resolve with evidence | ADR 0005 |

## Repository instructions

There are no `AGENTS.md`, `CLAUDE.md` or repository skills (VERIFIED SOURCE).
