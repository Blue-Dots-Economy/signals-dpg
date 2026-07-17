# `apps/api/drizzle/` — migrations (single ledger)

The **entire deploy schema** is applied by one runner (`drizzle-orm`'s `migrate()`,
invoked by `scripts/migrate.mjs`) over one ledger (`drizzle.__drizzle_migrations`),
from the migrations in this folder, in journal order.

These files are **committed and reviewed** (not gitignored). They ship inside the api
image and are applied at deploy by the Helm migrate-Job, so the deployed schema always
matches the running build.

## Which files are generated vs hand-written

| Migration | Kind | Owns |
|-----------|------|------|
| `0000_*.sql` | **generated** by `drizzle-kit generate` | the 12 declarative relational tables (better-auth ×9 + `item_metrics` + `pii_reveal_audit` + `consent_record`). Drift-detected. |
| `0001_core.sql` | **hand-written custom** (`drizzle-kit generate --custom`) | `items` / `item_actions` / `action_events` — LIST-partitioned parents. Drizzle has no `PARTITION BY` API. |
| `0002_item_search.sql` | **hand-written custom** | `item_search` — `vector(1024)` + `geography(MultiPoint,4326)` + hnsw/gist. Types Drizzle can't express; co-owned by signals-search. |
| `NNNN_*.sql` (future) | generated *or* custom | version-specific schema migrations. |

**Ordering matters** (journal-enforced, FK-safe): `0000` (declarative `user`/`organization`/…)
→ `0001_core` (`items.created_by` / `item_actions.performed_by_*` FK the `0000` tables)
→ `0002_item_search` → later migrations.

## Rules

- **Declarative tables:** edit `db/postgres/schema/*.ts`, then `pnpm db:generate:api`
  (never hand-edit a generated `NNNN_*.sql`). `db:generate` must report
  "nothing to migrate" on a clean tree.
- **Raw tables (partitioned / vector / geo):** they are **off** the drift-detection
  schema path (their query-builder refs live in
  `packages/database/src/drizzle_ref_tables/*.ts`, which `drizzle-kit` never manages).
  To change them, add a new custom migration: `pnpm --filter api exec drizzle-kit
  generate --custom --name=<desc>`, then hand-write the SQL. Do not add them to
  `db/postgres/schema/`.
- **Extensions are NOT here.** `pgcrypto/cube/earthdistance/vector/postgis` are a
  provisioning prerequisite (common-services / RDS master in deploy). `migrate.mjs`
  asserts `vector`+`postgis` exist and fails loudly if not — it never creates them
  (the app role is least-privilege).
- **Leaf partitions are NOT here.** Per-`(network, domain)` partitions are created at
  runtime in `packages/database/src/utils/partition_by_type.ts`.

## Legacy cutover

A database built by the old `psql`/`schema.sql` path has every table but no ledger.
On first deploy, `migrate.mjs` detects this (ledger empty + `items` present) and
auto-baselines the current migrations so `migrate()` skips them; only post-cutover
migrations run. Run `pnpm db:check:parity:api` before cutover to confirm the committed
migrations match the live schema.
