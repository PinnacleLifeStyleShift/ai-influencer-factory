# ADR 0009: Operational hardening

Status: accepted (reversible). Date: 2026-11-10.

## Decisions

- **Configuration audit, by name only.**
  - `services/opsChecks.js` reports the settings and what is wrong with them, never values.
  - It runs at startup (`[config]` log lines) and at `GET /api/system/config-check` (admin).
  - An unsupported Node version stops the process. Everything else is reported, and the safe defaults (disabled features) are listed as info.
- **Readiness.**
  - `GET /ready` (public) answers only `ready` / `not_ready`: the database answers and every committed migration is applied.
  - Railway's health check now uses it (`backend/railway.toml`).
  - `/health` stays a process liveness check.
- **Graceful shutdown.**
  - On SIGTERM the server stops accepting connections and lets in-flight requests finish for up to `SHUTDOWN_GRACE_MS` (25 s), then closes the database.
  - `drainingSeconds = 30` in `railway.toml` gives it that time.
  - An uncaught exception shuts down (the platform restarts); an unhandled rejection is logged.
- **Housekeeping:** sessions expired or revoked over 30 days ago are pruned daily. Audit events are not pruned.
- **Backups with a real restore drill.**
  - `scripts/db-backup.mjs` writes a custom-format dump plus a manifest: row counts, migrations, sha256, database fingerprint.
  - `scripts/db-restore-verify.mjs` restores into an empty scratch database only (never `DATABASE_URL`), checks the checksum, counts and migrations, and fails on any difference.
  - Credentials go to `pg_dump`/`pg_restore` through environment variables. Hosts and passwords are never printed.
- **Preflight.** `scripts/preflight.mjs` is read-only. It reports:
  - the database fingerprint;
  - migration state, including pre-migration databases;
  - main row counts;
  - the configuration audit.

  It exits with code 2 on blocking findings.
- **Containers:** both images run as the unprivileged `node` user; the backend installs production dependencies only.
- **Frontend security headers** (`src/securityHeaders.js` → `dist/serve.json`):
  - CSP with `script-src 'self'`, `connect-src` limited to the API origin, and `frame-ancestors 'none'`;
  - `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS;
  - `index.html` is not cached.
  - A browser check builds and serves the production bundle and fails on any CSP violation (confirmed by a mutation check).
- **Sponsor authorization** (brief section 3):
  - A campaign accepts character submissions only after the owner records the sponsor's legal name, the agreement reference, the authorization date and a paid-promotion disclosure (it must contain a clear label such as `#ad` or "Paid partnership").
  - Changing the brand clears it.
- **Runbook:** `docs/operations/runbook.md` covers the first deploy, rollback, restore, incidents, routine and feature activation.

## Not done here

- **Rate limits** are still in-memory per process, which is right for one instance. More than one instance needs a shared store.
- **External uptime monitoring and alerting** need an owner-chosen service.
- **Backups are manual commands.** Scheduling them, and choosing where dumps are kept, are owner decisions with a cost.
