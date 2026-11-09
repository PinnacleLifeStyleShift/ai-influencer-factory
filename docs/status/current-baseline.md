# Current baseline

Recorded 2026-11-09 for branch `pkg-a-identity-baseline`, stacked on PR #1.
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

Deploy path: `npm start` → `scripts/migrate-deploy.mjs`. It verifies a pre-migration database is identical to the baseline before recording it, and refuses otherwise. Rollback with Railway's button alone does not work after migration (the old image's `db push` refuses); this was re-tested at `10704fa`. See the deployment checklist doc.

## Tests at this branch (TESTED LOCALLY)

- Backend `npm test`: 91/91 pass, 0 skipped.
- Frontend vitest: 10/10 pass.
- `vite build` passes.
- Playwright UI auth check: passes.
- `npm audit`: 0 vulnerabilities in both packages.
- Both workflows run on this branch's PR; see its checks for HOSTED CI results at the exact head.

Not run here: Docker image builds (no Docker daemon in the sandbox; covered by the Docker build workflow), and anything against the live service.

## Repository instructions

There are no `AGENTS.md`, `CLAUDE.md` or repository skills (VERIFIED SOURCE).
