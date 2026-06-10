# Signalstack User-Level Metrics + Directional Action Columns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement §1 of the design doc in signalstack (`Signals-DPG`): emit `profile_item_id`/`user_id` per item, replace flat `count_*` action fields with directional `initiated`/`received` maps, and add user-level rollup numbers — so the aggregator-dpg dashboard can render them.

**Architecture:** Compute stays entirely in signalstack. `item_metrics` stores directional action data as 4 jsonb maps (`initiated`, `received`, `last_initiated_at`, `last_received_at`) instead of 8 flat columns. Recompute splits each tracked interaction by direction (item-as-source → initiated, item-as-target → received). The dashboard route sums these into directional rollups + `total_users`. Status-rule evaluation is unchanged — it is fed combined (`initiated[b]+received[b]`) counts. network.json + its strict Zod validator move to the new tile/bucket shapes (hard cutover, no back-compat alias).

**Tech Stack:** Fastify + Zod (`fastify-type-provider-zod`) + Drizzle ORM + Postgres jsonb. Vitest.

**Reference:** `../specs/2026-06-07-user-level-metrics-directional-actions-design.md`

---

## File structure

- `apps/api/db/postgres/schema/metrics.ts` — drop 8 flat columns, add 4 jsonb columns
- `apps/api/drizzle/*` — regenerated migration (via `pnpm db:generate:api`, never hand-edited)
- `apps/api/src/services/metrics/recompute.ts` — direction-split aggregation + map assembly
- `packages/schemas/src/aggregator/dashboard.ts` — API contract (rollup + item shape)
- `apps/api/src/routes/v1/aggregator/dashboard.ts` — directional rollup SQL + item mapping
- `apps/api/src/routes/v1/aggregator/export.ts` — CSV columns
- `packages/schemas/src/network_workflow.ts` — `DashboardTilesSchema` + directional `DashboardBucketsSchema`
- `examples/schemas/{blue,purple,orange,yellow}_dot/network.json` — new tile/bucket blocks
- Tests: `recompute.test.ts`, `dashboard.test.ts`, `dashboard_multidomain.test.ts`, `export.test.ts`, `network_workflow_metrics.test.ts`, `example_network_configs.test.ts`, `dashboard.integration.test.ts`

## Canonical shapes (used across tasks)

Item (API, `by_domain[d].items[]`):
```jsonc
"profile_item_id": "p-abc",            // required, was omitted; = item_id
"user_id": "u-123",                    // optional passthrough; = owner_user_id
"initiated": { "create": 1, "accept": 0, "reject": 0, "cancel": 0 },   // full map
"received":  { "create": 0, "accept": 1, "reject": 0, "cancel": 0 },   // full map
"last_initiated_at": { "create": "2026-01-01T00:00:00Z" },             // sparse
"last_received_at":  { "accept": "2026-01-02T00:00:00Z" }              // sparse
```
Removed from item: `count_create/accept/reject/cancel`, `last_create/accept/reject/cancel_at`.

Rollup:
```jsonc
"by_initiated_action_status": { "create": 4, "accept": 0, "reject": 0, "cancel": 0 },
"by_received_action_status":  { "create": 0, "accept": 5, "reject": 1, "cancel": 0 },
"total_users": 4
```
Removed from rollup: `by_action_status`. Kept: `avg_items_per_user`, `avg_actions_per_user`.

`dashboard_tiles` (network.json, per domain):
```jsonc
"dashboard_tiles": {
  "profile": [ { "field": "total_items", "label": "..." }, ... ],
  "user":    [ { "field": "total_users", "label": "..." }, { "field": "avg_items_per_user", "label": "..." } ]
}
```
`dashboard_buckets` (network.json): `by_action_status` → `by_initiated_action_status` + `by_received_action_status`.

---

## Task 1: API contract — `packages/schemas/src/aggregator/dashboard.ts`

**Files:** Modify `packages/schemas/src/aggregator/dashboard.ts`

- [ ] **Step 1: Rewrite `ItemRollup` and `ItemRow`.** In `ItemRollup`, drop `by_action_status`; add `by_initiated_action_status: z.record(BucketEnum, z.number())`, `by_received_action_status: z.record(BucketEnum, z.number())`, `total_users: z.number()`. In `ItemRow`, drop the 4 `count_*` and 4 `last_*_at` fields; add `profile_item_id: z.string()`, `user_id: z.string().nullable()`, `initiated: z.record(BucketEnum, z.number())`, `received: z.record(BucketEnum, z.number())`, `last_initiated_at: z.record(BucketEnum, z.string())`, `last_received_at: z.record(BucketEnum, z.string())`. (zod-4 `z.record(enum, T)` is partial-by-default → sparse last-at maps validate.)

- [ ] **Step 2: Typecheck the package.** Run: `pnpm --filter @dpg/schemas typecheck` (or `pnpm typecheck`). Expected: PASS.

- [ ] **Step 3: Commit.** `git add packages/schemas/src/aggregator/dashboard.ts && git commit -m "feat(schemas): directional action maps + user-level rollup in dashboard contract"`

## Task 2: network.json validator — `packages/schemas/src/network_workflow.ts`

**Files:** Modify `packages/schemas/src/network_workflow.ts`

- [ ] **Step 1: Replace `DashboardTileLabelsSchema`** with:
```ts
const DashboardTileSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
}).strict();
const DashboardTilesSchema = z.object({
  profile: z.array(DashboardTileSchema).optional(),
  user: z.array(DashboardTileSchema).optional(),
}).strict();
```
Update the `dashboard_tiles:` field on `NetworkDomainSchema` to `DashboardTilesSchema.optional()`.

- [ ] **Step 2: Update `DashboardBucketsSchema`** — replace the `by_action_status` key with two keys `by_initiated_action_status` and `by_received_action_status`, each the same `{ create/accept/reject/cancel: z.string().min(1).optional() }.strict().optional()` shape.

- [ ] **Step 3: Run validator tests.** Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/network_workflow.test.ts src/__tests__/network_workflow_metrics.test.ts`. Expected: FAIL where old shapes asserted (fixed in Task 8).

- [ ] **Step 4: Commit.** `git add packages/schemas/src/network_workflow.ts && git commit -m "feat(schemas): structured dashboard_tiles + directional dashboard_buckets validation"`

## Task 3: DB schema — `apps/api/db/postgres/schema/metrics.ts`

**Files:** Modify `apps/api/db/postgres/schema/metrics.ts`; regenerate `apps/api/drizzle/*`

- [ ] **Step 1: Swap columns.** Remove `countCreate/countAccept/countReject/countCancel` and `lastCreateAt/lastAcceptAt/lastRejectAt/lastCancelAt`. Add (import `jsonb` from `drizzle-orm/pg-core`):
```ts
initiated: jsonb('initiated').$type<Record<string, number>>().default({}).notNull(),
received: jsonb('received').$type<Record<string, number>>().default({}).notNull(),
lastInitiatedAt: jsonb('last_initiated_at').$type<Record<string, string>>().default({}).notNull(),
lastReceivedAt: jsonb('last_received_at').$type<Record<string, string>>().default({}).notNull(),
```

- [ ] **Step 2: Regenerate migration.** Run: `pnpm db:generate:api`. Expected: a new migration file under `apps/api/drizzle/` dropping/adding the columns. Do NOT hand-edit it.

- [ ] **Step 3: Regenerate schema bundle.** Run: `pnpm schema:bundle`. Expected: `apps/api/db/postgres/schema.sql` updated.

- [ ] **Step 4: Commit.** `git add apps/api/db/postgres/schema/metrics.ts apps/api/drizzle apps/api/db/postgres/schema.sql && git commit -m "feat(db): item_metrics directional jsonb action maps"`

## Task 4: Recompute direction split — `apps/api/src/services/metrics/recompute.ts`

**Files:** Modify `apps/api/src/services/metrics/recompute.ts`; Test `apps/api/src/services/metrics/__tests__/recompute.test.ts`

- [ ] **Step 1: Update test fixture (failing).** In `recompute.test.ts`, change the second `executeMock` row from flat `count_*`/`last_*_at` to direction-split columns the new SQL returns: `initiated_create/accept/reject/cancel`, `received_create/accept/reject/cancel` (ints) and `last_initiated_create_at`...`last_received_cancel_at` (8 timestamps, all null for the empty-action case). Keep the assertion `processed === 1` and add: the upserted row's `initiated`/`received` are `{create:0,accept:0,reject:0,cancel:0}` and `lastInitiatedAt`/`lastReceivedAt` are `{}`.

- [ ] **Step 2: Run test to confirm fail.** Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/recompute.test.ts`. Expected: FAIL.

- [ ] **Step 3: Rewrite `buildInteractionEvents`** to emit a `direction` column. For each tracked interaction touching `domain`: if `fromDomain === domain` push a piece with `source_item_id AS item_id, 'initiated' AS direction`; if `toDomain === domain` push a piece with `target_item_id AS item_id, 'received' AS direction`. (Self-domain interactions emit both pieces.) Each piece still emits `bucket` + `created_at`.

- [ ] **Step 4: Rewrite the `action_counts` CTE** to `GROUP BY item_id, direction` with `COUNT(*) FILTER (WHERE bucket=…)` per bucket and `MAX(created_at) FILTER (WHERE bucket=…)` per bucket. In the main SELECT pivot to one row per item with columns `initiated_<bucket>`, `received_<bucket>`, `last_initiated_<bucket>_at`, `last_received_<bucket>_at` via `MAX(...) FILTER (WHERE direction=…)` over a join, or aggregate the CTE by item_id with nested FILTERs on `(direction, bucket)`. Empty-events branch returns all-zero / all-null columns.

- [ ] **Step 5: Assemble maps in JS.** Build `initiated`/`received` as full 4-key number maps; build `lastInitiatedAt`/`lastReceivedAt` as **sparse** maps (only buckets with a non-null timestamp, ISO string). Feed status DSL with combined `count[b] = initiated[b]+received[b]` and `days_since_last[b] = min(days(lastInitiated[b]), days(lastReceived[b]))` (null when both absent). Update the `item_metrics` insert payload + `flush()` `onConflictDoUpdate` set to the 4 new jsonb fields (drop the 8 old ones). Update `AggregatedRow` interface.

- [ ] **Step 6: Run test to confirm pass.** Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/recompute.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit.** `git add apps/api/src/services/metrics/recompute.ts apps/api/src/services/metrics/__tests__/recompute.test.ts && git commit -m "feat(metrics): split action aggregation into initiated/received maps"`

## Task 5: Dashboard route — `apps/api/src/routes/v1/aggregator/dashboard.ts`

**Files:** Modify `apps/api/src/routes/v1/aggregator/dashboard.ts`; Test `__tests__/dashboard.test.ts`

- [ ] **Step 1: Update unit-test fixtures (failing).** In `dashboard.test.ts`: change `rollup_row` keys from `b_create…b_cancel` to `bi_create…bi_cancel` (initiated) + `br_create…br_cancel` (received) and rename `unique_users` usage so `total_users` is asserted; update `sample_list_row` to set `initiated`/`received` jsonb + `lastInitiatedAt`/`lastReceivedAt` jsonb instead of `countX`/`lastXAt`. Replace the `by_action_status` assertion with `by_initiated_action_status` + `by_received_action_status`, add `total_users` assertion, and in the "items have new column names" test assert `profile_item_id`, `user_id`, `initiated`, `received`, `last_initiated_at`, `last_received_at` and that `count_create`/`last_create_at` are `undefined`.

- [ ] **Step 2: Run to confirm fail.** Run: `pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/dashboard.test.ts`. Expected: FAIL.

- [ ] **Step 3: Rewrite the rollup SQL** in `build_domain_block`: replace the four `SUM(count_*)` with `COALESCE(SUM((initiated->>'create')::int),0) AS bi_create` … for each bucket and direction (8 sums). `has_applications` filter becomes `(initiated+received totals) > 0` via the jsonb-extracted sum. `unique_users` stays → expose as `total_users`. `total_actions` becomes the sum of all 8 directional values; `engaged_users` filter likewise.

- [ ] **Step 4: Rebuild the `rollup` object** — drop `by_action_status`; add `by_initiated_action_status`, `by_received_action_status`, `total_users`. Keep `avg_items_per_user = total_items/total_users`, `avg_actions_per_user = total_actions/engaged_users`.

- [ ] **Step 5: Rewrite item mapping** — add `profile_item_id: r.itemId`, `user_id: r.ownerUserId`; replace `count_*`/`last_*_at` with `initiated: r.initiated ?? {}`, `received: r.received ?? {}`, `last_initiated_at: r.lastInitiatedAt ?? {}`, `last_received_at: r.lastReceivedAt ?? {}`.

- [ ] **Step 6: Run to confirm pass.** Run: `pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/dashboard.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit.** `git add apps/api/src/routes/v1/aggregator/dashboard.ts apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts && git commit -m "feat(aggregator): directional rollups + user-level totals + item maps in dashboard"`

## Task 6: CSV export — `apps/api/src/routes/v1/aggregator/export.ts`

**Files:** Modify `apps/api/src/routes/v1/aggregator/export.ts`; Test `__tests__/export.test.ts`

- [ ] **Step 1: Update `COLUMNS` + projection.** Add `profile_item_id`, `user_id` near the front. Replace `count_*`/`last_*_at` with flattened directional columns: `initiated_create/accept/reject/cancel`, `received_create/accept/reject/cancel`, `last_initiated_create_at`…`last_received_cancel_at`. In the projection, read each from the jsonb maps: `initiated_create: r.initiated?.create ?? 0`, `last_initiated_create_at: r.lastInitiatedAt?.create ?? null`, etc. Add `profile_item_id: r.itemId`, `user_id: r.ownerUserId`.

- [ ] **Step 2: Update `export.test.ts`** header + row expectations to the new column list and jsonb-sourced row fixture.

- [ ] **Step 3: Run.** Run: `pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/export.test.ts`. Expected: PASS.

- [ ] **Step 4: Commit.** `git add apps/api/src/routes/v1/aggregator/export.ts apps/api/src/routes/v1/aggregator/__tests__/export.test.ts && git commit -m "feat(aggregator): directional + identity columns in CSV export"`

## Task 7: network.json config files

**Files:** Modify `examples/schemas/{blue,purple,orange,yellow}_dot/network.json`

- [ ] **Step 1: Per network.json:** convert each domain's `dashboard_tiles` flat map to `{ profile: [...], user: [...] }` (carry existing labels into `profile` entries with `field`/`label`; add `user` entries `total_users` + `avg_items_per_user` with domain-appropriate labels). Convert `dashboard_buckets.by_action_status` → `by_initiated_action_status` + `by_received_action_status` (reuse/adjust the existing labels per direction).

- [ ] **Step 2: Validate configs.** Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/example_network_configs.test.ts`. Expected: PASS (configs parse against the Task 2 schemas).

- [ ] **Step 3: Commit.** `git add examples/schemas && git commit -m "feat(networks): structured dashboard_tiles + directional buckets in network configs"`

## Task 8: Fix remaining schema/integration tests + full sweep

**Files:** Modify `network_workflow_metrics.test.ts`, `dashboard_multidomain.test.ts`, `dashboard.integration.test.ts` as needed

- [ ] **Step 1: Update `network_workflow_metrics.test.ts`** any assertions on `by_action_status` / flat `dashboard_tiles` to the new shapes.

- [ ] **Step 2: Update `dashboard_multidomain.test.ts`** fixtures + assertions to directional rollups/maps + `total_users`.

- [ ] **Step 3: Update `dashboard.integration.test.ts`** assertions (DB-backed) to directional jsonb columns + new API shape. (Run only if `docker compose up -d db redis` is available.)

- [ ] **Step 4: Full unit sweep + typecheck.** Run: `pnpm --filter api test` and `pnpm --filter @dpg/schemas test` and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "test: align metrics/dashboard tests with directional + user-level shapes"`

---

## Self-review notes

- **Spec coverage:** §1.1 (Task 1 item fields + Task 5 mapping), §1.2 (Tasks 1/3/4), §1.3 (Tasks 1/5), §2.6 network.json (Task 7). Validator change (Task 2) is required because signalstack strictly validates network.json. CSV (§2.3) handled Task 6.
- **Hard cutover:** no `by_action_status`/`count_*` back-compat alias anywhere (design "Decisions locked in").
- **Status rules:** unchanged DSL; fed combined counts so existing `status_rules` keep evaluating identically.
- **Merge gate:** this signalstack PR must deploy + be verified before the aggregator-dpg §2 PR merges.
