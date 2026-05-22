# Database migrations

How schema changes flow from local dev to a deployed Signals-DPG instance.
This document captures the **current contract** (Plans 1–3 era) and the
**forward path** for when additive-only SQL stops being enough.

## Today's contract (as of merge of Plan 4 Task G.1)

The schema lives in two layers, and both must be applied to bring a fresh
database up:

1. **Drizzle-managed (better-auth tables).** The auth schema is declared in
   TypeScript under `apps/api/db/postgres/schema/` (`auth.ts`, re-exported
   from `index.ts`). `apps/api/drizzle.config.ts` points `out` at
   `./drizzle` and `schema` at `./db/postgres/schema`. Generated migrations
   land under `apps/api/drizzle/`. Tables owned by this layer:
   `user`, `account`, `session`, `verification`, `apikey`, `organization`,
   `member`, `invitation`, `team`, `teamMember`, plus the better-auth
   indexes.

2. **Idempotent raw SQL (network item layer).** Under
   `packages/database/src/utils/sql_scripts/`:
   - `create_items.sql` — extensions (`pgcrypto`, `cube`, `earthdistance`),
     the partitioned `items` table, GIN/GiST indexes, geo CHECKs, and the
     `items_created_by_fk` FK to `"user"`.
   - `create_actions_events.sql` — `item_actions` and `action_events`
     (partitioned, with their FKs back into items).
   - `create_auth_table.sql` — a vendor snapshot of the auth DDL.
     **Not applied by any code path** today; Drizzle owns those tables.
     Treat it as reference until Workstream A.2 turns it into the
     drizzle-derived `auth.sql` block of the bundle.

Every statement in the items/actions/events scripts is written in the form
`CREATE EXTENSION IF NOT EXISTS …`, `CREATE TABLE IF NOT EXISTS …`,
`CREATE INDEX IF NOT EXISTS …`, so applying the same file to a database
that already has the objects is a no-op.

### Local dev

From a clean checkout:

```bash
docker compose up -d db redis      # bring up postgres + redis
pnpm db:push:api                   # drizzle-kit push → auth tables
pnpm db:init:api                   # apply create_items.sql + create_actions_events.sql
```

Script wiring:

- `pnpm db:push:api` (root) → `pnpm --filter api db:push` →
  `drizzle-kit push` (see root `package.json` and `apps/api/package.json`).
  This diffs the schema in `apps/api/db/postgres/schema/` against the
  database and pushes the changes directly — no migration file is
  generated.
- `pnpm db:init:api` (root) → `pnpm --filter api db:init` →
  `tsx scripts/db_init.ts`. That script (see `apps/api/scripts/db_init.ts`)
  connects via `POSTGRES_URL` (or the `POSTGRES_USER` / `POSTGRES_PASSWORD`
  / `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` quintuple), then
  reads and executes, in order:
  ```ts
  const FILES = ['create_items.sql', 'create_actions_events.sql'];
  ```
  `create_auth_table.sql` is **intentionally skipped** because Drizzle
  owns the auth tables. The script is idempotent and safe to re-run.

Without `pnpm db:init:api`, the first `POST /api/v1/item/create` against a
fresh database fails with `PARTITION_SETUP_FAILED` — the parent `items`
table is missing. That mode is what the helper exists to prevent.

For iterating on the Drizzle schema you also have:

- `pnpm db:generate:api` → `drizzle-kit generate` — writes a new SQL file
  into `apps/api/drizzle/`. Today `apps/api/drizzle/` is gitignored
  (`.gitignore:10` → `drizzle/`), so generated files are local-only.
- `pnpm db:migrate:api` → `drizzle-kit migrate` — applies any pending
  generated migrations to the connected DB.
- `pnpm db:studio:api` → `drizzle-kit studio` — browser DB UI.

### Deployed (helm migrate-job)

The deploy-time migration runs as a Helm `post-install,post-upgrade` hook
defined in `helmcharts/dpg/charts/api/templates/migrate-job.yaml`. The
shape:

- A `ConfigMap` named `<release>-migrate-sql` mounts the file
  `helmcharts/dpg/charts/api/files/schema.sql` (`hook-weight: -1`).
- A `Job` named `<release>-migrate` (`hook-weight: 0`) runs a container
  off `image: postgres:16-alpine` (see `values.yaml:154`) with
  `migrate.enabled: true` (`values.yaml:153`).
- The container's shell command:
  1. `pg_isready`-loops up to ~2 minutes until the DB accepts connections.
  2. If `postgres.adminSecret` is set, runs
     `CREATE EXTENSION IF NOT EXISTS pgcrypto; … cube; … earthdistance;`
     as the admin user (extensions require superuser).
  3. Probes `information_schema.tables` for `public.items`. **If it
     exists, the Job exits 0 without doing anything else.** This is the
     "already migrated" short-circuit and is the reason today's contract
     can't express non-additive changes.
  4. Otherwise: `psql -v ON_ERROR_STOP=1 --single-transaction -f
     /sql/schema.sql`.

So in production, the source-of-truth file is the **bundled
`schema.sql`**, not the Drizzle migrations or the SQL scripts directly.

`helmcharts/dpg/charts/api/files/schema.sql` is **a hand-maintained
snapshot today.** Its header claims:

```
-- Sources (kept canonical; do not edit by hand):
--   apps/api/drizzle/0000_init.sql                          -> auth tables
--   packages/database/src/utils/sql_scripts/create_items.sql -> items + indexes
--   packages/database/src/utils/sql_scripts/create_actions_events.sql -> actions/events
```

…but no generator exists yet — that's Plan 4 Workstream A
(`pnpm schema:bundle`), and it has not landed. Until it does, **any
change to `packages/database/src/utils/sql_scripts/*.sql` or the Drizzle
schema must be hand-mirrored into `helmcharts/dpg/charts/api/files/schema.sql`
in the same PR.** No CI check enforces this yet (Workstream A.3 is also
deferred).

### Why two layers today

This is historical, not designed-in. The `items` / `item_actions` /
`action_events` tables predate the better-auth adoption — they came in as
raw SQL from the vendor (Dhiway) and are partitioned in ways Drizzle Kit
doesn't model cleanly. Drizzle was introduced later for the better-auth
tables only; nobody migrated the existing items DDL across.

Plan 4 Workstream A's goal is to collapse to a single Drizzle-derived
bundle (`auth.sql` + `items.sql` + `actions_events.sql` → `schema.sql`)
with a CI parity check. That work is deferred — this document describes
the world as it stands.

## Additive-only constraint

The deploy-time `psql -f schema.sql` runs on every helm release against
the existing database in place. For that to be safe, every statement in
the bundle has to be additive and idempotent. Use:

- `CREATE EXTENSION IF NOT EXISTS …`
- `CREATE TABLE IF NOT EXISTS …`
- `CREATE INDEX IF NOT EXISTS …`
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
- `ALTER TABLE … ADD CONSTRAINT IF NOT EXISTS …` (or guard with a
  `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
  block when the Postgres version doesn't support `IF NOT EXISTS` on
  that constraint kind)

What is **not** safe under this contract:

- `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`
- `ALTER TABLE … ALTER COLUMN … TYPE …`
- `ALTER TABLE … ALTER COLUMN … SET NOT NULL` against a table that
  already has rows where the column can be null
- `ALTER TABLE … RENAME …`
- Re-seating a primary key or unique constraint over existing data

Any of those will either error mid-transaction (rolling back the whole
release migration) or silently corrupt because the Job's
`SELECT 1 FROM information_schema.tables WHERE table_name='items'` short-
circuit treats the DB as already migrated.

Plans 2 and 3 fit inside this constraint:

- **Plan 2** adds 4 nullable columns + an FK + an index on `user`. All
  additive.
- **Plan 3** adds a new `participant_metrics` table. All additive.

## Forward path: when additive-only breaks

The first time we need a non-additive change, the
`psql -f /sql/schema.sql` model has to be replaced. Options, in order of
preference:

### Preferred: switch the migrate-job to `drizzle-kit migrate`

Drizzle already has the data model and is the source of truth for new
schema; we already invoke `drizzle-kit migrate` locally via
`pnpm db:migrate:api`. Reuse that path in cluster:

- In `helmcharts/dpg/charts/api/templates/migrate-job.yaml`:
  - Replace the container image. Today: `image: postgres:16-alpine`.
    Switch to either the API's own image (which already has
    `drizzle-kit` in `apps/api/package.json` devDependencies and the
    generated migrations on disk) or a slim `node:24-alpine` image with
    just `apps/api/drizzle/` + the minimal `node_modules` needed for
    `drizzle-kit migrate`.
  - Replace the inline `psql -f /sql/schema.sql` shell with
    `pnpm --filter api db:migrate` (a.k.a. `pnpm db:migrate:api` at the
    root). It reads `apps/api/drizzle/meta/_journal.json` and applies
    everything past the recorded high-water mark.
  - Drop the `ConfigMap` `<release>-migrate-sql` and the
    `helmcharts/dpg/charts/api/files/schema.sql` file — Drizzle's
    `apps/api/drizzle/` directory shipped inside the image is now the
    source of truth.
  - Drop the `SELECT 1 FROM … WHERE table_name='items'` short-circuit.
    Drizzle's `__drizzle_migrations` tracking table replaces it.
  - Keep the `pg_isready` wait loop and the admin-creds
    `CREATE EXTENSION` step (Drizzle doesn't manage extensions).
- In `apps/api/Dockerfile`:
  - Make sure `apps/api/drizzle/` is **not** pruned out of the runtime
    image (today the dir is gitignored — Workstream A.1's generator will
    start committing it).
  - Make sure `drizzle-kit` survives `pnpm install --prod` (it's a
    devDependency today; move to dependencies, or build a dedicated
    migration image).
- In `helmcharts/dpg/charts/api/values.yaml`:
  - Rename/repurpose `migrate.image` to point at the migration image.
  - Add any drizzle-specific env (the existing `POSTGRES_*` envFrom is
    already enough — `drizzle.config.ts` reads the same vars).

One-time data backfills that would have been impossible in raw idempotent
SQL (e.g. populating a new NOT NULL column from a computed value before
the constraint goes on) move into Drizzle's
[custom migration hooks][drizzle-custom-migrations] — a `.ts` file
co-located with the SQL migration that runs as part of the same step.

[drizzle-custom-migrations]: https://orm.drizzle.team/docs/migrations#custom-migrations

### Alternative: a dedicated migration runner (sqitch, atlas, migra)

Worth considering only if Drizzle's migration story turns out to be too
thin for our needs (e.g. we need declarative drift detection, branching
schemas, or rich data migrations). Trade-offs:

- **+** Each tool is purpose-built for migrations and is more battle-tested
  for non-additive changes than Drizzle's hook story.
- **−** Adds a third schema tool to the stack alongside Drizzle and the
  idempotent SQL we're trying to eliminate.
- **−** Forces a parallel source of truth (`*.sql` migration files outside
  Drizzle) — exactly the drift problem Workstream A is meant to solve.

Don't pick this path without a concrete change Drizzle can't express.

## Pre-flight checklist for any schema PR

- [ ] **Drizzle-managed change** (anything under
      `apps/api/db/postgres/schema/`): run `pnpm db:generate:api` and
      commit both the TS schema source and the generated
      `apps/api/drizzle/<n>_*.sql`. (Drop the `drizzle/` entry from
      `.gitignore` once Workstream A.1 starts committing these — until
      then, the generated file is only used locally and the bundled
      `schema.sql` is the deploy artifact.)
- [ ] **Idempotent SQL change** (anything under
      `packages/database/src/utils/sql_scripts/`): every new statement
      uses `IF NOT EXISTS`. No plain `CREATE TABLE`, no
      `ALTER TABLE … ADD COLUMN <name> …` without `IF NOT EXISTS`, no
      `DROP …`, no `ALTER COLUMN TYPE`, no `SET NOT NULL` on a populated
      column.
- [ ] **Mirror into the bundle**: until Workstream A.1's generator
      lands, any change to either source (Drizzle schema or
      `sql_scripts/`) must be applied **by hand** to
      `helmcharts/dpg/charts/api/files/schema.sql` in the same PR.
      Drift between the two is silent today — nothing in CI catches it.
- [ ] **`pnpm db:init:api` still succeeds on a fresh DB** (apply locally
      against an empty database and verify).
- [ ] **Helm chart lints**: `helm lint helmcharts/dpg` doesn't regress.
- [ ] **CI schema-parity check** (Plan 4 Workstream A Task A.3): not
      landed yet. When it does, it will fail any PR where Drizzle and
      the bundle disagree — re-run `pnpm schema:bundle` and commit.

## Rollback

There is no automated rollback today. Concretely:

- **Drizzle layer.** `drizzle-kit drop` is a read-only listing of
  migration files to drop from the journal — it does not revert SQL.
  Drizzle has no `down` migrations. Reverting requires hand-writing the
  inverse SQL as a new migration (`pnpm db:generate:api`) and shipping
  it forward.
- **Idempotent SQL layer.** No revert. The next deploy re-applies the
  same bundle. To "undo" an addition, you ship a new forward migration
  that drops the added column/index/table — which itself is non-
  additive, so it has to wait for the `drizzle-kit migrate` switchover
  described above.
- **Deploy-time short-circuit.** The migrate-Job's
  `WHERE table_name='items'` check means that once a release has run
  once against a database, subsequent releases skip the bundle entirely.
  If you ship a bad bundle, fix it forward; rolling the helm release
  back will not roll back schema.

Operational guidance until the switchover:

- Snapshot the database before any non-additive change. With Plans 2 and
  3 (nullable columns + new table) this is belt-and-braces; for anything
  beyond, it's mandatory.
- For multi-step migrations (e.g. "add column, backfill, then set NOT
  NULL") ship in two releases — the first additive, the second the
  constraint — and verify the backfill between them.

## Related

- `docs/superpowers/plans/2026-05-21-deployment-and-automation.md` —
  Workstream A (schema bundle generator + parity check) and
  Workstream G (this contract).
- `docs/operations/secrets.md` — `POSTGRES_URL` /
  `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_HOST` /
  `POSTGRES_PORT` / `POSTGRES_DB` wiring consumed by both
  `apps/api/scripts/db_init.ts` and the helm migrate-Job.
- `apps/api/drizzle.config.ts` — Drizzle Kit configuration for the
  better-auth schema.
- `apps/api/scripts/db_init.ts` — local idempotent SQL applier.
- `helmcharts/dpg/charts/api/templates/migrate-job.yaml` — deploy-time
  Job.
- `helmcharts/dpg/charts/api/files/schema.sql` — hand-maintained
  deploy-time bundle (future Workstream A output).
