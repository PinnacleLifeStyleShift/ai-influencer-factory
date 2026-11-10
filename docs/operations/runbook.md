# Operations runbook

For the owner (Patrick) or whoever operates the private AI Influencer Factory on Railway. No secret values belong in this file. Commands assume the repository's `backend/` folder and a machine with Node 22.18+ and the PostgreSQL client tools (`pg_dump`/`pg_restore`, at least as new as the server).

## 1. Before the first deploy of the new code (merging PR #1)

The live API (`277d2d3`) has no authentication. Merging PR #1 deploys automatically, so do these first.

1. **Back up the database and prove the backup restores.**

   ```bash
   DATABASE_URL='<production URL>' node scripts/db-backup.mjs backups
   ```

   ```bash
   RESTORE_DATABASE_URL='<an EMPTY scratch database>' node scripts/db-restore-verify.mjs backups/<file>.dump
   ```

   - The drill refuses to restore into the production database or into a non-empty one.
   - It passes only when every table's row count and the migration history match.
   - Keep the `.dump` and `.json` together, off the laptop if possible.
2. **Run the preflight.** It is read-only and prints setting names, never values.

   ```bash
   DATABASE_URL='<production URL>' OWNER_API_TOKEN='<the new token>' FRONTEND_URL='https://ai-influencer-factory-production.up.railway.app' TRUST_PROXY=1 NODE_ENV=production node scripts/preflight.mjs
   ```

   - **Check the fingerprint:** the database fingerprint must match the backup's `databaseFingerprint`.
   - **Check the migrations line:** "pre-migration database" is expected for `277d2d3`. On start, the server verifies the schema is the deployed baseline before recording it, and refuses otherwise.
   - **Exit code 2 means stop:** fix the listed items first.
3. **Set these variables on the `api` service** (names only here):
   - `OWNER_API_TOKEN`: 32+ random characters, kept in a password manager.
   - `FRONTEND_URL`: the exact frontend origin.
   - `TRUST_PROXY=1`.
   - Leave every `LIVE_*`, `PUBLISH*`, `METRICS_API`, `MEDIA_STORE` and spend variable unset.
4. **Merge the PRs in order** (#1, then #2, …). Each merge redeploys. After each one:
   - **Deploy logs** show `[migrate] Done.` (or `No pending migrations`), the `[config]` lines (no `ERROR`), and `API running`.
   - **Health check:** `https://<api>/ready` returns `{"status":"ready"}`. Railway's health check uses it, so a deploy that cannot reach its database never replaces the running one.
   - **Sign in:** sign in through the UI (owner token → session). As owner, `GET /api/system/config-check` lists any remaining warnings by name.

## 2. Rolling back

- **Migrations are additive.** Newer tables and columns don't break older code from this series, so to roll back code, revert the merge on `main` (`git revert`); the auto-deploy then ships the previous code.
- **Prefer reverting over Railway's "redeploy previous" button.** Reverting keeps `main` and production in agreement.
- **Never roll back to `277d2d3` or older.** That image runs `prisma db push` and refuses the migrated schema. Going back that far means restoring the backup (section 3) and redeploying the old commit, an owner decision.

### A migration failed halfway

`[migrate]` stops on a failed migration (Prisma `P3009`), so the new server never starts and the previous deployment keeps serving. To recover (rehearsed in `test/migrations.test.js`):

1. **Undo the partial change:** compare the database with that migration's `migration.sql` and remove what was added (all migrations here are additive, so this means dropping what it added).
2. **Mark it rolled back:**

   ```bash
   npx prisma migrate resolve --rolled-back <migration name>
   ```

   Re-running over a half-applied change is refused, not merged.
3. **Redeploy:** the migration applies cleanly. If you're unsure, restore the backup instead (section 3).

### Rolling back code

Every migration after the baseline is additive, which is checked by a test. An older secure revision of this series (PR #1 or later) starts against the newest schema: its `migrate deploy` reports "No pending migrations" (also tested). So the secure fallback is to revert to an earlier revision of this series, or restore a backup. It is **never** `277d2d3` (unauthenticated, and it runs `db push`).

## 3. Restoring a backup into production (owner decision)

1. Run the restore drill first (section 1, step 1) on the backup you intend to use.
2. Create a new Postgres service and restore into it with the drill script (its target is that new database).
3. Point the `api` service's `DATABASE_URL` at the new database (a variable change redeploys it). Check `/ready`, then sign in.
4. Keep the old database untouched until you have checked the data.

## 4. Incidents

| Situation | What to do |
| --- | --- |
| Owner token may have leaked | Set a new `OWNER_API_TOKEN` (redeploys). As owner, call `POST /api/auth/sessions/revoke-all`, then sign in again. Review `GET /api/audit-events`. |
| Unexpected spending | Set `LIVE_PROVIDER_CALLS=disabled` (or unset it). Open **Generation Jobs**: "outcome unknown" steps are counted, not re-bought; check them with the provider and resolve them with evidence. |
| A post may have gone out twice or not at all | Open the item's **Publishing** panel. "Outcome unknown" deliveries block re-posting until you check the platform or record what you saw. |
| Something looks wrong with spending | **Operations** page, then **Pause new generation** (with a reason). New submissions stop at once, including a running workflow's next step; reconciliation continues. |
| Jobs stuck after a crash | Restart, or use **Recover abandoned jobs** (Generation Jobs) and `POST /api/publishing/recover`. Nothing uncertain is retried automatically. |
| `/ready` returns `not_ready` | The database is unreachable or a migration did not apply. Read the deploy logs (`[migrate]` lines). The previous deployment keeps serving. |
| A deploy hangs on shutdown | The server waits up to 25 s for in-flight requests, and Railway sends SIGKILL after 30 s. Anything cut off is reconciled by job recovery on the next start. |

## 5. Routine

- **Weekly:** back up. **Monthly:** run the restore drill into a scratch database and keep the "RESTORE DRILL PASSED" line with the date.
- **After any variable change:** read the `[config]` lines in the deploy log or call `GET /api/system/config-check`.
- **Housekeeping:** sessions expired or revoked more than 30 days ago are deleted daily. Audit events are kept.

## 6. Turning features on (each is a separate owner decision)

| Feature | Needs |
| --- | --- |
| Paid generation | An approved provider/model, verified prices (`PROVIDER_PRICES_USD`, `PRICE_CURRENCY`, `PRICE_VERSION`), caps and `SPEND_CAP_TIMEZONE`, `SPEND_LEDGER=postgres`, then `LIVE_PROVIDER_CALLS=enabled`. |
| Real export | Approved private media storage (a `MEDIA_STORE` implementation). |
| Publishing | A real platform adapter (not built), an approved account with verified scopes (`PUBLISH_ACCOUNTS`), `APPROVED_PUBLISH_DESTINATIONS`, then `LIVE_PUBLISHING=enabled`. |
| Platform analytics | An analytics provider (not built), then `METRICS_API=enabled`. |
