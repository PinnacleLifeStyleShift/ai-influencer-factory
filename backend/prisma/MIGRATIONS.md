# Database migrations

Prisma 7: the connection URL comes from `DATABASE_URL` via `prisma.config.mjs` (it is no longer in
`schema.prisma`, and `.env` files are not loaded automatically). The runtime client uses the
`@prisma/adapter-pg` driver adapter (`src/lib/prisma.js`).

Schema changes ship as committed migrations in `prisma/migrations/`. `prisma db push`
is no longer used at build time, at startup, or in tests.

## How deploys apply them
`npm start` runs `scripts/migrate-deploy.mjs`, then the server:

1. **Fresh database**: `prisma migrate deploy` applies every migration.
2. **Database created earlier by `db push`** (tables present, no `_prisma_migrations`):
   the script compares the live schema with `prisma/baseline/277d2d3.schema.prisma`.
   - Identical: it records `20260321000000_init` as applied, then applies newer migrations.
   - Different in any way: it **refuses**, prints the differences, changes nothing, and the
     process exits non-zero (the deploy fails instead of guessing).
3. **Database with history**: applies only pending migrations.

## Making a schema change
1. Edit `prisma/schema.prisma`.
2. `npm run db:migrate:create -- --name <change>` against a local database, then review
   the SQL (look for `DROP`, type changes and `NOT NULL` without defaults).
3. `npm test`. The test harness builds its database from the migrations and fails if they
   don't produce exactly `schema.prisma`.

## Migrations
| Migration | Contents |
|---|---|
| `20260321000000_init` | Schema as deployed at commit 277d2d3 (baseline) |
| `20261108000000_phase1_safety` | Additive only: approval/revision columns, schedule key (unique), media fields, trend provenance, `generation_reservations`, `character_images`, `image_generations` |
| `20261109000000_generation_fencing` | Additive only: generation claim columns on `pipeline_items`, `generation_applications`, unique `character_images.reservation_id` |
| `20261110000000_sessions` | Additive only: `sessions` table (hashed session tokens, expiry, revocation) |
| `20261110010000_audit_events` | Additive only: `audit_events` table (redacted action evidence) |
| `20261110020000_character_versions_rights` | Additive only: `character_versions`, `rights_records`, version pins and recorded generation inputs |
| `20261110030000_content_packages` | Adds idea kinds/observation fields, `script_versions`, package fields on `pipeline_items`; makes `trends.trend_score` nullable and clears the random scores on simulated fixture rows (the only data change) |
| `20261110040000_generation_jobs` | Additive only: `generation_jobs`, `generation_steps`, `reconciliation_records`; `currency` (default `USD`), `price_version`, `cap_timezone` on `generation_reservations` |
| `20261110050000_review_calendar_export` | Additive only: schedule instant/zone/wall time on `pipeline_items`; schedule and cancellation columns on `content`; `export_manifests` table |
| `20261110060000_publishing` | Additive only: `cross_post_destinations` on `pipeline_items`; `publish_jobs`, `publish_deliveries`, `publish_reconciliations` |
| `20261110070000_measurement` | Additive only: `currency` on `campaigns` (default `USD`); `metric_observations`, `campaign_invoices`, `campaign_receipts` |
| `20261110080000_sponsor_authorization` | Additive only: sponsor legal name, agreement reference, authorization time/by and paid-promotion disclosure on `campaigns` |
| `20261110090000_reconciliation_revisions` | Additive only: `revision` (default 0) on `generation_steps` and `publish_deliveries` for compare-and-swap reconciliation |
