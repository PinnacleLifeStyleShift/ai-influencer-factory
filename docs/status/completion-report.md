# Completion report

> **Historical record.** For current status, read `docs/status/spec-2026-11-11.md`, the maintained matrix. On 11 November 2026 Railway showed both services serving `25a0eab` (PR #21). Statements below about "not merged", merge order or the serving revision describe the time they were written.

> **Updated after PRs #10–#14:** see `ai-influencer-prompt-evidence.md` for the owner's project-prompt evidence packet (route-bound authorization, reconciliation compare-and-swap, revocation holds, rendering, operations, migration gates).

Recorded 2026-11-10 for the completion brief v1.0 (9 November 2026). Evidence labels are as in `current-baseline.md`: VERIFIED SOURCE, TESTED LOCALLY, HOSTED CI, DEPLOYED, LIVE-VERIFIED. No secret values appear here.

**Bottom line:** every package in the brief is built and tested with mocks, synthetic media and throwaway databases.

> **Update, 10 November 2026:** PRs #1–#18 are merged and `3fb3562` is DEPLOYED on both services. The production database is migrated, and `OWNER_API_TOKEN` is set (checked by name only). The AIF 1–3 remediation (`remediation-2026-11-10.md`) is merged and deployed. See `ai-influencer-prompt-evidence.md`. Nothing is LIVE-VERIFIED yet.

**The MVP is not yet complete by the brief's own definition**, which requires the private end-to-end export workflow verified in production. That needs two things:

1. **Deployment:** PRs #1–#9 merged, after the steps in the runbook.
2. **Real export:** approved private media storage. Without it, export refuses with `MEDIA_STORE_NOT_CONFIGURED`.

## Revisions

| Item | Revision | Evidence |
| --- | --- | --- |
| `main` (deployed, both services) | `3fb3562` (was `277d2d3`) | DEPLOYED |
| PR #1 Phase 1 safety foundation | `10704fa` | HOSTED CI |
| PR #2 Package A identity baseline | `8ce8ace` | HOSTED CI |
| PR #3 Package B character bible | `1cfcf9d` | HOSTED CI |
| PR #4 Package C content packages | `7e64744` | HOSTED CI |
| PR #5 Package D durable jobs | `0725bc8` | HOSTED CI |
| PR #6 Package E review, calendar, export | `3504065` | HOSTED CI |
| PR #7 Publishing interfaces | `066731a` | HOSTED CI |
| PR #8 Measurement | `2e2ed62` | HOSTED CI |
| PR #9 Operational hardening | head shown in its PR | HOSTED CI at that head |

Each PR is based on the previous one, so they merge in order. Every merge into `main` auto-deploys both services.

## Feature acceptance matrix

| Brief section | Outcome | Status | Where |
| --- | --- | --- | --- |
| 5 Package A | Sessions, revocation, server-side authorization, safe errors, audit, SSRF checks | Met (TESTED LOCALLY, HOSTED CI). Login provider: owner decision | ADR 0001–0002 |
| 6 Package B | Versioned characters, reference history, rights records, recorded inputs | Met with mocks. Real reference conditioning: provider decision | ADR 0003 |
| 7 Package C | Sourced/manual ideas, versioned scripts, shot plans, packages, claims gate | Met with mocks | ADR 0004 |
| 8 Package D | Durable jobs, unknown outcomes, reconciliation, pricing context, leases | Met with mocks. Real prices, caps, provider: owner decisions | ADR 0005 |
| 9 Package E | Schedule bound to approval, DST, cancellation fencing, verified export | Met with synthetic media. Real storage: owner decision | ADR 0006 |
| 10 Publishing | Interfaces, fail-closed gate, per-destination delivery, reconciliation | Interfaces met; **no real publisher** (owner decision) | ADR 0007 |
| 10 Measurement | Provenance, period reports, coverage, money states, no revenue attribution | Met; **no analytics provider** (owner decision) | ADR 0008 |
| 3 Sponsors | Authorized sponsor relationship and disclosure before submissions | Met | ADR 0009 |
| 11 Hardening | Config audit, readiness, graceful shutdown, backup + restore drill, preflight, non-root images, security headers, runbook | Met locally; production steps await the owner | ADR 0009, runbook |

## Test evidence at the hardening branch (TESTED LOCALLY; HOSTED CI per PR)

- **Backend:** 175/175 pass on a throwaway Postgres, with zero outbound calls asserted. It covers:
  - process death at every point of a paid call;
  - two-instance races;
  - DST cases;
  - a real `pg_dump` → `pg_restore` drill with row-count verification.
- **Frontend:** vitest 13/13 and `vite build`.
- **Browser (Playwright):** eight flows:
  - UI auth;
  - character bible;
  - content package;
  - generation jobs;
  - review/export (desktop and phone);
  - publishing (simulation);
  - measurement;
  - the production build served with its security headers (no CSP violations).
- **Mutation checks:** for every package, each key invariant was broken on purpose and a test failed. The lists are in each PR.
- **Docker:** both images are built and smoke-tested in CI. The checks cover migrations, sessions, readiness, non-root users, graceful stop and headers.
- **Audit:** `npm audit` finds 0 vulnerabilities in both packages.
- **Not run anywhere:** anything against the live service, and real provider or platform calls.

## Migration verification

Twelve committed migrations exist. All are additive except one data change in `20261110030000` (clearing random fixture trend scores).

- **What the tests check** (TESTED LOCALLY, HOSTED CI):
  - a fresh database;
  - a pre-migration `db push` database with data, where the baseline is verified before it is recorded;
  - a repeated deploy (no-op);
  - deliberate drift (refused).
- **Production:** not yet migrated. The preflight reports what will happen before any deploy.

## Disabled features (safe defaults)

- **Paid generation:** off. It needs an approved provider/model, prices, caps, a timezone and the durable ledger.
- **Media storage and real export:** off. Export refuses with a named reason.
- **Publishing:** off. No platform adapter exists; simulation is labelled and never counts as published.
- **Platform analytics:** off. No provider; manual readings with a source are supported.

## Owner decisions still open

1. **`OWNER_API_TOKEN`:** set, but through the Railway connection, so its value appears in that session's tool log. The owner should replace it. `FRONTEND_URL` and `TRUST_PROXY` are set, and the owner took a backup before the deploy.
2. **Character, audience and platform:** the initial character, audience and platform.
3. **Login provider:** which login provider replaces the owner token.
4. **Higgsfield:** API access, model and commercial rights.
5. **Video provider:** which provider generates video.
6. **Budgets and pricing:** per-job, daily and monthly budgets; `PRICE_CURRENCY`, `PRICE_VERSION`, `SPEND_CAP_TIMEZONE`.
7. **Media storage:** private storage and a retention policy.
8. **Direct posting:** whether to enable it, and with which accounts, official API access and scopes.
9. **Analytics:** platform analytics access.
10. **Public SaaS scope:** none built.
11. **Monitoring and backups:** uptime monitoring and alerting, and scheduled backups with where the dumps are kept.
