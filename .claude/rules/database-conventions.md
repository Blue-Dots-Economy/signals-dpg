---
paths:
  - "apps/api/src/routes/**"
  - "apps/api/src/services/**"
  - "apps/api/src/utils/**"
  - "apps/api/db/**"
  - "packages/database/**"
---

# Database conventions

DB schema files live in `apps/api/db/postgres/schema/` and migrations in `apps/api/drizzle/`. Since #287 the whole deploy schema is one Drizzle ledger applied by `scripts/migrate.mjs` — **read `apps/api/drizzle/README.md` before touching migrations**: **generated** migrations (declarative tables) must never be hand-edited — change `db/postgres/schema/*.ts` then `pnpm db:generate:api`; **custom** migrations (partitioned/vector/geo tables Drizzle can't express) are hand-written via `drizzle-kit generate --custom`. Extensions and leaf partitions are *not* in the ledger (provisioning prerequisite / runtime creation respectively).

**Item tables are partitioned.** Use the partition-aware query helpers in `@dpg/database` so the planner can prune; ad-hoc queries that select across the parent without a partition key will scan everything. See `packages/database/src/utils/README.md` for the exact contract — those helpers manage partition *creation* (DDL), not query pruning; the pruning contract itself is "always filter on `item_network` + `item_domain`/`action_type`," demonstrated by example at `apps/api/src/utils/item_fetch_runtime.ts`.

`user.tags` is a keyed `jsonb` column (GIN-indexed) for extensible support/ops markers without a migration per flag — current key is `is_test` (marks a user, and by the `created_by`/owner join their profiles/posts/applications, as test data for later bulk cleanup).

**Private locations are jittered at storage time.** `apps/api/src/services/geocoding/jitter.ts` offsets a PII coordinate to a deterministic, keyed-random point in the `PII_LOCATION_JITTER_MIN_METERS`–`PII_LOCATION_JITTER_MAX_METERS` annulus before it is persisted, applied at the storage choke point in `item_service.ts`. The seed is HMAC-keyed with `SIGNALS_PII_KEY` (reused, not a new key), so the same true location always maps to the same pin — re-saving never drifts it and an observer can't average public snapshots back to the truth. The true coordinate is never stored.
