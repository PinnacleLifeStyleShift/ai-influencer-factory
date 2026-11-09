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
