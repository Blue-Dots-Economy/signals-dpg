# Database migrations

How schema changes flow from local dev to a deployed Signals-DPG instance.
This document captures the **current contract** (Plans 1–3 era) and the
**forward path** for when additive-only SQL stops being enough.

## Today's contract (Direction B — Drizzle owns its tables)

The schema is split along a principled boundary — **what Drizzle can express
vs. what is Postgres-native** — and both layers are applied, in order, by one
deploy runner:

1. **Drizzle-owned (authoritative in TypeScript).** Declared under
   `apps/api/db/postgres/schema/` (`auth.ts`, `metrics.ts`,
   `pii_reveal_audit.ts`, `consent_record.ts`; re-exported from `index.ts`).
   `apps/api/drizzle.config.ts` points `out` at `./drizzle`, `schema` at
   `./db/postgres/schema`. Tables: the better-auth set (`user`, `account`,
   `verification`, `apikey`, `organization`, `member`, `invitation`, `team`,
   `team_member`) plus `item_metrics`, `pii_reveal_audit`, `consent_record`.
   Migrations are **generated and committed** under `apps/api/drizzle/`
   (`pnpm db:generate:api`) and applied at deploy by `drizzle-orm`'s runtime
   `migrate()` — **not** `drizzle-kit` (a devDependency, absent from the prod
   image). There is **no** hand-mirrored SQL copy of these tables anymore.

2. **Raw SQL (Postgres-native — cannot be Drizzle).** Under
   `packages/database/src/utils/sql_scripts/`, organized by concern:
   - `extensions/extensions.sql` — `pgcrypto`, `cube`, `earthdistance`,
     `vector` (pgvector), `postgis`. Superuser-level; in deploy these are
     created by common-services, locally by the dev superuser.
   - `core/create_items.sql` — the LIST-partitioned `items` table + the
     `item_search` table (`vector(1024)` embedding, `geography` geo, HNSW/GiST
     indexes) + the `items_created_by_fk` FK to the Drizzle-owned `"user"`.
   - `core/create_actions_events.sql` — the partitioned `item_actions` /
     `action_events` tables.
   - `migrations/NNNN_*.sql` — ordered version migrations (ALTER/backfill for
     existing DBs), e.g. `0001_item_locations.sql`.
   These use partitioning, extensions, and extension types Drizzle Kit doesn't
   model, so they stay raw.

Every raw statement is `CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT
EXISTS` / DO-block-guarded, so re-applying is a no-op.

**Two application paths — do not conflate:**

- **Deploy (cluster):** `apps/api/scripts/migrate.mjs` (`pnpm db:migrate:deploy:api`)
  applies **one Drizzle ledger** over `apps/api/drizzle/` — the declarative
  tables (`0000`) plus the raw partitioned/geo tables re-authored as custom
  migrations (`0001_core`, `0002_item_search`, and version migrations such as
  `0003_legacy_column_backfill`). It does extension **preflight** (assert, not
  create) → auto-baseline (legacy cutover) → `migrate()`, using prod deps only
  (`drizzle-orm` + `pg`) inside the app image. It does **not** read
  `sql_scripts/` or the generated `schema.sql` bundle.
- **Local dev:** `pnpm db:init:api` applies the raw `sql_scripts/{extensions,core}`
  directly, and `apps/api/db/postgres/schema.sql` is a generated reference bundle
  of those (see "Local dev" below).

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
  `db_init.ts` doesn't include the better-auth tables because local dev uses
  `pnpm db:push:api` for them. In deploy, all tables (declarative + raw) are
  applied by the single Drizzle ledger via `migrate.mjs` (see "Deployed" below),
  not by this local script. The script is idempotent and safe to re-run.

Without `pnpm db:init:api`, the first `POST /api/v1/item/create` against a
fresh database fails with `PARTITION_SETUP_FAILED` — the parent `items`
table is missing. That mode is what the helper exists to prevent.

For iterating on the Drizzle schema you also have:

- `pnpm db:generate:api` → `drizzle-kit generate` — writes a new SQL file
  into `apps/api/drizzle/`, which is **committed** (the deploy runner applies it).
- `pnpm db:migrate:api` → `drizzle-kit migrate` — applies any pending
  generated migrations to the connected DB.
- `pnpm db:studio:api` → `drizzle-kit studio` — browser DB UI.

### Deployed (helm migrate-job)

> The Helm charts live in the separate deployment repository. No `schema.sql`
> is vendored there anymore — the migrate-job runs the **app image** and applies
> the schema from the committed `apps/api/drizzle/` ledger via `migrate.mjs`.

The deploy-time migration runs as a Helm `post-install,post-upgrade` hook
(`migrate-job.yaml`, charts repo): a `migrate-ddl` initContainer runs the api
image's `node apps/api/scripts/migrate.mjs` (extension preflight → auto-baseline
→ `migrate()`), then a `provision` container upserts the aggregator-dpg apikey.
The older shape below (a psql job consuming a `schema.sql` ConfigMap) is
retained only as historical context:

- A `ConfigMap` named `<release>-migrate-sql` mounts the bundled
  `schema.sql` (`hook-weight: -1`).
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

`apps/api/db/postgres/schema.sql` is a **generated** bundle — assembled
by `scripts/generate-schema-bundle.mjs` from the scripts under
`packages/database/src/utils/sql_scripts/`. Regenerate with
`pnpm schema:bundle`; CI guards freshness via `pnpm schema:bundle:check`
and verifies parity with the Drizzle schema in the `schema-parity` job.
Never edit the bundle by hand.

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

- In `dpg/charts/api/templates/migrate-job.yaml` (charts repo):
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
  - Drop the `ConfigMap` `<release>-migrate-sql` and the bundled
    `schema.sql` file — Drizzle's `apps/api/drizzle/` directory shipped
    inside the image is now the source of truth.
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
- In `dpg/charts/api/values.yaml` (charts repo):
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
- [ ] **Regenerate the bundle**: any change to either source (Drizzle
      schema or `sql_scripts/`) requires `pnpm schema:bundle` and
      committing the updated `apps/api/db/postgres/schema.sql` in the
      same PR. CI fails the PR otherwise (`pnpm schema:bundle:check` +
      the `schema-parity` job).
- [ ] **`pnpm db:init:api` still succeeds on a fresh DB** (apply locally
      against an empty database and verify).

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

### U18 guardian-consent additions

The U18 feature (PR #311) adds, in the **Drizzle-owned** layer (schema under
`apps/api/db/postgres/schema/`, applied via the `apps/api/drizzle/` ledger):

- `"user"."domains" text[]` (`auth.ts`) — the signup domain(s) / role.
- the `minor_guardian` table (`minor_guardian.ts`).
- a **reshaped** `consent_record_profile_creation_unique` index — dropped and
  recreated on `(user_id, item_id, source)` instead of `(user_id, item_id)` so a
  ward's self-consent and their guardian's consent co-exist as distinct
  append-only rows (`consent_record.ts`).

All three are captured in generated migration `drizzle/0004_zippy_taskmaster.sql`
(the DROP+recreate of the index included). Because deploy now applies the Drizzle
ledger via `migrate.mjs` (which tracks applied migrations in
`__drizzle_migrations`), these land on an existing DB **automatically** on the
next deploy — the old `WHERE table_name='items'` short-circuit no longer gates
them (that was the pre-#287 gap). **No manual DDL needed.**

**Backfill `user.domains` for existing users.** The profile-create role lock
reads `user.domains` (source of truth) instead of deriving from held items. New
users get it at signup / on first create; existing users start NULL (treated as
"unset → any served domain"). This is **data, not schema**, so the deploy
migrator does not run it — it lives as a one-off in the `adhoc-scripts` repo:
`adhoc-scripts/u18-user-domains-backfill/` (`backfill_user_domains.sql` + README).
Run it once per environment after the deploy applies `0004`:

```bash
psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -f backfill_user_domains.sql
```

It sets each existing user's single role from their earliest item; users with no
items are left empty (role assigned on first create). Idempotent — only NULL/empty
rows are touched.

### `0005_age_location` (#331) — DOB → age snapshot

Custom SQL in the Drizzle ledger (`drizzle/0005_age_location.sql`): adds
`user.age integer` + `user.location text`, **backfills `age = currentYear −
birthYear` from any existing `date_of_birth`**, then drops `date_of_birth`
(mirrors the client rule used to capture age). Ordered add → backfill → drop so
populated birth dates aren't lost. Idempotent — `IF [NOT] EXISTS` on the
add/drop and a guarded backfill/drop (`DO $$ … $$` keyed on `date_of_birth`
still existing) make it a safe no-op on a re-run or a DB that never had the
column. Applied automatically by the deploy migrator (`migrate.mjs`) — **no
manual DDL needed.**

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
- `dpg/charts/api/templates/migrate-job.yaml` (charts repo) —
  deploy-time Job.
- `apps/api/db/postgres/schema.sql` — generated deploy-time bundle
  (`pnpm schema:bundle`).
