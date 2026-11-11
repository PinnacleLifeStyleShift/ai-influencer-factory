# Reconciliation: implementation specification of 10 November 2026

> **Historical record.** For current status, read `docs/status/spec-2026-11-11.md`, the maintained matrix. On 11 November 2026 Railway showed both services serving `25a0eab` (PR #21). Statements below about "not merged", merge order or the serving revision describe the time they were written.

> **Superseded by `ai-influencer-prompt-evidence.md`.** That file holds the final story and acceptance matrix after PRs #10–#14; this file records the gap analysis made at PR #10.

The 10 November spec reviewed the stack up to PR #5 (`0725bc8`). Since then, PRs #6–#9 (Package E, publishing interfaces, measurement, operational hardening) and this branch were added. This file maps each requirement to what exists, so nothing is rebuilt needlessly ("Do not rebuild completed candidate work") and the real gaps are explicit.

**Status words:**

- **Done:** in source with tests.
- **Partial:** some of it exists; the gap is named.
- **Gap:** not built.
- **Owner:** blocked on an owner decision.

## Release blocker (spec section 2) and Package 1: route-bound authorization

| Requirement | Status | Where |
| --- | --- | --- |
| Editor reaching `/generate-image/` or `/GENERATE-IMAGE` | **Done (fixed)**. Reproduced first: rights approval, reconciliation, campaign money and pipeline generation had the same gap | `auth-route-matrix.test.js`; this branch |
| Permission declared on each actual route registration; a mutation without one is rejected | **Done**. `secureRouter` throws at registration; a coverage test walks every mounted route | `src/lib/secureRouter.js`, `src/auth/permissions.js` |
| Separate read/edit/approve/schedule/references/generate/spend/admin; generation = generate + spend; rights approval, revocation and reconciliation = admin | **Done** | Declarations in `src/routes/*` |
| Matrix: canonical, trailing slash, mixed case, encoded segment, repeated separator, malformed escape, HEAD, OPTIONS, wrong method; owner/editor/reviewer; absent/expired/revoked | **Done**. Variants are 404/400/401/403; the owner reaches the operation only at its canonical URL | `auth-route-matrix.test.js` |
| Denied requests: zero DB mutation, reservation, provider call or approval | **Done**. Row snapshot plus provider call count | same |
| Rate limiting independent of roles | **Done** | same |
| Session identity server-derived; bootstrap secret out of URLs, storage, logs, bundles; expiry and revocation | **Done** (PR #2) | ADR 0001; `db-auth`, `db-ops` |
| Cookie sessions with CSRF | Not applicable: bearer sessions only | — |
| Reject unknown security-sensitive request fields | **Partial**. Schemas validate known fields; unknown fields are ignored, not refused, except where validated | Gap: a strict-fields pass on approval, rights and money routes |

## Package 2: characters, rights, creative packages

| Requirement | Status |
| --- | --- |
| Immutable versions, append-only rights, script versions, reference pins, honest idea kinds | **Done** (PRs #3, #4) |
| Rights checked immediately before submission, not only at upload | **Done**. `clearanceFor` runs in the generation request before any reservation |
| A later revocation blocks new use **and marks affected unpublished packages for review** | **Partial**. A newer, narrower rights record blocks new use. **Gap:** affected unpublished packages are not flagged |
| Observations need URL, time, platform and observation; unknown scores stay null | **Done** |
| Edge tests: changed shot order, deleted references, duplicate ids, zero/negative durations, stale concurrent edits | **Partial**. Version conflicts and durations are covered. **Gap:** an explicit test set for the listed edge cases |
| Mock-reported duration never labelled independently measured | **Done**. `provider_reported` vs `measured` (from file bytes) |

## Package 3: durable generation, money, recovery

| Requirement | Status |
| --- | --- |
| Journal, fencing, unknown outcomes, atomic workflow reservation, pricing context, append-only settlement, stable keys | **Done** (PR #5) |
| Same key + different body → conflict | **Done** (`IDEMPOTENCY_KEY_REUSED`) |
| Provider lookup only when the contract is documented and approved; otherwise evidence-based reconciliation | **Done**. No real adapter declares lookups |
| Manual resolution: owner, structured reason, supporting reference | **Done**. **Partial:** no `expectedVersion` on resolution (one-shot resolution is refused if repeated) |
| Separate step states (settlement pending, application pending, superseded …) | **Done** |

## Package 4: measured media, approval, calendar, export

| Requirement | Status |
| --- | --- |
| Approval binds script, shots, asset hashes, caption, hashtags, disclosure, destination, schedule; IANA zone + UTC + DST choice | **Done** (PR #6) |
| Calendar never becomes "published" by time passing | **Done** |
| Export of the immutable approved version; manifest with hashes, versions, rights, provider/model, known cost, duration, disclosure; repeated export identical; stale approval refused; broken media blocks ready | **Done** (PR #6) |
| `AssetVersion` record (hash, type, dimensions, codec, measured duration, storage ref, source job, provenance) | **Gap**. Facts are computed at export time and kept in the manifest, not stored as asset versions |
| Deterministic local synthetic **assembly** of a multi-shot package into one file | **Gap**. Publishing refuses with `RENDER_REQUIRED` |
| Export API with `packageId`, `expectedRevision`, `approvalId`, idempotency key; queued/ready/failed states | **Partial**. Synchronous and idempotent by manifest hash. **Gap:** these request fields and the async states |
| Downloads access-controlled; no download by guessing ids | **Done**. Session required; ids are scoped to their item |
| Tests: oversized input, traversal filenames, cross-package assets, expired signed links | **Partial**. Traversal is blocked (`basename`) and broken links are handled. **Gap:** size and time limits on media reads; signed links don't exist |
| Validate download redirects against SSRF | **Partial**. No server-side fetch of real media exists yet (storage is an owner decision). The rule must ship with the storage adapter |

## Operational controls

| Requirement | Status |
| --- | --- |
| Private operations view: queue age, unknown outcomes, retained reservations, failed settlements, unapplied results, next permitted action | **Partial**. The Generation Jobs screen covers jobs and states. **Gap:** queue age, a retained-reservation total and a "next permitted action" column |
| A generation **kill switch** that stops new submission but keeps reconciliation | **Partial**. `LIVE_PROVIDER_CALLS` stops new calls but needs a redeploy. **Gap:** a runtime owner switch |
| Health endpoints never call paid models | **Done** (`/health`, `/ready`) |
| Retention defined separately for references, exports, audit, job evidence | **Partial**. Only sessions are pruned; nothing else is deleted. Policy is an owner decision |
| Logs carry request and job ids; redaction verified with synthetic secret markers | **Partial**. Request ids exist and the token is checked absent from server logs. **Gap:** a broader redaction test |
| Restart with provider unavailable, expired storage, exhausted disk, dependency outage | **Partial**. Restart recovery and database outage (`/ready`) are tested. **Gap:** the others |

## Migration, deployment, rollback

| Requirement | Status |
| --- | --- |
| Additive migrations; no db push; fresh, populated baseline, repeated invocation, deliberate drift | **Done** |
| **Partially applied migration** rehearsal | **Gap** |
| Backfill unknown rights as unapproved and fixture metrics as unknown | **Done**. No rights backfilled as approved; fixture scores cleared |
| Target database verified by safe identifiers | **Done**. Preflight fingerprint (PR #9) |
| Secure fallback build or restore strategy instead of rolling back to the unauthenticated baseline | **Partial**. Runbook: revert within the series; restore is tested. **Gap:** a named "secure fallback" build (all features off) rehearsed against a migrated database |
| PR order: authorization fix first | See note below |

**Order note:** this fix sits on top of the stack (PR #10). A merge into `main` auto-deploys, so if the PRs were merged one at a time, PRs #2–#9 would each deploy with the old matcher for a while. Two safe options:

1. Merge the whole stack in one sitting, ending with PR #10.
2. Backport this commit into PR #2 and rebase the stack.

## Completion evidence (spec section "Completion evidence")

- **Done:** `docs/status/completion-report.md` separates the evidence levels.
- **Still owed after deployment:** a hosted check that unauthenticated requests fail on the released revision, and the full synthetic export workflow run on that revision.
