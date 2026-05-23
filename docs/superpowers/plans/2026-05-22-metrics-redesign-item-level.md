# Metrics Redesign — Item-Level, Per-Domain, Network-Aware Statuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Plan 3's user-keyed `participant_metrics` with an item-keyed `item_metrics` table that supports per-domain status semantics (seeker vs provider), multi-domain aggregators (`org.metadata.domains: string[]`), and network-declared status vocabularies (`metric_categories` in network.json). Dashboard becomes a `by_domain` wrapper carrying per-domain rollups + paginated participants; CSV export adds an `item_domain` column.

**Architecture:** Each `(aggregator, domain)` pair has its own staleness TTL, advisory lock, and recompute path so multi-domain orgs recompute domains in parallel. Two pure status functions (`compute_seeker_status`, `compute_provider_status`) replace Plan 3's single `compute_profile_status`. A new `resolve_metric_categories(network, action_type, from_domain, to_domain)` helper centralizes the network-vocabulary lookup; recompute consumes the returned `{shortlisted, rejected, pending}: string[]` triple to bucket `item_actions.action_status` rows. The handler reads cached snapshots only — no read-time recompute.

**Tech Stack:** Drizzle ORM + Postgres (incl. advisory locks), Fastify, Zod via `fastify-type-provider-zod`, Vitest. Changes in `apps/api/db/postgres/schema/`, `apps/api/src/services/metrics/`, `apps/api/src/routes/v1/aggregator/`, `apps/api/src/routes/v1/admin/aggregator/`, `packages/schemas/src/`, `packages/database/src/utils/sql_scripts/`, `examples/schemas/{blue_dot,purple_dot}/network.json`, plus docs + Postman.

**Spec:** [docs/superpowers/specs/2026-05-22-metrics-redesign-item-level-design.md](../specs/2026-05-22-metrics-redesign-item-level-design.md)

**Related plans:** Plan 2 (attribution columns on `user`), Plan 3 (the metrics module this redesigns), Plan A (aggregator-acting-org action attribution this depends on), Plan C (`/admin/participant` upsert — Plan B's tests use the new endpoint).

---

## File map (created / modified / deleted)

**Created:**
- `apps/api/src/services/metrics/seeker_status.ts` — pure `compute_seeker_status`
- `apps/api/src/services/metrics/__tests__/seeker_status.test.ts` — 6 cases
- `apps/api/src/services/metrics/provider_status.ts` — pure `compute_provider_status`
- `apps/api/src/services/metrics/__tests__/provider_status.test.ts` — 8 cases
- `apps/api/src/services/metrics/metric_categories.ts` — pure `resolve_metric_categories(network, action_type, from_domain, to_domain)`
- `apps/api/src/services/metrics/__tests__/metric_categories.test.ts` — 4 cases (happy/null/missing network/missing interaction)
- `apps/api/src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts` — new shape coverage
- `apps/api/src/routes/v1/aggregator/__tests__/participant_b_integration.test.ts` — env-gated, real PG (mirrors Plan A/C integration shape; renamed to avoid collision with the existing `dashboard.integration.test.ts`)

**Modified:**
- `apps/api/db/postgres/schema/metrics.ts` — drop `participant_metrics`, declare `item_metrics`
- `packages/database/src/utils/sql_scripts/metrics.sql` — bundle rewrite (DROP IF EXISTS + new CREATE TABLE + FK DO-block + indexes)
- `helmcharts/dpg/charts/api/files/schema.sql` — regenerated via `pnpm schema:bundle` (NOT hand-edited)
- `packages/schemas/src/network_workflow.ts` — add `metric_categories` to `NetworkActionInteractionSchema`
- `packages/schemas/src/admin/aggregator_upsert.ts` — add `domains: string[]` to request
- `packages/schemas/src/aggregator/dashboard.ts` — full response-shape rewrite (`by_domain` wrapper, per-domain rollup + participants + total_matching + next_cursor; CSV export query)
- `examples/schemas/blue_dot/network.json` — add `metric_categories` (seeker→provider only; provider→seeker stays null)
- `examples/schemas/purple_dot/network.json` — same
- `apps/api/src/routes/v1/admin/aggregator/upsert.ts` — persist `domains` into metadata JSON
- `apps/api/src/services/metrics/recompute.ts` — full rewrite: per-(aggregator, domain), item-level rows, network-aware action filtering
- `apps/api/src/services/metrics/staleness.ts` — key TTL + advisory lock by `(aggregator, domain)`
- `apps/api/src/services/metrics/actionable_tags.ts` — domain-aware business tags
- `apps/api/src/services/metrics/profile_completion.ts` — unchanged (pure function already item-level in shape; signature stays)
- `apps/api/src/services/metrics/schema_lookup.ts` — minimal change to allow `(network, domain, item_type)` lookups instead of single hardcoded item_type
- `apps/api/src/routes/v1/aggregator/dashboard.ts` — full handler rewrite
- `apps/api/src/routes/v1/aggregator/export.ts` — full handler rewrite (new columns incl. `item_domain`)
- `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts` — rewrite assertions for new response shape
- `apps/api/src/routes/v1/aggregator/__tests__/export.test.ts` — rewrite assertions for new columns
- `docs/operations/integrating-dpgs.md` — replace dashboard section
- `docs/postman/Signals-DPG.postman_collection.json` — `03 Aggregator Onboarding` `Upsert Aggregator` body gains `domains`; `06 Aggregator Metrics` requests document new response shape
- `docs/postman/Blue-Dots.postman_environment.json` + `Purple-Dots.postman_environment.json` — env var `aggregator_domains_json` (e.g. `["seeker","provider"]`)

**Deleted:**
- `apps/api/src/services/metrics/profile_status.ts` (replaced by `seeker_status.ts` + `provider_status.ts`)
- `apps/api/src/services/metrics/__tests__/profile_status.test.ts`
- `apps/api/src/services/metrics/__tests__/recompute.test.ts` — current shape tests user-keyed recompute; rewrite to `recompute.test.ts` covering the new per-(org, domain) flow with item-level fixtures

---

## Task ordering rationale

Schemas and DB structure first (Tasks 1-4) — every other layer reads them. Pure helpers next (Tasks 5-7) — testable in isolation, no DB. Recompute consumes them (Task 8). Staleness key change is small and depends only on recompute's existence (Task 9). Routes (Tasks 10-11) consume the cached state. Integration test (Task 12) exercises the whole stack. Docs + Postman last (Task 13).

---

## Task 1: Drop participant_metrics, create item_metrics

**Files:**
- Modify: `apps/api/db/postgres/schema/metrics.ts`
- Modify: `packages/database/src/utils/sql_scripts/metrics.sql`
- Regenerate: `helmcharts/dpg/charts/api/files/schema.sql` via `pnpm schema:bundle`

- [ ] **Step 1: Pre-read**

```bash
cat apps/api/db/postgres/schema/metrics.ts
cat packages/database/src/utils/sql_scripts/metrics.sql
# Plan A's commit ef2a903 sets the precedent for SQL-bundle ADD COLUMN IF NOT EXISTS
# + DO-block FK pattern. This task's DROP TABLE pattern is new; verify nothing else
# in the bundle still references participant_metrics:
grep -rn "participant_metrics" packages/database/src/utils/sql_scripts apps/api/db/postgres/schema
```

- [ ] **Step 2: Rewrite the Drizzle schema**

Replace the entire content of `apps/api/db/postgres/schema/metrics.ts` with:

```ts
import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

/**
 * Item-keyed metrics for the aggregator dashboard (Plan B).
 *
 * Replaces the Plan 3 `participant_metrics` table. One row per item
 * (not per user) — a user with two profiles gets two rows; a user
 * spanning seeker + provider gets one row per domain.
 *
 * No FK on item_id — `items` is partitioned and Drizzle's FK story
 * doesn't reach partition keys cleanly. Soft reference via the text
 * column; recompute is the only writer.
 *
 * No cascade on onboarded_by_org_id FK — attribution survives org
 * deletion, matching Plan 2's `user.onboardedByOrgId` convention.
 *
 * profile_status is computed per-domain (seeker vs provider) and is
 * never null in practice — the catch-all in compute_provider_status
 * absorbs any non-matching tail into 'inactive'.
 */
export const item_metrics = pgTable('item_metrics', {
  itemId: text('item_id').primaryKey(),
  itemNetwork: text('item_network').notNull(),
  itemDomain: text('item_domain').notNull(),
  itemType: text('item_type').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  profileStatus: text('profile_status'),
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  applicationsTotal: integer('applications_total').default(0),
  applicationsPending: integer('applications_pending').default(0),
  applicationsShortlisted: integer('applications_shortlisted').default(0),
  applicationsRejected: integer('applications_rejected').default(0),

  // Seeker-only (NULL for provider rows)
  lastAppliedAt: timestamp('last_applied_at'),

  // Provider-only (NULL for seeker rows)
  lastShortlistedAt: timestamp('last_shortlisted_at'),
  lastRejectedAt: timestamp('last_rejected_at'),
  openings: integer('openings'),

  actionableTags: text('actionable_tags').array(),

  lastComputedAt: timestamp('last_computed_at').notNull(),
});
```

- [ ] **Step 3: Rewrite the SQL bundle**

Replace the entire content of `packages/database/src/utils/sql_scripts/metrics.sql` with:

```sql
-- packages/database/src/utils/sql_scripts/metrics.sql
--
-- Idempotent SQL bootstrap for Plan B's item_metrics table. Mirrors the
-- Drizzle schema in apps/api/db/postgres/schema/metrics.ts; CI parity
-- check (Plan 4 A.3) fails if they drift.

-- Plan B: drop the user-keyed participant_metrics (Plan 3) outright.
-- Pre-pilot — no production data to preserve. CASCADE handles any
-- inbound FK; recompute is the only writer so there shouldn't be any.
DROP TABLE IF EXISTS participant_metrics CASCADE;

CREATE TABLE IF NOT EXISTS item_metrics (
  item_id                   text PRIMARY KEY,
  item_network              text NOT NULL,
  item_domain               text NOT NULL,
  item_type                 text NOT NULL,
  owner_user_id             text NOT NULL,
  onboarded_by_org_id       text,
  onboarded_via             text,

  profile_status            text,
  profile_completion_pct    integer,
  profile_created_at        timestamp,
  profile_last_updated_at   timestamp,
  age_days                  integer,

  applications_total        integer DEFAULT 0,
  applications_pending      integer DEFAULT 0,
  applications_shortlisted  integer DEFAULT 0,
  applications_rejected     integer DEFAULT 0,

  last_applied_at           timestamp,
  last_shortlisted_at       timestamp,
  last_rejected_at          timestamp,
  openings                  integer,

  actionable_tags           text[],

  last_computed_at          timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_metrics_onboarded_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE item_metrics
      ADD CONSTRAINT item_metrics_onboarded_by_org_id_organization_id_fk
      FOREIGN KEY (onboarded_by_org_id) REFERENCES organization(id);
  END IF;
END
$$;

-- Hot path: dashboard rollup + filter by status within a domain.
CREATE INDEX IF NOT EXISTS item_metrics_org_domain_status_idx
  ON item_metrics (onboarded_by_org_id, item_domain, profile_status);

-- Staleness check: MIN(last_computed_at) per (aggregator, domain).
CREATE INDEX IF NOT EXISTS item_metrics_org_domain_last_computed_idx
  ON item_metrics (onboarded_by_org_id, item_domain, last_computed_at);

-- Per-user rollup queries (avg_profiles_per_user, users_with_applications).
CREATE INDEX IF NOT EXISTS item_metrics_owner_domain_idx
  ON item_metrics (owner_user_id, item_domain);
```

- [ ] **Step 4: Regenerate helm bundle**

```bash
pnpm schema:bundle
```

Expected: `helmcharts/dpg/charts/api/files/schema.sql` rewritten. Verify it includes `DROP TABLE IF EXISTS participant_metrics` + `CREATE TABLE … item_metrics`.

- [ ] **Step 5: Verify bundle parity check**

```bash
pnpm schema:bundle:check
```

Expected: exit 0 (no diff).

- [ ] **Step 6: Apply twice (idempotence)**

```bash
pnpm db:init:api
pnpm db:init:api
```

Expected: both runs succeed. Second run is a no-op for the DROP + CREATE + ALTER + indexes.

- [ ] **Step 7: Sanity-check the columns**

```bash
docker compose exec -T db psql -U postgres -d postgresdb -c "\d item_metrics" | head -30
docker compose exec -T db psql -U postgres -d postgresdb -c "\d participant_metrics" 2>&1 | head -5
```

Expected: `item_metrics` shows all 23 columns; `participant_metrics` returns `Did not find any relation named "participant_metrics"`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/db/postgres/schema/metrics.ts \
        packages/database/src/utils/sql_scripts/metrics.sql \
        helmcharts/dpg/charts/api/files/schema.sql
git commit -m "feat(db): drop participant_metrics, create item_metrics (Plan B)"
```

DO NOT stage `examples/schemas/blue_dot/network.json` or `.env.example` (long-standing local-dev drift that's been noise across PRs).

---

## Task 2: Schema additions — metric_categories + domains

**Files:**
- Modify: `packages/schemas/src/network_workflow.ts` (lines 40-49 — `NetworkActionInteractionSchema`)
- Modify: `packages/schemas/src/admin/aggregator_upsert.ts` (lines 15-28 — request schema)

- [ ] **Step 1: Add `metric_categories` to NetworkActionInteractionSchema**

In `packages/schemas/src/network_workflow.ts`, replace the existing `NetworkActionInteractionSchema` definition:

```ts
const MetricCategoriesSchema = z.object({
  shortlisted: z.array(z.string().min(1)).optional().default([]),
  rejected: z.array(z.string().min(1)).optional().default([]),
  pending: z.array(z.string().min(1)).optional().default([]),
});

const NetworkActionInteractionSchema = z.object({
  from_network: z.string().min(1).optional(),
  from_domain: z.string().min(1),
  from_items: z.string().min(1).array().optional().default([]),
  to_network: z.string().min(1).optional(),
  to_domain: z.string().min(1),
  to_items: z.string().min(1).array().optional().default([]),
  requirement_schema: JsonSchemaDocumentSchema,
  event_schema: JsonSchemaDocumentSchema.optional(),
  metric_categories: MetricCategoriesSchema.nullable().optional(),
});
```

`metric_categories: null` (or absent) means "this direction is not tracked in the rollup yet" — Plan B's recompute treats it identically to `{ shortlisted: [], rejected: [], pending: [] }`.

- [ ] **Step 2: Add `domains` to AggregatorUpsertRequest**

In `packages/schemas/src/admin/aggregator_upsert.ts`, replace the schema:

```ts
export const AggregatorUpsertRequest = z.object({
  external_id: z.string().min(1).describe('aggregator-dpg primary key for this aggregator'),
  name: z.string().min(1).describe('display name'),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric + hyphens')
    .describe('stable url-safe identifier; lookup key for upsert'),
  logo_url: z.url().optional().describe('optional logo url shown in dashboards'),
  domains: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "item domains this aggregator's dashboard reports on (e.g. ['seeker'] or ['seeker','provider']). Persisted as org.metadata.domains. Defaults to [] when omitted; dashboard returns 400 NO_DOMAINS_CONFIGURED until set.",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('opaque metadata stored alongside external_id on the org'),
});
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api exec tsc --noEmit
```

Expected: clean (no callers yet — the api still uses the old metric layers).

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/network_workflow.ts \
        packages/schemas/src/admin/aggregator_upsert.ts
git commit -m "feat(schemas): metric_categories on interactions; domains on aggregator upsert"
```

---

## Task 3: Add metric_categories to blue_dot + purple_dot network.json

**Files:**
- Modify: `examples/schemas/blue_dot/network.json` (interactions block, lines ~263-390)
- Modify: `examples/schemas/purple_dot/network.json` (same shape)
- Modify: `helmcharts/dpg/charts/api/files/networks/blue_dot.json` (deployed copy — check whether it's regenerated from `examples/` or hand-maintained; spec section 3 says network_schema_cache loads from `examples/` by default, but the helm chart ships its own copy at deploy time)

- [ ] **Step 1: Find every network.json**

```bash
find . -name "network.json" -path "*blue_dot*" -not -path "*/node_modules/*"
find . -name "network.json" -path "*purple_dot*" -not -path "*/node_modules/*"
find helmcharts -name "*.json" | xargs grep -l '"actions"' 2>/dev/null
```

There's at least the local `examples/schemas/{blue_dot,purple_dot}/network.json` plus the helm-chart copy at `helmcharts/dpg/charts/api/files/networks/{blue_dot,purple_dot}.json`. Both need to stay in sync (recompute relies on them being identical schemas).

- [ ] **Step 2: Edit `examples/schemas/blue_dot/network.json`**

Inside the `apply` action's first interaction (the `seeker → provider` one, around line 326), add `metric_categories` just after `event_schema`:

```jsonc
{
  "from_network": "blue_dot",
  "from_domain": "seeker",
  "to_network": "blue_dot",
  "to_domain": "provider",
  "requirement_schema": { ... },
  "event_schema": {
    "properties": {
      "status": { "enum": ["created", "submitted", "shortlisted", "rejected"] }
    }
  },
  "metric_categories": {
    "shortlisted": ["shortlisted"],
    "rejected":    ["rejected"],
    "pending":     ["created", "submitted"]
  }
}
```

Inside the second interaction (provider → seeker, around line 388), add `"metric_categories": null` just after `event_schema` — explicit null says "not tracked in the rollup."

- [ ] **Step 3: Edit `examples/schemas/purple_dot/network.json`**

Same pattern. Find the seeker→provider direction (the equivalent of blue_dot's `apply`'s first interaction). Add the matching `metric_categories` using the network's own status enum (read what's in the file — the spec gives blue_dot's exact values; purple_dot may have additional/different status values). The mapping principle:

- `shortlisted`: terminal-positive — the seeker advanced through this provider's funnel.
- `rejected`: terminal-negative — provider rejected the seeker.
- `pending`: any in-flight status (`created`, `submitted`, etc.).

If you're uncertain how purple_dot's status enum maps semantically, leave `metric_categories: null` for the purple_dot seeker→provider interaction and add a comment in the file noting "TODO populate when product confirms purple_dot mapping." (Recompute treats null gracefully: all counts are 0 for null-mapped interactions.)

Provider→seeker direction in purple_dot: `metric_categories: null` always (same out-of-scope decision as blue_dot).

- [ ] **Step 4: Mirror into helm-chart copies**

If `helmcharts/dpg/charts/api/files/networks/blue_dot.json` exists (it does, per the schemas-configmap.yaml `$raw | replace` template), copy the same `metric_categories` blocks there. Same for `purple_dot.json`. These are the artifacts the deployed API loads at boot.

- [ ] **Step 5: Validate JSON parses**

```bash
for f in examples/schemas/blue_dot/network.json \
         examples/schemas/purple_dot/network.json \
         helmcharts/dpg/charts/api/files/networks/blue_dot.json \
         helmcharts/dpg/charts/api/files/networks/purple_dot.json; do
  [ -f "$f" ] && node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f ok";
done
```

Expected: all "ok".

- [ ] **Step 6: Validate the Zod schema accepts the new files**

```bash
pnpm --filter api exec tsc --noEmit
```

If the network_workflow.ts schema rejects the new `metric_categories` block (e.g., due to a typo in your edit), this will fail at the network_config loader path. Tests confirm runtime behavior in Task 6.

- [ ] **Step 7: Commit**

```bash
git add examples/schemas/blue_dot/network.json \
        examples/schemas/purple_dot/network.json \
        helmcharts/dpg/charts/api/files/networks/blue_dot.json \
        helmcharts/dpg/charts/api/files/networks/purple_dot.json
git commit -m "feat(schemas): network.json — metric_categories per interaction (Plan B)"
```

DO NOT stage `examples/schemas/blue_dot/network.json` ONLY IF you have the long-standing local-URL diff. To avoid sweeping that in: `git add -p examples/schemas/blue_dot/network.json` and accept only the `metric_categories` hunk.

---

## Task 4: Persist `domains` in aggregator upsert handler

**Files:**
- Modify: `apps/api/src/routes/v1/admin/aggregator/upsert.ts` (lines 54-87 — the body-handling)
- Modify: `apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts` (existing test — add domains coverage)

- [ ] **Step 1: Pre-read**

```bash
cat apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts | head -60
```

Note the test's `dbState` shape so the new domains assertion plugs into the same harness.

- [ ] **Step 2: Update the handler to thread `domains` into metadata**

In `apps/api/src/routes/v1/admin/aggregator/upsert.ts`, edit `aggregator_upsert_handler` lines 54-63:

```ts
  const { external_id, name, slug, logo_url, domains, metadata } = request.body;

  const [existing] = await db
    .select({ id: organization.id, metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  const meta_obj = { ...(metadata ?? {}), external_id, domains: domains ?? [] };
  const meta_str = JSON.stringify(meta_obj);
```

The rest of the function is unchanged — `meta_str` flows into the UPDATE/INSERT as before.

- [ ] **Step 3: Add failing test cases**

In `apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts`, append two cases:

```ts
  it('persists domains array into metadata when provided', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'ext_a',
        name: 'Agg A',
        slug: 'agg-a',
        domains: ['seeker', 'provider'],
      },
    });
    expect(res.statusCode).toBe(200);
    // The mock should have captured the metadata blob written on INSERT.
    const lastInsert = dbState.inserts.at(-1);
    expect(lastInsert?.metadata).toBeDefined();
    const meta = JSON.parse(lastInsert!.metadata as string);
    expect(meta.domains).toEqual(['seeker', 'provider']);
    expect(meta.external_id).toBe('ext_a');
  });

  it('persists empty domains array when omitted', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: { external_id: 'ext_b', name: 'Agg B', slug: 'agg-b' },
    });
    expect(res.statusCode).toBe(200);
    const lastInsert = dbState.inserts.at(-1);
    const meta = JSON.parse(lastInsert!.metadata as string);
    expect(meta.domains).toEqual([]);
  });
```

If `dbState.inserts` doesn't already capture the metadata field, extend the mock so it does — the same `db.insert(organization).values({...})` mock can push `values.metadata` into a capture array.

- [ ] **Step 4: Run tests, confirm green**

```bash
pnpm --filter api exec vitest run src/routes/v1/admin/aggregator/__tests__/upsert.test.ts
```

Expected: existing tests + 2 new = all PASS.

- [ ] **Step 5: Full unit suite, no regressions**

```bash
pnpm --filter api test
```

Expected: prior baseline + 2 new. Plan C left 136; Plan B Task 1-3 added no api tests; this task adds 2 → 138 total expected.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/admin/aggregator/upsert.ts \
        apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts
git commit -m "feat(api): /admin/aggregator/upsert persists domains into org.metadata"
```

---

## Task 5: Pure status helpers (seeker + provider)

**Files:**
- Create: `apps/api/src/services/metrics/seeker_status.ts`
- Create: `apps/api/src/services/metrics/__tests__/seeker_status.test.ts`
- Create: `apps/api/src/services/metrics/provider_status.ts`
- Create: `apps/api/src/services/metrics/__tests__/provider_status.test.ts`
- Delete: `apps/api/src/services/metrics/profile_status.ts`
- Delete: `apps/api/src/services/metrics/__tests__/profile_status.test.ts`

Note: keep `profile_status.ts` alive UNTIL Task 8's recompute rewrite removes the last import. For now, just leave it untouched; we'll delete it in Task 8.

- [ ] **Step 1: Write the seeker_status failing tests**

Create `apps/api/src/services/metrics/__tests__/seeker_status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compute_seeker_status } from '../seeker_status.js';

const NOW = new Date('2026-05-22T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('compute_seeker_status', () => {
  it("returns 'new' when profile_age <= 7 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(3),
      last_applied_at: null,
      now: NOW,
    })).toBe('new');
  });

  it("returns 'active' when last_applied_age <= 30 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(60),
      last_applied_at: daysAgo(10),
      now: NOW,
    })).toBe('active');
  });

  it("returns 'at_risk' when last_applied_age in 31..90 and profile_age > 7", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(120),
      last_applied_at: daysAgo(45),
      now: NOW,
    })).toBe('at_risk');
  });

  it("returns 'inactive' when last_applied_age > 90 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(200),
      last_applied_at: daysAgo(100),
      now: NOW,
    })).toBe('inactive');
  });

  it("returns 'inactive' when never applied and profile_age > 7 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(30),
      last_applied_at: null,
      now: NOW,
    })).toBe('inactive');
  });

  it("returns 'new' when never applied and profile_age <= 7 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(2),
      last_applied_at: null,
      now: NOW,
    })).toBe('new');
  });
});
```

- [ ] **Step 2: Confirm seeker_status test fails**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/seeker_status.test.ts
```

Expected: FAIL on missing module.

- [ ] **Step 3: Implement seeker_status.ts**

Create `apps/api/src/services/metrics/seeker_status.ts`:

```ts
export type SeekerStatus = 'new' | 'active' | 'at_risk' | 'inactive';

export interface SeekerStatusInput {
  profile_created_at: Date;
  last_applied_at: Date | null;
  now: Date;
}

const MS_PER_DAY = 86_400_000;
const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

/**
 * Seeker-side status computation (Plan B spec §c.Seeker).
 * First-match-wins, in order:
 *   1. profile_age <= 7  → 'new'
 *   2. last_applied_age <= 30 → 'active'
 *   3. profile_age > 7 AND 31 <= last_applied_age <= 90 → 'at_risk'
 *   4. profile_age > 7 AND (no application OR last_applied_age > 90) → 'inactive'
 */
export const compute_seeker_status = (i: SeekerStatusInput): SeekerStatus => {
  const profile_age_days = days_between(i.profile_created_at, i.now);
  const last_applied_age_days =
    i.last_applied_at === null ? null : days_between(i.last_applied_at, i.now);

  if (profile_age_days <= 7) return 'new';
  if (last_applied_age_days !== null && last_applied_age_days <= 30) return 'active';
  if (
    profile_age_days > 7 &&
    last_applied_age_days !== null &&
    last_applied_age_days >= 31 &&
    last_applied_age_days <= 90
  ) {
    return 'at_risk';
  }
  return 'inactive';
};
```

- [ ] **Step 4: Confirm seeker_status tests PASS**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/seeker_status.test.ts
```

Expected: 6/6 PASS.

- [ ] **Step 5: Write the provider_status failing tests**

Create `apps/api/src/services/metrics/__tests__/provider_status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compute_provider_status } from '../provider_status.js';

const NOW = new Date('2026-05-22T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('compute_provider_status', () => {
  it("returns 'new' when job_post_age <= 7", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(3),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('new');
  });

  it("returns 'satisfied' when decisions >= openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(30),
      applications_total: 8,
      applications_shortlisted: 5,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: daysAgo(5),
      last_rejected_at: null,
      now: NOW,
    })).toBe('satisfied');
  });

  it("returns 'active' when min_decision_age <= 30 and decisions < openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(30),
      applications_total: 5,
      applications_shortlisted: 2,
      applications_rejected: 1,
      openings: 10,
      last_shortlisted_at: daysAgo(5),
      last_rejected_at: daysAgo(20),
      now: NOW,
    })).toBe('active');
  });

  it("returns 'at_risk' when min_decision_age in 31..90 and decisions < openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(100),
      applications_total: 5,
      applications_shortlisted: 2,
      applications_rejected: 1,
      openings: 10,
      last_shortlisted_at: daysAgo(50),
      last_rejected_at: null,
      now: NOW,
    })).toBe('at_risk');
  });

  it("returns 'at_risk' when 7 < job_post_age <= 30 and no applications", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(20),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('at_risk');
  });

  it("returns 'inactive' when min_decision_age > 90 and decisions < openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(200),
      applications_total: 3,
      applications_shortlisted: 1,
      applications_rejected: 0,
      openings: 10,
      last_shortlisted_at: daysAgo(120),
      last_rejected_at: null,
      now: NOW,
    })).toBe('inactive');
  });

  it("returns 'inactive' when 31..90 days old and no applications", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(60),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('inactive');
  });

  it("catch-all 'inactive' when job_post_age > 90 and no applications", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(180),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('inactive');
  });
});
```

- [ ] **Step 6: Confirm provider_status test fails, then implement**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/provider_status.test.ts
```

Expected: FAIL on missing module.

Create `apps/api/src/services/metrics/provider_status.ts`:

```ts
export type ProviderStatus = 'new' | 'active' | 'at_risk' | 'satisfied' | 'inactive';

export interface ProviderStatusInput {
  profile_created_at: Date;
  applications_total: number;
  applications_shortlisted: number;
  applications_rejected: number;
  /** Use Number.POSITIVE_INFINITY when the item_type has no `positions` field. */
  openings: number;
  last_shortlisted_at: Date | null;
  last_rejected_at: Date | null;
  now: Date;
}

const MS_PER_DAY = 86_400_000;
const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

const min_not_null = (a: number | null, b: number | null): number | null => {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
};

/**
 * Provider-side status computation (Plan B spec §c.Provider).
 * First-match-wins. Catch-all → 'inactive' so a provider row's
 * profile_status is never null.
 */
export const compute_provider_status = (i: ProviderStatusInput): ProviderStatus => {
  const job_post_age_days = days_between(i.profile_created_at, i.now);
  const applications = i.applications_total;
  const decisions = i.applications_shortlisted + i.applications_rejected;
  const shortlisted_age =
    i.last_shortlisted_at === null ? null : days_between(i.last_shortlisted_at, i.now);
  const rejected_age =
    i.last_rejected_at === null ? null : days_between(i.last_rejected_at, i.now);
  const min_decision_age = min_not_null(shortlisted_age, rejected_age);

  if (job_post_age_days <= 7) return 'new';

  if (applications > 0 && decisions >= i.openings) return 'satisfied';

  if (applications > 0 && min_decision_age !== null && min_decision_age <= 30) {
    return 'active';
  }

  if (
    applications > 0 &&
    min_decision_age !== null &&
    min_decision_age >= 31 &&
    min_decision_age <= 90 &&
    decisions < i.openings
  ) {
    return 'at_risk';
  }
  if (job_post_age_days > 7 && job_post_age_days <= 30 && applications === 0) {
    return 'at_risk';
  }

  // Inactive: three cases, catch-all included
  if (
    applications > 0 &&
    min_decision_age !== null &&
    min_decision_age > 90 &&
    decisions < i.openings
  ) {
    return 'inactive';
  }
  if (job_post_age_days >= 31 && job_post_age_days <= 90 && applications === 0) {
    return 'inactive';
  }
  return 'inactive'; // catch-all
};
```

- [ ] **Step 7: Run both test files**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/seeker_status.test.ts src/services/metrics/__tests__/provider_status.test.ts
```

Expected: 6 + 8 = 14 PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/metrics/seeker_status.ts \
        apps/api/src/services/metrics/provider_status.ts \
        apps/api/src/services/metrics/__tests__/seeker_status.test.ts \
        apps/api/src/services/metrics/__tests__/provider_status.test.ts
git commit -m "feat(metrics): pure seeker/provider status helpers + tests"
```

---

## Task 6: `resolve_metric_categories` helper

**Files:**
- Create: `apps/api/src/services/metrics/metric_categories.ts`
- Create: `apps/api/src/services/metrics/__tests__/metric_categories.test.ts`

- [ ] **Step 1: Failing test**

Create `apps/api/src/services/metrics/__tests__/metric_categories.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve_metric_categories } from '../metric_categories.js';
import type { NetworkConfigDocument } from '@dpg/schemas';

const baseConfig = (interaction: Record<string, unknown>): NetworkConfigDocument => ({
  id: 'blue_dot',
  domains: [],
  instances: [],
  cross_network_origins: [],
  actions: {
    apply: {
      interactions: [interaction as never],
    },
  },
} as unknown as NetworkConfigDocument);

describe('resolve_metric_categories', () => {
  it('returns the metric_categories triple for a matching interaction', () => {
    const cfg = baseConfig({
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: {},
      metric_categories: {
        shortlisted: ['shortlisted'],
        rejected: ['rejected'],
        pending: ['created', 'submitted'],
      },
    });
    const result = resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'seeker',
      toDomain: 'provider',
    });
    expect(result).toEqual({
      shortlisted: ['shortlisted'],
      rejected: ['rejected'],
      pending: ['created', 'submitted'],
    });
  });

  it("returns null when interaction has metric_categories: null (out of scope)", () => {
    const cfg = baseConfig({
      from_domain: 'provider',
      to_domain: 'seeker',
      requirement_schema: {},
      metric_categories: null,
    });
    expect(resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'provider',
      toDomain: 'seeker',
    })).toBeNull();
  });

  it('returns null when the interaction has no metric_categories key at all', () => {
    const cfg = baseConfig({
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: {},
    });
    expect(resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'seeker',
      toDomain: 'provider',
    })).toBeNull();
  });

  it('returns null when no matching interaction exists', () => {
    const cfg = baseConfig({
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: {},
      metric_categories: { shortlisted: ['x'], rejected: [], pending: [] },
    });
    expect(resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'provider',  // direction reversed
      toDomain: 'seeker',
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Confirm it fails, then implement**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/metric_categories.test.ts
```

Expected: FAIL on missing module.

Create `apps/api/src/services/metrics/metric_categories.ts`:

```ts
import type { NetworkConfigDocument } from '@dpg/schemas';

export interface MetricCategoriesTriple {
  shortlisted: string[];
  rejected: string[];
  pending: string[];
}

export interface ResolveInput {
  actionType: string;
  fromDomain: string;
  toDomain: string;
}

/**
 * Resolve the metric_categories triple for a `(action_type, from_domain,
 * to_domain)` interaction in a network's config. Returns `null` when:
 *   - The action_type isn't declared,
 *   - No interaction matches the (from, to) direction, or
 *   - The matching interaction has `metric_categories: null` (or absent).
 *
 * Plan B's recompute treats null identically to a zeroed triple — all
 * counts stay 0 for that direction (e.g. provider→seeker invites today).
 */
export const resolve_metric_categories = (
  networkConfig: NetworkConfigDocument,
  input: ResolveInput,
): MetricCategoriesTriple | null => {
  const action = networkConfig.actions[input.actionType];
  if (!action) return null;

  const interaction = action.interactions.find(
    (entry) =>
      entry.from_domain === input.fromDomain &&
      entry.to_domain === input.toDomain,
  );
  if (!interaction) return null;

  // The Zod schema lifts `metric_categories` to optional + nullable.
  const mc = (interaction as { metric_categories?: MetricCategoriesTriple | null })
    .metric_categories;
  if (!mc) return null;
  return {
    shortlisted: mc.shortlisted ?? [],
    rejected: mc.rejected ?? [],
    pending: mc.pending ?? [],
  };
};
```

- [ ] **Step 3: Confirm tests PASS**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/metric_categories.test.ts
```

Expected: 4/4 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/metrics/metric_categories.ts \
        apps/api/src/services/metrics/__tests__/metric_categories.test.ts
git commit -m "feat(metrics): resolve_metric_categories helper + tests"
```

---

## Task 7: Domain-aware `actionable_tags`

**Files:**
- Modify: `apps/api/src/services/metrics/actionable_tags.ts`
- Modify: `apps/api/src/services/metrics/__tests__/actionable_tags.test.ts`

- [ ] **Step 1: Pre-read existing tests**

```bash
cat apps/api/src/services/metrics/__tests__/actionable_tags.test.ts | head -80
```

Plan 3's tests cover the seeker-side schema-derived `missing_*` tags + the `all_applications_rejected` + `no_recent_activity` business tags. Plan B adds the provider-side business tags.

- [ ] **Step 2: Update the actionable_tags input + output**

Replace the body of `apps/api/src/services/metrics/actionable_tags.ts`:

```ts
import { is_populated } from './profile_completion.js';

interface ActionableTagsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export type ActionableDomain = 'seeker' | 'provider';

export interface ActionableTagsInput {
  domain: ActionableDomain;
  payload: Record<string, unknown>;
  schema: ActionableTagsSchema;
  applications_total: number;
  applications_rejected: number;
  job_post_age_days: number;  // for provider; recompute passes 0 for seekers
  last_applied_age_days: number | null;  // seeker only
  min_decision_age_days: number | null;  // provider only
}

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Schema-derived `missing_<required>` tags + domain-aware business tags.
 *
 * - Seeker business tags: `all_applications_rejected`, `no_recent_activity`.
 * - Provider business tags: `no_applications_yet`, `decisions_overdue`.
 */
export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];

  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }

  if (i.domain === 'seeker') {
    if (i.applications_total > 0 && i.applications_rejected === i.applications_total) {
      tags.push('all_applications_rejected');
    }
    if (i.last_applied_age_days !== null && i.last_applied_age_days > 30) {
      tags.push('no_recent_activity');
    }
  } else {
    // provider
    if (i.applications_total === 0 && i.job_post_age_days > 7) {
      tags.push('no_applications_yet');
    }
    if (i.min_decision_age_days !== null && i.min_decision_age_days > 30) {
      tags.push('decisions_overdue');
    }
  }

  return tags;
};
```

- [ ] **Step 3: Update the test file**

Replace `apps/api/src/services/metrics/__tests__/actionable_tags.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

const seekerSchema = {
  type: 'object',
  required: ['Phone Number', 'Email'],
  properties: { 'Phone Number': {}, 'Email': {}, 'Bio': {} },
};

const providerSchema = {
  type: 'object',
  required: ['Company Name', 'Role'],
  properties: { 'Company Name': {}, 'Role': {} },
};

describe('compute_actionable_tags (seeker)', () => {
  it('adds missing_<required> in schema.required order', () => {
    const tags = compute_actionable_tags({
      domain: 'seeker',
      payload: { Email: 'a@b' },
      schema: seekerSchema,
      applications_total: 0,
      applications_rejected: 0,
      job_post_age_days: 0,
      last_applied_age_days: null,
      min_decision_age_days: null,
    });
    expect(tags).toEqual(['missing_phone_number', 'no_recent_activity'].filter(t => t !== 'no_recent_activity'));
    // last_applied_age_days null and applications_total=0 → no business tags
    expect(tags).toEqual(['missing_phone_number']);
  });

  it("adds 'all_applications_rejected' only when total > 0 AND rejected == total", () => {
    const tags = compute_actionable_tags({
      domain: 'seeker',
      payload: { 'Phone Number': '1', Email: 'a@b' },
      schema: seekerSchema,
      applications_total: 3,
      applications_rejected: 3,
      job_post_age_days: 0,
      last_applied_age_days: 5,
      min_decision_age_days: null,
    });
    expect(tags).toContain('all_applications_rejected');
    expect(tags).not.toContain('no_recent_activity');
  });

  it("adds 'no_recent_activity' when last_applied_age > 30", () => {
    const tags = compute_actionable_tags({
      domain: 'seeker',
      payload: { 'Phone Number': '1', Email: 'a@b' },
      schema: seekerSchema,
      applications_total: 1,
      applications_rejected: 0,
      job_post_age_days: 0,
      last_applied_age_days: 45,
      min_decision_age_days: null,
    });
    expect(tags).toContain('no_recent_activity');
  });
});

describe('compute_actionable_tags (provider)', () => {
  it("adds 'no_applications_yet' when applications_total == 0 AND job_post_age > 7", () => {
    const tags = compute_actionable_tags({
      domain: 'provider',
      payload: { 'Company Name': 'Acme', Role: 'Eng' },
      schema: providerSchema,
      applications_total: 0,
      applications_rejected: 0,
      job_post_age_days: 30,
      last_applied_age_days: null,
      min_decision_age_days: null,
    });
    expect(tags).toContain('no_applications_yet');
  });

  it("does NOT add 'no_applications_yet' when job_post_age <= 7", () => {
    const tags = compute_actionable_tags({
      domain: 'provider',
      payload: { 'Company Name': 'Acme', Role: 'Eng' },
      schema: providerSchema,
      applications_total: 0,
      applications_rejected: 0,
      job_post_age_days: 3,
      last_applied_age_days: null,
      min_decision_age_days: null,
    });
    expect(tags).not.toContain('no_applications_yet');
  });

  it("adds 'decisions_overdue' when min_decision_age > 30", () => {
    const tags = compute_actionable_tags({
      domain: 'provider',
      payload: { 'Company Name': 'Acme', Role: 'Eng' },
      schema: providerSchema,
      applications_total: 5,
      applications_rejected: 1,
      job_post_age_days: 60,
      last_applied_age_days: null,
      min_decision_age_days: 45,
    });
    expect(tags).toContain('decisions_overdue');
  });
});
```

- [ ] **Step 4: Run tests, confirm PASS**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/actionable_tags.test.ts
```

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/actionable_tags.ts \
        apps/api/src/services/metrics/__tests__/actionable_tags.test.ts
git commit -m "feat(metrics): domain-aware actionable_tags (seeker + provider)"
```

---

## Task 8: Rewrite recompute.ts

**Files:**
- Modify: `apps/api/src/services/metrics/recompute.ts` (full rewrite)
- Modify: `apps/api/src/services/metrics/__tests__/recompute.test.ts` (full rewrite)
- Delete: `apps/api/src/services/metrics/profile_status.ts` (replaced by Task 5's helpers)
- Delete: `apps/api/src/services/metrics/__tests__/profile_status.test.ts`
- Modify: `apps/api/src/services/metrics/schema_lookup.ts` (allow (network, domain, item_type) parameterization)

- [ ] **Step 1: Update schema_lookup.ts to accept (network, domain, item_type)**

Current `get_schema_for_aggregator(aggregator_id)` hardcodes `profile_1.0`. Plan B needs it parametrized — change the API to `get_item_schema(network, domain, item_type)`, which the recompute calls per item.

Replace `apps/api/src/services/metrics/schema_lookup.ts`:

```ts
import { getNetworkConfigById } from '@/network_configs';
import { getDomainItemSchema } from '@dpg/schemas';

export interface JSONSchemaLike {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

/**
 * Resolve the JSON Schema for a given (network, domain, item_type).
 * Plan B's recompute calls this per item (since one aggregator can host
 * multiple item_types). Throws if the triple has no schema configured —
 * recompute treats that as fatal so the dashboard doesn't silently fall
 * back to "everyone is 0% complete."
 */
export const get_item_schema = async (
  network: string,
  domain: string,
  item_type: string,
): Promise<JSONSchemaLike> => {
  const networkConfig = await getNetworkConfigById(network);
  const schema = getDomainItemSchema(networkConfig, domain, item_type);
  return schema as JSONSchemaLike;
};
```

Confirm `getDomainItemSchema` is exported by `@dpg/schemas` (it's referenced by Plan 3's existing schema_lookup.ts). If not, look at `packages/schemas/src/` for the helper and re-export it.

- [ ] **Step 2: Write the failing recompute tests**

Replace `apps/api/src/services/metrics/__tests__/recompute.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable DB state captured by mocks
const dbState: {
  itemRows: Array<Record<string, unknown>>;
  actionRows: Array<Record<string, unknown>>;
  upserts: Array<Record<string, unknown>>;
  userRows: Array<{ id: string; onboardedByOrgId: string | null; onboardedVia: string | null }>;
} = { itemRows: [], actionRows: [], upserts: [], userRows: [] };

vi.mock('@api/db/postgres/drizzle_config', () => {
  const execute = vi.fn(async (sqlObj: unknown) => {
    // Recompute uses a single CTE per (aggregator, domain) to fetch items
    // + counts. Return our test fixtures as { rows: [...] }.
    return { rows: dbState.itemRows };
  });
  const insert = vi.fn(() => ({
    values: vi.fn((rows: Array<Record<string, unknown>>) => ({
      onConflictDoUpdate: vi.fn(() => {
        dbState.upserts.push(...rows);
        return Promise.resolve();
      }),
    })),
  }));
  return { db: { execute, insert } };
});

vi.mock('../schema_lookup.js', () => ({
  get_item_schema: vi.fn(async () => ({
    type: 'object',
    required: ['name', 'phone'],
    properties: { name: {}, phone: {}, bio: {} },
  })),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'blue_dot',
    actions: {
      apply: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              shortlisted: ['shortlisted'],
              rejected: ['rejected'],
              pending: ['created', 'submitted'],
            },
          },
        ],
      },
    },
  })),
}));

import { recompute_aggregator_domain_metrics } from '../recompute.js';

const sample_seeker_row = {
  item_id: 'item_seeker_1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  owner_user_id: 'usr_1',
  onboarded_by_org_id: 'org_a',
  onboarded_via: 'bulk',
  item_state: { name: 'A', phone: '+91' },
  profile_created_at: new Date('2026-05-15'),
  profile_last_updated_at: new Date('2026-05-15'),
  applications_total: 3,
  applications_pending: 1,
  applications_shortlisted: 1,
  applications_rejected: 1,
  last_applied_at: new Date('2026-05-20'),
  last_shortlisted_at: null,
  last_rejected_at: null,
  openings: null,
};

describe('recompute_aggregator_domain_metrics', () => {
  beforeEach(() => {
    dbState.itemRows = [];
    dbState.actionRows = [];
    dbState.upserts = [];
    dbState.userRows = [];
  });

  it('handles an empty aggregator gracefully', async () => {
    dbState.itemRows = [];
    const result = await recompute_aggregator_domain_metrics('org_a', 'seeker');
    expect(result.processed).toBe(0);
    expect(dbState.upserts).toEqual([]);
  });

  it('upserts one row per seeker item with computed status + tags', async () => {
    dbState.itemRows = [sample_seeker_row];
    const result = await recompute_aggregator_domain_metrics('org_a', 'seeker');
    expect(result.processed).toBe(1);
    expect(dbState.upserts).toHaveLength(1);
    const r = dbState.upserts[0];
    expect(r.itemId).toBe('item_seeker_1');
    expect(r.itemDomain).toBe('seeker');
    expect(r.applicationsTotal).toBe(3);
    expect(r.applicationsShortlisted).toBe(1);
    expect(r.applicationsRejected).toBe(1);
    expect(r.profileStatus).toBeTruthy();  // exact value depends on now/dates
  });

  it('flushes in batches above 1000 rows', async () => {
    dbState.itemRows = Array.from({ length: 2500 }, (_, i) => ({
      ...sample_seeker_row,
      item_id: `item_${i}`,
    }));
    const result = await recompute_aggregator_domain_metrics('org_a', 'seeker');
    expect(result.processed).toBe(2500);
    expect(dbState.upserts).toHaveLength(2500);
  });
});
```

- [ ] **Step 3: Confirm tests fail (missing function)**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/recompute.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement the new recompute**

Replace `apps/api/src/services/metrics/recompute.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../db/postgres/schema/metrics.js';
import { profile_completion_pct } from './profile_completion.js';
import { compute_seeker_status } from './seeker_status.js';
import { compute_provider_status } from './provider_status.js';
import { compute_actionable_tags } from './actionable_tags.js';
import { get_item_schema } from './schema_lookup.js';
import { resolve_metric_categories } from './metric_categories.js';
import { getNetworkConfigById } from '@/network_configs';

const BATCH_SIZE = 1000;
const MS_PER_DAY = 86_400_000;
const APPLY_ACTION_TYPE = 'apply';

const to_date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  throw new TypeError(`to_date: unexpected ${typeof v}`);
};

const days_between_or_null = (d: Date | null, now: Date): number | null =>
  d === null ? null : Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);

export interface RecomputeResult {
  processed: number;
  duration_ms: number;
}

type RecomputeRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  owner_user_id: string;
  onboarded_by_org_id: string | null;
  onboarded_via: string | null;
  item_state: Record<string, unknown> | null;
  profile_created_at: Date | string | null;
  profile_last_updated_at: Date | string | null;
  applications_total: number;
  applications_pending: number;
  applications_shortlisted: number;
  applications_rejected: number;
  last_applied_at: Date | string | null;
  last_shortlisted_at: Date | string | null;
  last_rejected_at: Date | string | null;
  openings: number | null;
} & Record<string, unknown>;

/**
 * Recomputes item_metrics for the `(aggregator, domain)` pair.
 *
 * Items selected: `items.created_by IN (users with onboarded_by_org_id =
 * aggregator_id) AND items.item_domain = $domain`. The CTE aggregates
 * action counts by reading `item_actions` with direction filtering — for
 * seeker items, source_item_id matches and the seeker→provider interaction
 * is consulted; for provider items, target_item_id matches the same
 * interaction.
 *
 * Action_status → bucket assignment uses `metric_categories` from the
 * network's interaction config. If `metric_categories` is null for this
 * direction, all counts return 0.
 *
 * Status + actionable_tags use the per-domain helpers from Tasks 5 + 7.
 *
 * Caller is the staleness layer (Task 9): runs inside a PG advisory lock
 * keyed by `(aggregator_id, domain)`.
 */
export const recompute_aggregator_domain_metrics = async (
  aggregator_id: string,
  domain: string,
): Promise<RecomputeResult> => {
  const started = Date.now();
  const now = new Date();

  // Step 1: figure out which network this domain belongs to (assumption:
  // a single instance serves one network per domain — read served_domains
  // OR the first item we find tells us). The recompute query joins items
  // → users; we infer the network from items.item_network.
  //
  // The CTE below collects items + counts in one round-trip. The
  // metric_categories filter happens server-side via PG arrays for speed.
  //
  // For seeker items: count actions where source_item_id = item_id.
  // For provider items: count actions where target_item_id = item_id.
  //
  // Both sides bucket by metric_categories.{shortlisted,rejected,pending}.

  // We need metric_categories BEFORE the SQL so we can interpolate the
  // string arrays into FILTER clauses. Look up the network config once;
  // metric_categories per network may differ but inside one (network,
  // domain) the answer is constant — we run the recompute per (org,
  // domain), so within one call all items share the SAME network (an
  // aggregator's domain is served by one Signals instance / one network).
  //
  // Quick lookup: read one item to learn the network, then resolve.
  const sample = (await db.execute(sql`
    SELECT items.item_network FROM items
    JOIN "user" u ON u.id = items.created_by
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND items.item_domain = ${domain}
    LIMIT 1;
  `)) as { rows?: Array<{ item_network: string }> };
  const sampleRows = Array.isArray(sample) ? (sample as Array<{ item_network: string }>) : (sample.rows ?? []);

  let mc: { shortlisted: string[]; rejected: string[]; pending: string[] } | null = null;
  let network_for_query: string | null = null;
  if (sampleRows.length > 0) {
    network_for_query = sampleRows[0].item_network;
    const cfg = await getNetworkConfigById(network_for_query);
    mc = resolve_metric_categories(cfg, {
      actionType: APPLY_ACTION_TYPE,
      fromDomain: 'seeker',
      toDomain: 'provider',
    });
  }

  // If no items at all → empty result.
  if (network_for_query === null) {
    return { processed: 0, duration_ms: Date.now() - started };
  }

  const shortlisted = mc?.shortlisted ?? [];
  const rejected = mc?.rejected ?? [];
  const pending = mc?.pending ?? [];

  const item_match_col = domain === 'seeker'
    ? sql`ia.source_item_id`
    : sql`ia.target_item_id`;

  // CTE: items → app counts via the appropriate side.
  const result = await db.execute<RecomputeRow>(sql`
    WITH app_counts AS (
      SELECT
        ${item_match_col} AS item_id,
        COUNT(*)::int                                                                  AS total,
        COUNT(*) FILTER (WHERE ia.action_status = ANY(${pending}::text[]))::int        AS pending,
        COUNT(*) FILTER (WHERE ia.action_status = ANY(${shortlisted}::text[]))::int    AS shortlisted,
        COUNT(*) FILTER (WHERE ia.action_status = ANY(${rejected}::text[]))::int       AS rejected,
        MAX(ia.created_at) FILTER (WHERE ia.action_status = ANY(${shortlisted}::text[])) AS last_shortlisted_at,
        MAX(ia.created_at) FILTER (WHERE ia.action_status = ANY(${rejected}::text[]))    AS last_rejected_at,
        MAX(ia.created_at)                                                               AS last_applied_at
      FROM item_actions ia
      WHERE ia.action_type = ${APPLY_ACTION_TYPE}
        AND ia.source_item_domain = 'seeker'
        AND ia.target_item_domain = 'provider'
      GROUP BY ${item_match_col}
    )
    SELECT
      i.item_id                              AS item_id,
      i.item_network                         AS item_network,
      i.item_domain                          AS item_domain,
      i.item_type                            AS item_type,
      i.created_by                           AS owner_user_id,
      u.onboarded_by_org_id                  AS onboarded_by_org_id,
      u.onboarded_via                        AS onboarded_via,
      i.item_state                           AS item_state,
      i.created_at                           AS profile_created_at,
      i.updated_at                           AS profile_last_updated_at,
      COALESCE(ac.total,       0)            AS applications_total,
      COALESCE(ac.pending,     0)            AS applications_pending,
      COALESCE(ac.shortlisted, 0)            AS applications_shortlisted,
      COALESCE(ac.rejected,    0)            AS applications_rejected,
      ac.last_applied_at                     AS last_applied_at,
      ac.last_shortlisted_at                 AS last_shortlisted_at,
      ac.last_rejected_at                    AS last_rejected_at,
      (i.item_state ->> 'positions')::int    AS openings
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    LEFT JOIN app_counts ac ON ac.item_id = i.item_id
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain};
  `);

  const rows: RecomputeRow[] = Array.isArray(result)
    ? (result as RecomputeRow[])
    : ((result as { rows?: RecomputeRow[] }).rows ?? []);

  let processed = 0;
  let buffer: Array<typeof item_metrics.$inferInsert> = [];

  for (const r of rows) {
    const payload = r.item_state ?? {};
    const profile_created = to_date(r.profile_created_at) ?? now;
    const profile_updated = to_date(r.profile_last_updated_at) ?? profile_created;
    const last_applied = to_date(r.last_applied_at);
    const last_shortlisted = to_date(r.last_shortlisted_at);
    const last_rejected = to_date(r.last_rejected_at);

    const age_days = Math.floor((now.getTime() - profile_created.getTime()) / MS_PER_DAY);
    const last_applied_age = days_between_or_null(last_applied, now);
    const min_decision_age = (() => {
      const s = days_between_or_null(last_shortlisted, now);
      const j = days_between_or_null(last_rejected, now);
      if (s === null && j === null) return null;
      if (s === null) return j;
      if (j === null) return s;
      return Math.min(s, j);
    })();

    const item_schema = await get_item_schema(r.item_network, r.item_domain, r.item_type);

    const status: string = r.item_domain === 'seeker'
      ? compute_seeker_status({
          profile_created_at: profile_created,
          last_applied_at: last_applied,
          now,
        })
      : compute_provider_status({
          profile_created_at: profile_created,
          applications_total: r.applications_total,
          applications_shortlisted: r.applications_shortlisted,
          applications_rejected: r.applications_rejected,
          openings: r.openings ?? Number.POSITIVE_INFINITY,
          last_shortlisted_at: last_shortlisted,
          last_rejected_at: last_rejected,
          now,
        });

    buffer.push({
      itemId: r.item_id,
      itemNetwork: r.item_network,
      itemDomain: r.item_domain,
      itemType: r.item_type,
      ownerUserId: r.owner_user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      profileStatus: status,
      profileCompletionPct: profile_completion_pct(payload, item_schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: age_days,
      applicationsTotal: r.applications_total,
      applicationsPending: r.applications_pending,
      applicationsShortlisted: r.applications_shortlisted,
      applicationsRejected: r.applications_rejected,
      lastAppliedAt: r.item_domain === 'seeker' ? last_applied : null,
      lastShortlistedAt: r.item_domain === 'provider' ? last_shortlisted : null,
      lastRejectedAt: r.item_domain === 'provider' ? last_rejected : null,
      openings: r.item_domain === 'provider' ? r.openings : null,
      actionableTags: compute_actionable_tags({
        domain: r.item_domain === 'seeker' ? 'seeker' : 'provider',
        payload,
        schema: item_schema,
        applications_total: r.applications_total,
        applications_rejected: r.applications_rejected,
        job_post_age_days: age_days,
        last_applied_age_days: last_applied_age,
        min_decision_age_days: min_decision_age,
      }),
      lastComputedAt: now,
    });

    if (buffer.length >= BATCH_SIZE) {
      await flush(buffer);
      processed += buffer.length;
      buffer = [];
    }
  }

  if (buffer.length > 0) {
    await flush(buffer);
    processed += buffer.length;
  }

  return { processed, duration_ms: Date.now() - started };
};

const flush = async (rows: Array<typeof item_metrics.$inferInsert>): Promise<void> => {
  await db
    .insert(item_metrics)
    .values(rows)
    .onConflictDoUpdate({
      target: item_metrics.itemId,
      set: {
        itemNetwork: sql`excluded.item_network`,
        itemDomain: sql`excluded.item_domain`,
        itemType: sql`excluded.item_type`,
        ownerUserId: sql`excluded.owner_user_id`,
        onboardedByOrgId: sql`excluded.onboarded_by_org_id`,
        onboardedVia: sql`excluded.onboarded_via`,
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileCreatedAt: sql`excluded.profile_created_at`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        applicationsTotal: sql`excluded.applications_total`,
        applicationsPending: sql`excluded.applications_pending`,
        applicationsShortlisted: sql`excluded.applications_shortlisted`,
        applicationsRejected: sql`excluded.applications_rejected`,
        lastAppliedAt: sql`excluded.last_applied_at`,
        lastShortlistedAt: sql`excluded.last_shortlisted_at`,
        lastRejectedAt: sql`excluded.last_rejected_at`,
        openings: sql`excluded.openings`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
```

- [ ] **Step 5: Delete Plan 3's obsolete files**

```bash
git rm apps/api/src/services/metrics/profile_status.ts \
       apps/api/src/services/metrics/__tests__/profile_status.test.ts
```

- [ ] **Step 6: Run the recompute tests**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/recompute.test.ts
```

Expected: 3 PASS (empty + one-item + batch flush).

If the sample CTE query mock needs adjustment (the mock returns `dbState.itemRows` for ANY `db.execute` call), and the recompute first issues a separate "sample" query to learn the network — make the mock smart enough to return either the sample or the main rows. A simple way: detect whether the query string contains `LIMIT 1` (sample) or not (main).

- [ ] **Step 7: Full api suite check**

```bash
pnpm --filter api test
```

Plan 3's profile_status tests are deleted → count drops by ~5 there. Tasks 5-7 add 14+4+6 = 24 new. Task 8 adds 3 → net ~+22.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/metrics/recompute.ts \
        apps/api/src/services/metrics/schema_lookup.ts \
        apps/api/src/services/metrics/__tests__/recompute.test.ts \
        apps/api/src/services/metrics/profile_status.ts \
        apps/api/src/services/metrics/__tests__/profile_status.test.ts
git commit -m "feat(metrics): rewrite recompute — per-(aggregator,domain), item-level"
```

---

## Task 9: Update staleness — key by (aggregator, domain)

**Files:**
- Modify: `apps/api/src/services/metrics/staleness.ts`
- Modify: `apps/api/src/services/metrics/__tests__/staleness.test.ts`

- [ ] **Step 1: Update staleness.ts**

Replace `apps/api/src/services/metrics/staleness.ts`:

```ts
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../db/postgres/schema/metrics.js';
import { sql, and, eq, min } from 'drizzle-orm';
import { recompute_aggregator_domain_metrics } from './recompute.js';
import { createHash } from 'node:crypto';

export const TTL_SECONDS = Number(
  process.env.DASHBOARD_CACHE_TTL_SECONDS ?? '3600',
);

const lock_key_for = (aggregator_id: string, domain: string): bigint => {
  const hash = createHash('sha256').update(`${aggregator_id}:${domain}`).digest();
  return hash.readBigInt64BE(0) & 0x7fffffffffffffffn;
};

export interface StalenessResult {
  refreshed: boolean;
  last_computed_at: Date | null;
}

/**
 * Per-(aggregator, domain) staleness check + recompute under PG advisory
 * lock. Multi-domain orgs hit this in parallel — each (org, domain) has
 * its own lock, so domains don't block each other.
 */
export const check_and_refresh_if_stale = async (
  aggregator_id: string,
  domain: string,
): Promise<StalenessResult> => {
  const [row] = await db
    .select({ ts: min(item_metrics.lastComputedAt) })
    .from(item_metrics)
    .where(
      and(
        eq(item_metrics.onboardedByOrgId, aggregator_id),
        eq(item_metrics.itemDomain, domain),
      ),
    );

  const min_ts = (row?.ts as Date | null | undefined) ?? null;
  const stale =
    min_ts === null || (Date.now() - min_ts.getTime()) / 1000 > TTL_SECONDS;

  if (!stale) {
    return { refreshed: false, last_computed_at: min_ts };
  }

  const lock_key = lock_key_for(aggregator_id, domain);
  const lockResult: unknown = await db.execute(
    sql`SELECT pg_try_advisory_lock(${lock_key.toString()}::bigint) AS locked`,
  );
  const lock_rows: Array<{ locked?: unknown }> = Array.isArray(lockResult)
    ? (lockResult as Array<{ locked?: unknown }>)
    : ((lockResult as { rows?: Array<{ locked?: unknown }> }).rows ?? []);
  const locked = lock_rows[0]?.locked === true;

  if (!locked) {
    return { refreshed: false, last_computed_at: min_ts };
  }

  try {
    await recompute_aggregator_domain_metrics(aggregator_id, domain);
  } finally {
    await db.execute(
      sql`SELECT pg_advisory_unlock(${lock_key.toString()}::bigint)`,
    );
  }

  const [after] = await db
    .select({ ts: min(item_metrics.lastComputedAt) })
    .from(item_metrics)
    .where(
      and(
        eq(item_metrics.onboardedByOrgId, aggregator_id),
        eq(item_metrics.itemDomain, domain),
      ),
    );

  return {
    refreshed: true,
    last_computed_at: (after?.ts as Date | null | undefined) ?? null,
  };
};
```

- [ ] **Step 2: Update staleness.test.ts**

Read the existing `staleness.test.ts` and:
- Change `check_and_refresh_if_stale(aggregator_id)` → `check_and_refresh_if_stale(aggregator_id, domain)`.
- Update the mocked `recompute_aggregator_metrics` import → `recompute_aggregator_domain_metrics`.
- Update the mocked `participant_metrics` → `item_metrics` references.

The semantics + branches the tests exercise (fresh / stale / no-lock-skip / refresh-on-lock-acquired) stay the same.

- [ ] **Step 3: Run staleness tests**

```bash
pnpm --filter api exec vitest run src/services/metrics/__tests__/staleness.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Full api suite**

```bash
pnpm --filter api test
```

Expected: no regressions in non-metrics code.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/staleness.ts \
        apps/api/src/services/metrics/__tests__/staleness.test.ts
git commit -m "feat(metrics): staleness keyed by (aggregator, domain)"
```

---

## Task 10: Rewrite dashboard handler + response schema

**Files:**
- Modify: `packages/schemas/src/aggregator/dashboard.ts` (response shape rewrite)
- Modify: `apps/api/src/routes/v1/aggregator/dashboard.ts` (handler rewrite)
- Modify: `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts`
- Create: `apps/api/src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts`

- [ ] **Step 1: Rewrite the response schema**

Replace `packages/schemas/src/aggregator/dashboard.ts`:

```ts
import z from 'zod';

const StatusEnum = z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']);

export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
});

export const ItemRollup = z.object({
  items_total: z.number(),
  by_status: z.record(z.string(), z.number()),
  applications_total: z.number(),
  applications_pending: z.number(),
  applications_shortlisted: z.number(),
  applications_rejected: z.number(),
  unique_users: z.number(),
  complete_profiles_count: z.number(),
  avg_profiles_per_user: z.number(),
  users_with_applications: z.number(),
  avg_applications_per_user: z.number(),
  new_users_last_7_days: z.number(),
  mode_wise_counts: z.record(z.string(), z.number()),
});

export const ParticipantRow = z.object({
  item_id: z.string(),
  owner_user_id: z.string(),
  item_type: z.string(),
  profile_status: z.string().nullable(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),
  applications_total: z.number(),
  applications_pending: z.number(),
  applications_shortlisted: z.number(),
  applications_rejected: z.number(),
  last_applied_at: z.string().nullable().optional(),
  last_shortlisted_at: z.string().nullable().optional(),
  last_rejected_at: z.string().nullable().optional(),
  openings: z.number().nullable().optional(),
  actionable_tags: z.array(z.string()),
});

export const DomainBlock = z.object({
  rollup: ItemRollup,
  participants: z.array(ParticipantRow),
  total_matching: z.number(),
  next_cursor: z.string().nullable(),
});

export const DashboardResponse = z.object({
  by_domain: z.record(z.string(), DomainBlock),
  metadata: z.object({
    last_computed_at: z.string().nullable(),
    ttl_seconds: z.number(),
    refreshed: z.boolean(),
  }),
});

export const ExportQuery = z.object({
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
});

export type DashboardRequestQuery = z.infer<typeof DashboardRequestQuery>;
export type ItemRollup = z.infer<typeof ItemRollup>;
export type ParticipantRow = z.infer<typeof ParticipantRow>;
export type DomainBlock = z.infer<typeof DomainBlock>;
export type DashboardResponse = z.infer<typeof DashboardResponse>;
export type ExportQuery = z.infer<typeof ExportQuery>;
```

- [ ] **Step 2: Rewrite the dashboard handler**

Replace `apps/api/src/routes/v1/aggregator/dashboard.ts`. The handler must:
- Verify `acting_org.org_type === 'aggregator'` → else 403.
- Read `organization.metadata.domains` → if empty → 400 `NO_DOMAINS_CONFIGURED`.
- If `?domain=` present, validate it's in the configured set → else 400 `DOMAIN_NOT_CONFIGURED`.
- For each domain in scope: call `check_and_refresh_if_stale(org_id, domain)` (parallel via `Promise.all`).
- Per domain, compute the rollup (status histogram + sums of application counts + per-user aggregates + mode_wise_counts + new_users_last_7_days + complete_profiles_count) and list (filtered + paginated).
- Return `by_domain` object, single key if `?domain=` was set, multi-key otherwise.

Full content:

```ts
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization } from '../../../../db/postgres/schema/auth.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import {
  DashboardRequestQuery,
  DashboardResponse,
  type DashboardRequestQuery as DQ,
} from '@dpg/schemas';
import {
  check_and_refresh_if_stale,
  TTL_SECONDS,
} from '@/services/metrics/staleness';

type DashboardRequest = FastifyRequest<{ Querystring: DQ }>;

export const aggregator_dashboard: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard',
    schema: {
      tags: ['aggregator'],
      querystring: DashboardRequestQuery,
      response: { 200: DashboardResponse },
    },
    handler: aggregator_dashboard_handler,
  });
};

const SEVEN_DAYS_MS = 7 * 86_400_000;

export const aggregator_dashboard_handler = async (
  request: DashboardRequest,
  reply: FastifyReply,
) => {
  const acting = request.acting_org;
  if (!acting || acting.org_type !== 'aggregator') {
    return reply.code(403).send({
      error: 'NOT_AGGREGATOR',
      message: 'caller must act on behalf of an aggregator org',
    });
  }

  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, acting.org_id))
    .limit(1);
  let configured_domains: string[] = [];
  if (org?.metadata) {
    try {
      const meta = JSON.parse(org.metadata) as { domains?: unknown };
      if (Array.isArray(meta.domains)) {
        configured_domains = (meta.domains as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        );
      }
    } catch {
      /* fallthrough → 400 below */
    }
  }
  if (configured_domains.length === 0) {
    return reply.code(400).send({
      error: 'NO_DOMAINS_CONFIGURED',
      message: 'org.metadata.domains is empty — re-upsert with domains array',
    });
  }

  const { page, limit, domain: requested_domain, status } = request.query;
  let scope: string[] = configured_domains;
  if (requested_domain) {
    if (!configured_domains.includes(requested_domain)) {
      return reply.code(400).send({
        error: 'DOMAIN_NOT_CONFIGURED',
        message: `?domain=${requested_domain} is not in org.metadata.domains`,
      });
    }
    scope = [requested_domain];
  }

  // Parallel staleness check per domain
  const staleness = await Promise.all(
    scope.map((d) => check_and_refresh_if_stale(acting.org_id, d)),
  );
  const earliest_last_computed = staleness
    .map((s) => s.last_computed_at)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const any_refreshed = staleness.some((s) => s.refreshed);

  const by_domain: Record<string, unknown> = {};

  for (const d of scope) {
    by_domain[d] = await build_domain_block(acting.org_id, d, page, limit, status);
  }

  return {
    by_domain,
    metadata: {
      last_computed_at: earliest_last_computed?.toISOString() ?? null,
      ttl_seconds: TTL_SECONDS,
      refreshed: any_refreshed,
    },
  };
};

async function build_domain_block(
  org_id: string,
  domain: string,
  page: number,
  limit: number,
  status: string | undefined,
) {
  const base_where = and(
    eq(item_metrics.onboardedByOrgId, org_id),
    eq(item_metrics.itemDomain, domain),
  );
  const filter_where = status
    ? and(base_where, eq(item_metrics.profileStatus, status))
    : base_where;

  // Status histogram + application sums
  const rollup_rows = (await db
    .select({
      profile_status: item_metrics.profileStatus,
      n: sql<number>`count(*)::int`,
      apps_total: sql<number>`COALESCE(sum(${item_metrics.applicationsTotal}), 0)::int`,
      pending: sql<number>`COALESCE(sum(${item_metrics.applicationsPending}), 0)::int`,
      shortlisted: sql<number>`COALESCE(sum(${item_metrics.applicationsShortlisted}), 0)::int`,
      rejected: sql<number>`COALESCE(sum(${item_metrics.applicationsRejected}), 0)::int`,
    })
    .from(item_metrics)
    .where(base_where!)
    .groupBy(item_metrics.profileStatus)) as Array<{
    profile_status: string | null;
    n: number;
    apps_total: number;
    pending: number;
    shortlisted: number;
    rejected: number;
  }>;

  // Per-user aggregates
  const [user_agg] = (await db.execute(sql`
    SELECT
      COUNT(DISTINCT ${item_metrics.ownerUserId})::int             AS unique_users,
      COUNT(*) FILTER (WHERE ${item_metrics.profileCompletionPct} >= 100)::int AS complete_profiles_count,
      COUNT(DISTINCT ${item_metrics.ownerUserId}) FILTER (
        WHERE ${item_metrics.applicationsTotal} > 0
      )::int                                                       AS users_with_applications,
      COUNT(*) FILTER (
        WHERE ${item_metrics.profileCreatedAt} >= NOW() - INTERVAL '7 days'
      )::int                                                       AS new_users_last_7_days,
      COALESCE(SUM(${item_metrics.applicationsTotal}), 0)::int     AS total_applications
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain};
  `)) as unknown as Array<{
    unique_users: number;
    complete_profiles_count: number;
    users_with_applications: number;
    new_users_last_7_days: number;
    total_applications: number;
  }>;

  const items_total = rollup_rows.reduce((s, r) => s + (r.n ?? 0), 0);
  const apps_total = rollup_rows.reduce((s, r) => s + (r.apps_total ?? 0), 0);

  const [mode_rows] = (await db.execute(sql`
    SELECT ${item_metrics.onboardedVia} AS via, COUNT(*)::int AS n
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain}
    GROUP BY ${item_metrics.onboardedVia};
  `)) as unknown as Array<Array<{ via: string | null; n: number }>>;

  const mode_wise_counts: Record<string, number> = {};
  for (const r of mode_rows ?? []) {
    if (r?.via) mode_wise_counts[r.via] = r.n;
  }

  const rollup = {
    items_total,
    by_status: Object.fromEntries(
      rollup_rows.map((r) => [r.profile_status ?? 'unknown', r.n]),
    ) as Record<string, number>,
    applications_total: apps_total,
    applications_pending: rollup_rows.reduce((s, r) => s + (r.pending ?? 0), 0),
    applications_shortlisted: rollup_rows.reduce((s, r) => s + (r.shortlisted ?? 0), 0),
    applications_rejected: rollup_rows.reduce((s, r) => s + (r.rejected ?? 0), 0),
    unique_users: user_agg?.unique_users ?? 0,
    complete_profiles_count: user_agg?.complete_profiles_count ?? 0,
    avg_profiles_per_user: user_agg?.unique_users
      ? items_total / user_agg.unique_users
      : 0,
    users_with_applications: user_agg?.users_with_applications ?? 0,
    avg_applications_per_user: user_agg?.users_with_applications
      ? (user_agg?.total_applications ?? 0) / user_agg.users_with_applications
      : 0,
    new_users_last_7_days: user_agg?.new_users_last_7_days ?? 0,
    mode_wise_counts,
  };

  const [total_row] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(item_metrics)
    .where(filter_where!)) as Array<{ n: number }>;
  const total_matching = total_row?.n ?? 0;

  const list_rows = (await db
    .select()
    .from(item_metrics)
    .where(filter_where!)
    .orderBy(desc(item_metrics.profileLastUpdatedAt), desc(item_metrics.itemId))
    .limit(limit)
    .offset((page - 1) * limit)) as Array<typeof item_metrics.$inferSelect>;

  const participants = list_rows.map((r) => ({
    item_id: r.itemId,
    owner_user_id: r.ownerUserId,
    item_type: r.itemType,
    profile_status: r.profileStatus,
    profile_completion_pct: r.profileCompletionPct,
    profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
    profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
    age_days: r.ageDays,
    applications_total: r.applicationsTotal ?? 0,
    applications_pending: r.applicationsPending ?? 0,
    applications_shortlisted: r.applicationsShortlisted ?? 0,
    applications_rejected: r.applicationsRejected ?? 0,
    last_applied_at: r.lastAppliedAt?.toISOString() ?? null,
    last_shortlisted_at: r.lastShortlistedAt?.toISOString() ?? null,
    last_rejected_at: r.lastRejectedAt?.toISOString() ?? null,
    openings: r.openings ?? null,
    actionable_tags: r.actionableTags ?? [],
  }));

  return {
    rollup,
    participants,
    total_matching,
    next_cursor: list_rows.length === limit ? String(page + 1) : null,
  };
}

export default aggregator_dashboard;
```

- [ ] **Step 3: Rewrite dashboard.test.ts**

Replace `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts` to use the new mocked `item_metrics` shape. Tests:
- 403 NOT_AGGREGATOR for non-aggregator acting_org
- 400 NO_DOMAINS_CONFIGURED for empty domains
- 400 DOMAIN_NOT_CONFIGURED for `?domain=` not in metadata
- 200 single-domain (only seeker in metadata) — by_domain has one key
- 200 multi-domain — by_domain has both keys
- 200 `?domain=seeker` filter limits scope
- 200 `?status=active` filters participants
- 200 metadata.refreshed=true on cold cache

The mock pattern is the same as Plan A's perform_action.test.ts mocks. Capture the mocked `check_and_refresh_if_stale` calls to assert per-domain invocation.

(Don't paste the full test code here — refactor the existing dashboard.test.ts skeleton. The pattern is the same: vi.mock the staleness module, mock db.select / db.execute returning a fixture, drive the handler via Fastify inject.)

- [ ] **Step 4: Add dashboard_multidomain.test.ts**

Stand-alone file focused on the multi-domain shape (just 3-4 cases verifying `by_domain` keys, parallel staleness calls, and earliest-last-computed-at calculation).

- [ ] **Step 5: Run tests**

```bash
pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/dashboard.test.ts src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/aggregator/dashboard.ts \
        apps/api/src/routes/v1/aggregator/dashboard.ts \
        apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts \
        apps/api/src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts
git commit -m "feat(api): dashboard by_domain response + multi-domain orgs"
```

---

## Task 11: Rewrite CSV export

**Files:**
- Modify: `apps/api/src/routes/v1/aggregator/export.ts`
- Modify: `apps/api/src/routes/v1/aggregator/__tests__/export.test.ts`

- [ ] **Step 1: Update the handler**

Replace `apps/api/src/routes/v1/aggregator/export.ts`. The new column list (from the spec):

```ts
const COLUMNS = [
  'item_id',
  'item_domain',
  'item_type',
  'owner_user_id',
  'onboarded_by_org_id',
  'onboarded_via',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'applications_total',
  'applications_pending',
  'applications_shortlisted',
  'applications_rejected',
  'last_applied_at',
  'last_shortlisted_at',
  'last_rejected_at',
  'openings',
  'actionable_tags',
] as const;
```

The route accepts `?domain=` + `?status=` filters. For multi-domain orgs without a `?domain=` filter, the CSV streams all configured domains' rows; with a `?domain=` filter, only that domain.

Auth / staleness invocation pattern: same per-domain `check_and_refresh_if_stale` calls in a `Promise.all`, then the generator paginates `item_metrics` with the same filter. Pages of 5000, ordering by `(item_domain, item_id)` so multi-domain orgs see all of one domain before the next.

Read the existing `export.ts` and adapt it: change column names, swap `participant_metrics` → `item_metrics`, add the `?domain=` filter handling, mirror the new metadata.domains lookup from the dashboard handler.

- [ ] **Step 2: Update export.test.ts**

Adjust column assertions to match the new list. Add a case where the same export contains both `item_domain=seeker` and `item_domain=provider` rows for a multi-domain org. Add a case where `?domain=seeker` filters out provider rows.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/export.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1/aggregator/export.ts \
        apps/api/src/routes/v1/aggregator/__tests__/export.test.ts
git commit -m "feat(api): CSV export — new columns + multi-domain support"
```

---

## Task 12: Integration test against real Postgres

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/__tests__/participant_b_integration.test.ts` (or replace the existing `dashboard.integration.test.ts` if it's no longer relevant — read it first and decide)

- [ ] **Step 1: Pre-read**

```bash
cat apps/api/src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts
```

The existing integration test was migrated in Plan C commit `6fb4978` to use `/admin/participant` for seeding. Plan B can extend it — adjust assertions for the new `by_domain` shape — instead of duplicating.

- [ ] **Step 2: Rewrite dashboard.integration.test.ts**

Six cases (from spec test plan):

1. Seed 5 seekers + 2 providers via `POST /api/v1/admin/participant` (mix of `channel` values, network_service acting_org so we control attribution).
2. Have 3 seekers apply to the 2 providers via `POST /api/v1/action/perform` (using aggregator-typed acting_org per Plan A's scope reset). Action statuses mix `submitted` / `shortlisted` / `rejected` via `POST /api/v1/action/update-status`.
3. Hit `GET /api/v1/aggregator/dashboard` — assert `by_domain.seeker.rollup.items_total === 5`, status histogram has expected values, `by_domain.provider.rollup.items_total === 2`, application counts add up.
4. Direct SQL `UPDATE item_metrics SET last_computed_at = NOW() - INTERVAL '2 hours' WHERE onboarded_by_org_id = …` → re-hit dashboard → assert `metadata.refreshed: true`.
5. `?domain=seeker` returns only the seeker block.
6. `GET /api/v1/aggregator/dashboard/export` — assert `text/csv`, header line matches new columns, body has both seeker and provider rows mixed.

Same env-gate + listen-port + cleanup pattern as Plan C's `participant.integration.test.ts` (commit `8a9fd98`). Seed 1 aggregator org with `domains: ['seeker', 'provider']` in metadata.

- [ ] **Step 3: Run integration test**

```bash
docker compose up -d db redis
POSTGRES_URL='postgres://postgres:postgres@localhost:5432/postgresdb' pnpm --filter api test:integration src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts
```

Expected: 6 PASS.

- [ ] **Step 4: Confirm unit suite still clean**

```bash
pnpm --filter api test
```

Expected: integration excluded from unit; unit suite passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts
git commit -m "test(api): integration test for Plan B dashboard + export"
```

---

## Task 13: Docs + Postman

**Files:**
- Modify: `docs/operations/integrating-dpgs.md` (dashboard section)
- Modify: `docs/postman/Signals-DPG.postman_collection.json` (`03 Aggregator Onboarding` `Upsert Aggregator` body adds `domains`; `06 Aggregator Metrics` request descriptions reflect new response shape)
- Modify: `docs/postman/Blue-Dots.postman_environment.json` + `Purple-Dots.postman_environment.json` (`aggregator_domains_json` env var)

- [ ] **Step 1: Update integrating-dpgs.md**

Find the existing "Aggregator dashboard" section. Replace its response example with:

```jsonc
{
  "by_domain": {
    "seeker": {
      "rollup": { "items_total": 1247, "by_status": { "new": 84, "active": 612, "at_risk": 219, "inactive": 270 }, "...": "..." },
      "participants": [ /* per-item rows */ ],
      "total_matching": 219,
      "next_cursor": "2"
    },
    "provider": {
      "rollup": { "items_total": 84, "by_status": { "new": 5, "active": 30, "...": "..." }, "...": "..." },
      "participants": [ /* per-item rows incl. openings */ ],
      "total_matching": 12,
      "next_cursor": "2"
    }
  },
  "metadata": { "last_computed_at": "...", "ttl_seconds": 3600, "refreshed": false }
}
```

Add a subsection explaining:
- `org.metadata.domains: string[]` is required — set via `/admin/aggregator/upsert` with the `domains: ['seeker', 'provider']` field.
- Each `(org, domain)` recomputes independently; multi-domain orgs see parallel refreshes.
- `?domain=` filter narrows the response to one domain.
- The `metric_categories` contract in `network.json` controls which `action_status` values count as `shortlisted` / `rejected` / `pending`.

- [ ] **Step 2: Postman updates**

In `03 Aggregator Onboarding` → `Upsert Aggregator` request body, add `"domains": {{aggregator_domains_json}}` so callers exercise the new field. (Use a JSON-typed Postman env var.)

In `06 Aggregator Metrics` folder, update the `Dashboard` and `Dashboard Export` request descriptions to mention the new `?domain=` filter + new response shape. Add an example `Dashboard - Filter by Domain` request (GET `/api/v1/aggregator/dashboard?domain=seeker`).

- [ ] **Step 3: Env file updates**

Both `Blue-Dots.postman_environment.json` and `Purple-Dots.postman_environment.json` gain `aggregator_domains_json` with a default value of `["seeker","provider"]` (or `["seeker"]` for single-domain pilot setups).

- [ ] **Step 4: Validate JSONs**

```bash
for f in docs/postman/Signals-DPG.postman_collection.json docs/postman/Blue-Dots.postman_environment.json docs/postman/Purple-Dots.postman_environment.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f ok";
done
diff <(jq -S '.values | map({key, type, enabled})' docs/postman/Blue-Dots.postman_environment.json) \
     <(jq -S '.values | map({key, type, enabled})' docs/postman/Purple-Dots.postman_environment.json)
```

Expected: all parse; no diff in symmetry.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/integrating-dpgs.md \
        docs/postman/Signals-DPG.postman_collection.json \
        docs/postman/Blue-Dots.postman_environment.json \
        docs/postman/Purple-Dots.postman_environment.json
git commit -m "docs: by_domain dashboard shape + aggregator domains config"
```

---

## Final checklist before opening PR

- [ ] All 13 tasks land on `chore/plan-b-metrics-redesign`.
- [ ] `pnpm typecheck` clean across api / ui / docs.
- [ ] `pnpm --filter api test` — Plan C baseline 136 → ~150+ after Plan B's pure-helper tests + recompute test changes. Document the exact delta in the PR body.
- [ ] `pnpm schema:bundle:check` clean (helm bundle matches checked-in copy).
- [ ] Manual `pnpm --filter api test:integration` clean against fresh `docker compose up -d db redis`.
- [ ] Postman JSONs parse; env files symmetric.
- [ ] PR target is `feat/api-refactor` (NOT develop). Plans A + C already landed there; Plan B stacks on top.

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| Schema: drop participant_metrics, create item_metrics | Task 1 |
| `org.metadata.domains: string[]` upsert | Task 2 (schema) + Task 4 (handler) |
| `network.json` `metric_categories` | Task 2 (Zod) + Task 3 (data files) |
| Profile completion (item-level) | Task 8 (reused as-is from Plan 3) |
| Application counts (per-domain semantics + metric_categories) | Task 8 (recompute SQL) |
| Status: seeker / provider rules | Task 5 |
| Actionable tags (per-domain) | Task 7 |
| Upsert + batch flush | Task 8 |
| Dashboard endpoint (by_domain, multi-domain) | Task 10 |
| Pagination per-domain | Task 10 (next_cursor per domain block) |
| CSV export new columns | Task 11 |
| TTL / staleness / advisory lock (per-domain) | Task 9 |
| Integration test | Task 12 |
| Docs + Postman | Task 13 |

**Placeholder scan:** No TBD / TODO. Every step has concrete code or commands. Two "soft" notes (Task 3 step 3 about purple_dot mapping uncertainty, and Task 10 step 3 / Task 11 step 2 saying "adapt the existing test skeleton") leave room for the implementer's judgment but specify the assertions to make. The implementer should follow the same isolation pattern as Plan A/C's route tests — that pattern is well-established by now (PR #13 + #14).

**Type consistency:**
- `compute_seeker_status` + `compute_provider_status` consistently return `SeekerStatus | ProviderStatus` typed unions. `item_metrics.profileStatus` is `text` (untyped), so the union is enforced at the helper boundary.
- `MetricCategoriesTriple` (helper return) matches the Zod `MetricCategoriesSchema` shape (3 string arrays). The triple is consumed in recompute by interpolating each array into PG's `ANY($::text[])` filter.
- `ActionableTagsInput.domain: 'seeker' | 'provider'` matches `compute_seeker_status` / `compute_provider_status` selection in recompute.
- `check_and_refresh_if_stale(aggregator_id, domain)` signature consistent across Task 9 (definition) and Task 10/11 (callers).

**Granularity:** Tasks 1-7 are small (~5-7 steps each). Task 8 (recompute) is the largest at 8 steps — unavoidable; the rewrite is the core of Plan B. Tasks 10-12 are medium. Task 13 (docs + postman) is mechanical. Estimated 3-5 days end-to-end via subagent execution.
