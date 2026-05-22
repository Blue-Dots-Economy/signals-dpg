# Participant Metrics Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Power the aggregator dashboard with per-aggregator participant metrics (rollup + paginated list + CSV export), computed on-demand and cached in a Postgres table with an explicit `last_computed_at` TTL.

**Architecture:** Lives inside `apps/api` — no separate worker, no Redis layer, no cron. A `participant_metrics` table IS the cache. Single endpoint `GET /api/v1/aggregator/dashboard` reads from the table; if the cache is older than the configured TTL (default 1 hour) the handler synchronously recomputes the aggregator's rows under a Postgres advisory lock (so concurrent dashboard hits don't thunder-herd the recompute). A sibling `GET /api/v1/aggregator/dashboard/export` streams CSV from the same table.

**Schema-driven rules:** profile-completion percentage and the `missing_<required_field>` tags read the item-type's JSON Schema from the existing `network_schema_cache` (loaded at API boot). Adding a new network drops a `network.json` and gains correct metrics without code change.

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres (advisory locks, JSONB ops, partitioned `items`), `fastify-type-provider-zod`, Vitest. UI side uses TanStack Query / SWR for in-browser memoization across filter changes — server-side filtering is the rule, not client-side.

**Prereqs:**
- Plan 1 (auth foundation + `acting_org` preHandler) — merged.
- Plan 2 (user attribution columns: `onboarded_by_org_id`, `onboarded_via`, `onboarded_source_id`, `onboarded_at`) — merged.
- Local Postgres + Redis running (`docker compose up -d db redis`). Redis isn't used by the metrics module itself but the API depends on it for sessions.

**Out of scope:**
- Async export + blob storage (S3 / GCS / MinIO). Documented as a follow-up. Threshold to consider: ~200k participants per aggregator OR sync export wall time > 2 min OR concurrent-export contention.
- Inter-instance / cross-network dashboard aggregation. Each Signals instance shows its own data.
- Incremental recompute. Full per-aggregator recompute every TTL; revisit only if the 1-hour cadence proves insufficient.
- A new long-running process. Everything runs inline in API request handlers.
- Background pre-warming. First request after TTL pays the recompute cost; rest of the hour is fast.

---

## Decisions baked in (settled during plan review)

| Decision | Value | Configurable via |
|---|---|---|
| TTL on cached metrics | 1 hour | `DASHBOARD_CACHE_TTL_SECONDS` (default 3600) |
| Recompute timeout cap | 2 minutes | `DASHBOARD_RECOMPUTE_TIMEOUT_SECONDS` (default 120) |
| Thundering-herd guard | `pg_try_advisory_lock(hash(aggregator_id))` | n/a (lock is in PG) |
| If the lock is held by another request | Serve stale; the in-flight recompute will land within seconds | n/a |
| Default list page size | 50 | `?limit=` query param (1–500) |
| Default rollup status set | `new`, `active`, `at_risk`, `satisfied`, `inactive` | Hardcoded; `profile_status.ts` is the single place to change |
| UI filtering pattern | Server-side, every filter change re-hits the API; browser caches via TanStack Query `staleTime` | Frontend concern, documented |
| Profile-completion weighting | Required fields weighted 1.0, optional weighted 0.5, capped at 100 | Constants in `profile_completion.ts` |
| CSV export shape | Synchronous streaming response; cursor over `participant_metrics` | Async-job + blob is a follow-up |
| Cache invalidation on participant create | Optional: `/admin/onboard_participant` deletes existing rows for the aggregator, forcing recompute on next read | Sub-task on Task 9 |

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/db/postgres/schema/metrics.ts` *(new)* | Drizzle schema for `participant_metrics` + indexes |
| `packages/database/src/utils/sql_scripts/metrics.sql` *(new)* | Idempotent SQL for the helm bundle (Plan 4 A.1's generator picks it up automatically) |
| `apps/api/src/services/metrics/profile_completion.ts` *(new)* | Schema-driven pure function: read JSON Schema, count populated keys against `required` + `properties` |
| `apps/api/src/services/metrics/profile_status.ts` *(new)* | Pure function: date arithmetic + application counts → `'new'\|'active'\|'at_risk'\|'satisfied'\|'inactive'` |
| `apps/api/src/services/metrics/actionable_tags.ts` *(new)* | Schema-derived `missing_<required_field>` tags + hand-coded business tags |
| `apps/api/src/services/metrics/recompute.ts` *(new)* | `recompute_aggregator_metrics(aggregator_id)` — orchestrates streaming SELECT, per-row rule eval, batched upsert |
| `apps/api/src/services/metrics/staleness.ts` *(new)* | `check_and_refresh_if_stale(aggregator_id)` — TTL check + advisory lock + recompute |
| `apps/api/src/services/metrics/schema_lookup.ts` *(new)* | Resolves the JSON Schema for the profile_1.0 item type that applies to a given aggregator |
| `apps/api/src/services/metrics/__tests__/` *(new)* | Unit tests for the rule modules + recompute + staleness |
| `packages/schemas/src/aggregator/dashboard.ts` *(new)* | Zod schemas (query, rollup, participant row, response, export filter) |
| `apps/api/src/routes/v1/aggregator/dashboard.ts` *(new)* | `GET /api/v1/aggregator/dashboard` |
| `apps/api/src/routes/v1/aggregator/export.ts` *(new)* | `GET /api/v1/aggregator/dashboard/export` |
| `apps/api/src/routes/v1/aggregator/aggregator_routes.ts` *(new)* | Mounts the dashboard + export routes under the `acting_org` preHandler |
| `apps/api/src/routes/v1/aggregator/__tests__/` *(new)* | Route unit tests + integration test |
| `apps/api/src/routes/v1/v1_routes.ts` *(modify)* | Register the aggregator scope alongside `admin` |
| `docs/operations/integrating-dpgs.md` *(modify)* | New "Aggregator dashboard" section |

---

## Task 1: `participant_metrics` table

**Files:**
- Create: `apps/api/db/postgres/schema/metrics.ts`
- Create: `packages/database/src/utils/sql_scripts/metrics.sql`
- Regenerate: `helmcharts/dpg/charts/api/files/schema.sql` (via `pnpm schema:bundle`)

The table holds one row per participant the API has computed metrics for. Keyed by `user_id`; lookups by `onboarded_by_org_id` (denormalised from the `user` table — Plan 2 owns the source-of-truth column).

### Step 1: Drizzle schema

`apps/api/db/postgres/schema/metrics.ts`:

```ts
import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { user, organization } from './auth.js';

/**
 * Cached per-participant metrics for the aggregator dashboard.
 *
 * Owner: apps/api/src/services/metrics/recompute.ts (the recompute path is
 * the only writer). The dashboard route is a pure reader. The user-facing
 * TTL semantics live in apps/api/src/services/metrics/staleness.ts —
 * last_computed_at is the only field that matters there.
 *
 * onboarded_by_org_id is denormalised from `user.onboardedByOrgId` (Plan 2)
 * so the dashboard can scope without a join. Recompute keeps it in sync.
 */
export const participant_metrics = pgTable('participant_metrics', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  profileStatus: text('profile_status'),
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  applicationsPending: integer('applications_pending').default(0),
  applicationsAccepted: integer('applications_accepted').default(0),
  applicationsRejected: integer('applications_rejected').default(0),
  applicationsTotal: integer('applications_total').default(0),

  actionableTags: text('actionable_tags').array(),

  lastComputedAt: timestamp('last_computed_at').notNull(),
});
```

### Step 2: Idempotent SQL

`packages/database/src/utils/sql_scripts/metrics.sql`:

```sql
-- packages/database/src/utils/sql_scripts/metrics.sql
--
-- Idempotent SQL bootstrap for the participant_metrics table. Mirrors the
-- Drizzle schema in apps/api/db/postgres/schema/metrics.ts; CI parity
-- check (Plan 4 A.3) fails if they drift.

CREATE TABLE IF NOT EXISTS participant_metrics (
  user_id                 text PRIMARY KEY,
  onboarded_by_org_id     text,
  onboarded_via           text,
  profile_status          text,
  profile_completion_pct  integer,
  profile_created_at      timestamp,
  profile_last_updated_at timestamp,
  age_days                integer,
  applications_pending    integer DEFAULT 0,
  applications_accepted   integer DEFAULT 0,
  applications_rejected   integer DEFAULT 0,
  applications_total      integer DEFAULT 0,
  actionable_tags         text[],
  last_computed_at        timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_metrics_user_id_user_id_fk'
  ) THEN
    ALTER TABLE participant_metrics
      ADD CONSTRAINT participant_metrics_user_id_user_id_fk
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_metrics_onboarded_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE participant_metrics
      ADD CONSTRAINT participant_metrics_onboarded_by_org_id_organization_id_fk
      FOREIGN KEY (onboarded_by_org_id) REFERENCES organization(id);
  END IF;
END
$$;

-- Hot path: list per aggregator + filter by status.
CREATE INDEX IF NOT EXISTS participant_metrics_org_status_idx
  ON participant_metrics (onboarded_by_org_id, profile_status);

-- Staleness check: MIN(last_computed_at) per aggregator.
CREATE INDEX IF NOT EXISTS participant_metrics_org_last_computed_idx
  ON participant_metrics (onboarded_by_org_id, last_computed_at);
```

### Steps

- [ ] **Step 1: Write the Drizzle schema file**
- [ ] **Step 2: Write the idempotent SQL file**
- [ ] **Step 3: Regenerate helm bundle:** `pnpm schema:bundle && pnpm schema:bundle:check`
- [ ] **Step 4: Verify:** `pnpm --filter api exec tsc --noEmit`; apply locally with `pnpm db:push:api`; confirm via `\d participant_metrics`
- [ ] **Step 5: Commit:**
  ```
  feat(db): add participant_metrics table for the aggregator dashboard cache

  Plan 3 Task 1. One row per participant. last_computed_at is the
  TTL field — readers check it, writers stamp it. Two indexes
  ((org, status), (org, last_computed)) cover the dashboard list
  filter and the staleness check.
  ```

---

## Task 2: `profile_completion.ts` — schema-driven pure function

**Files:**
- Create: `apps/api/src/services/metrics/profile_completion.ts`
- Create: `apps/api/src/services/metrics/__tests__/profile_completion.test.ts`

Reads the item-type's JSON Schema; counts populated keys against the schema's `required` (weight 1.0) and `properties` not in `required` (weight 0.5); returns 0–100 (capped).

### Step 1: Failing tests

```ts
import { describe, it, expect } from 'vitest';
import { profile_completion_pct } from '../profile_completion.js';

const seeker_schema = {
  type: 'object',
  required: ['Full Name', 'Phone Number'],
  properties: {
    'Full Name':     { type: 'string' },
    'Phone Number':  { type: 'string' },
    'Email Address': { type: 'string' },  // optional
    'Grade':         { type: 'string' },  // optional
  },
};

describe('profile_completion_pct', () => {
  it('returns 0 for empty payload', () => {
    expect(profile_completion_pct({}, seeker_schema)).toBe(0);
  });

  it('returns 100 when all required + all optional populated', () => {
    expect(profile_completion_pct({
      'Full Name': 'A', 'Phone Number': '9876543210',
      'Email Address': 'a@b.com', 'Grade': 'XI',
    }, seeker_schema)).toBe(100);
  });

  it('weights required as 1.0 and optional as 0.5', () => {
    // 2 required filled (2.0) / total weight 3.0 = 67
    expect(profile_completion_pct({
      'Full Name': 'A', 'Phone Number': '9876543210',
    }, seeker_schema)).toBe(67);
  });

  it('caps at 100', () => {
    const optional_only = { type: 'object', required: [], properties: { a: {}, b: {} } };
    expect(profile_completion_pct({ a: 'x', b: 'y' }, optional_only)).toBe(100);
  });

  it('treats empty string and empty array as not populated', () => {
    expect(profile_completion_pct(
      { 'Full Name': '', 'Phone Number': [] }, seeker_schema,
    )).toBe(0);
  });

  it("treats boolean false as populated", () => {
    const yn_schema = {
      type: 'object', required: ['Open To Remote'],
      properties: { 'Open To Remote': { type: 'boolean' } },
    };
    expect(profile_completion_pct({ 'Open To Remote': false }, yn_schema)).toBe(100);
  });
});
```

Run `pnpm --filter api test` — failures expected with "Cannot find module".

### Step 2: Implement

```ts
import type { JSONSchema7 } from 'json-schema';

const REQUIRED_WEIGHT = 1.0;
const OPTIONAL_WEIGHT = 0.5;

export const is_populated = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

export const profile_completion_pct = (
  payload: Record<string, unknown> | null | undefined,
  schema: JSONSchema7 | null | undefined,
): number => {
  if (!schema?.properties) return 0;
  const required = new Set(schema.required ?? []);
  const all_keys = Object.keys(schema.properties);

  let earned = 0;
  let total = 0;
  for (const key of all_keys) {
    const weight = required.has(key) ? REQUIRED_WEIGHT : OPTIONAL_WEIGHT;
    total += weight;
    if (is_populated(payload?.[key])) earned += weight;
  }
  if (total === 0) return 0;
  return Math.min(100, Math.round((earned / total) * 100));
};
```

### Steps

- [ ] **Step 1: Write tests** (fail)
- [ ] **Step 2: Implement**
- [ ] **Step 3: Tests pass**
- [ ] **Step 4: Commit**
  ```
  feat(metrics): schema-driven profile_completion_pct

  Plan 3 Task 2. Reads the item-type's JSON Schema, counts populated
  keys against required (weight 1.0) and optional (0.5) properties.
  Capped at 100. Boolean false counts as populated.
  ```

---

## Task 3: `profile_status.ts`

**Files:**
- Create: `apps/api/src/services/metrics/profile_status.ts`
- Create: `apps/api/src/services/metrics/__tests__/profile_status.test.ts`

Pure date+counts rule, not schema-driven.

```ts
export type ProfileStatus = 'new' | 'active' | 'at_risk' | 'satisfied' | 'inactive';

export interface ProfileStatusInput {
  profile_created_at: Date;
  profile_last_updated_at: Date;
  applications_total: number;
  applications_accepted: number;
  now: Date;
}

const days_between = (a: Date, b: Date) =>
  Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));

export const compute_profile_status = (i: ProfileStatusInput): ProfileStatus => {
  if (i.applications_accepted > 0) return 'satisfied';

  const idle_days = days_between(i.profile_last_updated_at, i.now);
  const age_days = days_between(i.profile_created_at, i.now);

  if (age_days < 7 && i.applications_total === 0) return 'new';
  if (idle_days > 90 && i.applications_accepted === 0) return 'inactive';
  if (idle_days > 30 && i.applications_accepted === 0) return 'at_risk';
  return 'active';
};
```

Tests cover all 5 paths + boundary days (exactly 7, 30, 90).

### Steps

- [ ] **Step 1: Failing tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Commit**

---

## Task 4: `actionable_tags.ts`

**Files:**
- Create: `apps/api/src/services/metrics/actionable_tags.ts`
- Create: `apps/api/src/services/metrics/__tests__/actionable_tags.test.ts`

Two tag sources:
1. **Schema-derived:** for each `required` key not populated → `missing_<slugified_key>`.
2. **Business:** `all_applications_rejected` when all submitted were rejected; `no_recent_activity` when idle > 30 days.

```ts
import { is_populated } from './profile_completion.js';
import type { JSONSchema7 } from 'json-schema';

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface ActionableTagsInput {
  payload: Record<string, unknown>;
  schema: JSONSchema7;
  applications_total: number;
  applications_rejected: number;
  idle_days: number;
}

export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];

  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }

  if (i.applications_total > 0 && i.applications_rejected === i.applications_total) {
    tags.push('all_applications_rejected');
  }
  if (i.idle_days > 30) tags.push('no_recent_activity');

  return tags;
};
```

Tests:
- Schema-derived `missing_phone_number` for `'Phone Number'` not populated
- `all_applications_rejected` only when total > 0 and all rejected
- `no_recent_activity` at idle_days 31, not 30
- Empty case (everything populated, no applications) → `[]`

### Steps

- [ ] **Step 1: Failing tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Commit**

---

## Task 5: `schema_lookup.ts` + `recompute.ts`

**Files:**
- Create: `apps/api/src/services/metrics/schema_lookup.ts`
- Create: `apps/api/src/services/metrics/recompute.ts`
- Create: `apps/api/src/services/metrics/__tests__/recompute.test.ts`

### Step 1: `schema_lookup.ts`

Resolves the JSON Schema for the `profile_1.0` item type that applies to a given aggregator. Pilot heuristic:

1. Read the API's `served_domains` config (already loaded at boot).
2. Pick the first binding's network + domain.
3. Look up `profile_1.0` from `network_schema_cache` for that (network, domain).
4. If `organization.metadata` has `{ network, domain }` set, prefer that. Document as a future override path.

```ts
import type { JSONSchema7 } from 'json-schema';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '../../db/postgres/schema/auth.js';
import { eq } from 'drizzle-orm';
import { getSchemaForBinding } from '@/network_schema_cache';  // existing helper
import { apiConfig } from '@/config';

interface ResolvedSchema {
  schema: JSONSchema7;
  network: string;
  domain: string;
  item_type: string;
}

export const get_schema_for_aggregator = async (
  aggregator_id: string,
): Promise<ResolvedSchema> => {
  // 1. Per-aggregator override via organization.metadata
  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, aggregator_id))
    .limit(1);

  let network: string | undefined;
  let domain: string | undefined;
  if (org?.metadata) {
    try {
      const meta = JSON.parse(org.metadata);
      network = meta.network ?? undefined;
      domain = meta.domain ?? undefined;
    } catch { /* tolerate bad JSON */ }
  }

  // 2. Fall back to first served binding
  if (!network || !domain) {
    const first = apiConfig.served_domains[0];
    if (!first) {
      throw new Error('no served_domains configured; cannot resolve schema for metrics');
    }
    network ??= first.network;
    domain ??= first.domain;
  }

  // 3. Fetch the schema from the cache
  const item_type = 'profile_1.0';
  const schema = await getSchemaForBinding(network, domain, item_type);
  if (!schema) {
    throw new Error(`no schema found for ${network}/${domain}/${item_type}`);
  }
  return { schema: schema as JSONSchema7, network, domain, item_type };
};
```

### Step 2: `recompute.ts`

```ts
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../db/postgres/schema/metrics.js';
import { sql } from 'drizzle-orm';
import { profile_completion_pct } from './profile_completion.js';
import { compute_profile_status } from './profile_status.js';
import { compute_actionable_tags } from './actionable_tags.js';
import { get_schema_for_aggregator } from './schema_lookup.js';

const BATCH_SIZE = 1000;

export interface RecomputeResult { processed: number; duration_ms: number; }

export const recompute_aggregator_metrics = async (
  aggregator_id: string,
): Promise<RecomputeResult> => {
  const started = Date.now();
  const { schema } = await get_schema_for_aggregator(aggregator_id);
  const now = new Date();

  // Single SQL pass: pull user + latest profile + per-status application counts.
  const rows: any[] = await db.execute(sql`
    SELECT
      u.id AS user_id,
      u.created_at,
      u.updated_at,
      u.onboarded_by_org_id,
      u.onboarded_via,
      profile.item_state AS profile_state,
      profile.created_at AS profile_created_at,
      profile.updated_at AS profile_last_updated_at,
      COALESCE(ac.total,    0)::int AS applications_total,
      COALESCE(ac.pending,  0)::int AS applications_pending,
      COALESCE(ac.accepted, 0)::int AS applications_accepted,
      COALESCE(ac.rejected, 0)::int AS applications_rejected
    FROM "user" u
    LEFT JOIN items profile
      ON profile.created_by = u.id AND profile.item_type = 'profile_1.0'
    LEFT JOIN (
      SELECT
        actor_user_id,
        COUNT(*)                                                    AS total,
        COUNT(*) FILTER (WHERE action_state->>'status' = 'pending')  AS pending,
        COUNT(*) FILTER (WHERE action_state->>'status' = 'accepted') AS accepted,
        COUNT(*) FILTER (WHERE action_state->>'status' = 'rejected') AS rejected
      FROM item_actions
      GROUP BY actor_user_id
    ) ac ON ac.actor_user_id = u.id
    WHERE u.onboarded_by_org_id = ${aggregator_id};
  `);

  let processed = 0;
  let buffer: Array<typeof participant_metrics.$inferInsert> = [];

  for (const r of rows) {
    const payload = (r.profile_state as Record<string, unknown>) ?? {};
    const profile_created = r.profile_created_at ?? r.created_at;
    const profile_updated = r.profile_last_updated_at ?? r.updated_at;
    const idle_days = Math.floor((now.getTime() - profile_updated.getTime()) / 86400000);

    buffer.push({
      userId: r.user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      profileStatus: compute_profile_status({
        profile_created_at: profile_created,
        profile_last_updated_at: profile_updated,
        applications_total: r.applications_total,
        applications_accepted: r.applications_accepted,
        now,
      }),
      profileCompletionPct: profile_completion_pct(payload, schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: Math.floor((now.getTime() - r.created_at.getTime()) / 86400000),
      applicationsPending: r.applications_pending,
      applicationsAccepted: r.applications_accepted,
      applicationsRejected: r.applications_rejected,
      applicationsTotal: r.applications_total,
      actionableTags: compute_actionable_tags({
        payload, schema,
        applications_total: r.applications_total,
        applications_rejected: r.applications_rejected,
        idle_days,
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

const flush = async (rows: Array<typeof participant_metrics.$inferInsert>) => {
  await db
    .insert(participant_metrics)
    .values(rows)
    .onConflictDoUpdate({
      target: participant_metrics.userId,
      set: {
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        applicationsPending: sql`excluded.applications_pending`,
        applicationsAccepted: sql`excluded.applications_accepted`,
        applicationsRejected: sql`excluded.applications_rejected`,
        applicationsTotal: sql`excluded.applications_total`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
```

### Step 3: Test against a fake DB

Mock `@api/db/postgres/drizzle_config` to return a small fixture (3 users, mix of states). Verify the upsert is called once with the expected row shape.

### Steps

- [ ] **Step 1: Write `schema_lookup.ts`** + small unit test
- [ ] **Step 2: Write `recompute.ts`**
- [ ] **Step 3: Unit-test recompute against the fake DB**
- [ ] **Step 4: Commit**

---

## Task 6: `staleness.ts` — TTL check + advisory lock

**Files:**
- Create: `apps/api/src/services/metrics/staleness.ts`
- Create: `apps/api/src/services/metrics/__tests__/staleness.test.ts`

```ts
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../db/postgres/schema/metrics.js';
import { sql, eq, min } from 'drizzle-orm';
import { recompute_aggregator_metrics } from './recompute.js';
import { createHash } from 'node:crypto';

const lock_key_for = (aggregator_id: string): bigint => {
  const hash = createHash('sha256').update(aggregator_id).digest();
  return hash.readBigInt64BE(0) & 0x7fffffffffffffffn;
};

export const TTL_SECONDS = Number(process.env.DASHBOARD_CACHE_TTL_SECONDS ?? '3600');

export const check_and_refresh_if_stale = async (
  aggregator_id: string,
): Promise<{ refreshed: boolean; last_computed_at: Date | null }> => {
  const [row] = await db
    .select({ ts: min(participant_metrics.lastComputedAt) })
    .from(participant_metrics)
    .where(eq(participant_metrics.onboardedByOrgId, aggregator_id));

  const min_ts = row?.ts ?? null;
  const stale =
    min_ts === null ||
    (Date.now() - min_ts.getTime()) / 1000 > TTL_SECONDS;

  if (!stale) return { refreshed: false, last_computed_at: min_ts };

  const lock_key = lock_key_for(aggregator_id);
  const lockResult: any = await db.execute(
    sql`SELECT pg_try_advisory_lock(${lock_key.toString()}::bigint) AS locked`,
  );
  const locked = lockResult[0]?.locked === true;

  if (!locked) return { refreshed: false, last_computed_at: min_ts };

  try {
    await recompute_aggregator_metrics(aggregator_id);
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${lock_key.toString()}::bigint)`);
  }

  const [after] = await db
    .select({ ts: min(participant_metrics.lastComputedAt) })
    .from(participant_metrics)
    .where(eq(participant_metrics.onboardedByOrgId, aggregator_id));

  return { refreshed: true, last_computed_at: after?.ts ?? null };
};
```

### Steps

- [ ] **Step 1: Tests** covering stale-vs-fresh, lock contention (mock returns `false`), first-time-aggregator (`min_ts === null`)
- [ ] **Step 2: Implement**
- [ ] **Step 3: Commit**

---

## Task 7: Zod schemas

**Files:**
- Create: `packages/schemas/src/aggregator/dashboard.ts`
- Modify: `packages/schemas/src/index.ts`

```ts
import z from 'zod';

export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']).optional(),
  q: z.string().min(1).max(200).optional(),
});

export const ParticipantRow = z.object({
  user_id: z.string(),
  profile_status: z.string().nullable(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),
  applications_pending: z.number(),
  applications_accepted: z.number(),
  applications_rejected: z.number(),
  applications_total: z.number(),
  actionable_tags: z.array(z.string()),
});

export const RollupSummary = z.object({
  participants_total: z.number(),
  by_status: z.record(z.string(), z.number()),
  applications_pending: z.number(),
  applications_accepted: z.number(),
  applications_rejected: z.number(),
});

export const DashboardResponse = z.object({
  rollup: RollupSummary,
  participants: z.array(ParticipantRow),
  next_cursor: z.string().nullable(),
  total_matching: z.number(),
  metadata: z.object({
    last_computed_at: z.string().nullable(),
    ttl_seconds: z.number(),
    refreshed: z.boolean(),
  }),
});

export const ExportQuery = z.object({
  status: z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']).optional(),
  q: z.string().min(1).max(200).optional(),
});

export type DashboardRequestQuery = z.infer<typeof DashboardRequestQuery>;
export type DashboardResponse = z.infer<typeof DashboardResponse>;
export type ExportQuery = z.infer<typeof ExportQuery>;
```

Re-export from `packages/schemas/src/index.ts`.

### Steps

- [ ] **Step 1: Write schemas, export, typecheck**
- [ ] **Step 2: Commit**

---

## Task 8: Dashboard route — failing tests

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts`

Mirror the pattern from Plan 1's aggregator-upsert tests. `vi.mock` `db`, `check_and_refresh_if_stale`.

Cases:
- 403 when `acting_org.org_type` ≠ `'aggregator'`
- 200 happy path: rollup + paginated list with correct shape
- 200 with `status` filter
- Page 2 returns the next batch
- Metadata `refreshed: true` after cache miss
- Metadata `refreshed: false` on lock contention (stale read served)
- First-time aggregator (no rows): triggers recompute, returns data

### Steps

- [ ] **Step 1: Write tests** (fail with module-not-found)
- [ ] **Step 2: Commit (tests-only)**

---

## Task 9: Dashboard route — implementation

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/dashboard.ts`
- Create: `apps/api/src/routes/v1/aggregator/aggregator_routes.ts`
- Modify: `apps/api/src/routes/v1/v1_routes.ts`

```ts
import type { FastifyPluginAsync } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../../db/postgres/schema/metrics.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { DashboardRequestQuery, DashboardResponse } from '@dpg/schemas';
import { check_and_refresh_if_stale, TTL_SECONDS } from '@/services/metrics/staleness';

export const aggregator_dashboard: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard',
    schema: { querystring: DashboardRequestQuery, response: { 200: DashboardResponse } },
    handler: async (request, reply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({
          error: 'NOT_AGGREGATOR',
          message: 'caller must act on behalf of an aggregator org',
        });
      }

      const { page, limit, status } = request.query as { page: number; limit: number; status?: string };

      const staleness = await check_and_refresh_if_stale(acting.org_id);

      const rollup_rows = await db
        .select({
          status: participant_metrics.profileStatus,
          n: sql<number>`count(*)::int`,
          pending: sql<number>`COALESCE(sum(${participant_metrics.applicationsPending}), 0)::int`,
          accepted: sql<number>`COALESCE(sum(${participant_metrics.applicationsAccepted}), 0)::int`,
          rejected: sql<number>`COALESCE(sum(${participant_metrics.applicationsRejected}), 0)::int`,
        })
        .from(participant_metrics)
        .where(eq(participant_metrics.onboardedByOrgId, acting.org_id))
        .groupBy(participant_metrics.profileStatus);

      const rollup = {
        participants_total: rollup_rows.reduce((s, r) => s + r.n, 0),
        by_status: Object.fromEntries(rollup_rows.map((r) => [r.status ?? 'unknown', r.n])),
        applications_pending:  rollup_rows.reduce((s, r) => s + (r.pending ?? 0),  0),
        applications_accepted: rollup_rows.reduce((s, r) => s + (r.accepted ?? 0), 0),
        applications_rejected: rollup_rows.reduce((s, r) => s + (r.rejected ?? 0), 0),
      };

      const conditions = [eq(participant_metrics.onboardedByOrgId, acting.org_id)];
      if (status) conditions.push(eq(participant_metrics.profileStatus, status));

      const [{ n: total_matching }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(participant_metrics)
        .where(and(...conditions));

      const rows = await db
        .select()
        .from(participant_metrics)
        .where(and(...conditions))
        .orderBy(desc(participant_metrics.userId))
        .limit(limit)
        .offset((page - 1) * limit);

      return {
        rollup,
        participants: rows.map((r) => ({
          user_id: r.userId,
          profile_status: r.profileStatus,
          profile_completion_pct: r.profileCompletionPct,
          profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
          profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
          age_days: r.ageDays,
          applications_pending:  r.applicationsPending  ?? 0,
          applications_accepted: r.applicationsAccepted ?? 0,
          applications_rejected: r.applicationsRejected ?? 0,
          applications_total:    r.applicationsTotal    ?? 0,
          actionable_tags: r.actionableTags ?? [],
        })),
        next_cursor: rows.length === limit ? String(page + 1) : null,
        total_matching,
        metadata: {
          last_computed_at: staleness.last_computed_at?.toISOString() ?? null,
          ttl_seconds: TTL_SECONDS,
          refreshed: staleness.refreshed,
        },
      };
    },
  });
};
```

### Optional Step 6: Cache invalidation on onboard

In `apps/api/src/routes/v1/admin/onboard_participant.ts`, after the successful onboard transaction (and before returning to the client), fire-and-forget:

```ts
db.delete(participant_metrics)
  .where(eq(participant_metrics.onboardedByOrgId, acting.org_id))
  .catch((err) => request.log.warn({ err }, 'failed to invalidate metrics cache'));
```

Reasoning: deleting rows is the simplest invalidation — next dashboard read sees 0 rows for the aggregator, hits the staleness path (`min_ts === null` → recompute), and reflects the new participant. Costs ~5ms; reasonable tradeoff for "dashboard sees new participants in seconds, not 1 hour."

### Steps

- [ ] **Step 1: Implement** the dashboard route
- [ ] **Step 2: Register** `aggregator_routes` into `v1_routes.ts` at prefix `/aggregator`
- [ ] **Step 3: Run** Task 8's tests; all should pass
- [ ] **Step 4: (Optional)** Add the cache invalidation hook in onboard route
- [ ] **Step 5: Commit**

---

## Task 10: CSV export

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/export.ts`
- Create: `apps/api/src/routes/v1/aggregator/__tests__/export.test.ts`

```ts
import type { FastifyPluginAsync } from 'fastify';
import { Readable } from 'node:stream';
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../../db/postgres/schema/metrics.js';
import { eq, and, desc } from 'drizzle-orm';
import { ExportQuery } from '@dpg/schemas';
import { check_and_refresh_if_stale } from '@/services/metrics/staleness';

const COLUMNS = [
  'user_id',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'applications_pending',
  'applications_accepted',
  'applications_rejected',
  'applications_total',
  'actionable_tags',
] as const;

const csv_escape = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('|') : (v instanceof Date ? v.toISOString() : String(v));
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const PAGE = 5000;

async function* generate_csv(
  aggregator_id: string,
  status: string | undefined,
): AsyncGenerator<string> {
  yield COLUMNS.join(',') + '\n';

  const conditions = [eq(participant_metrics.onboardedByOrgId, aggregator_id)];
  if (status) conditions.push(eq(participant_metrics.profileStatus, status));

  let offset = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(participant_metrics)
      .where(and(...conditions))
      .orderBy(desc(participant_metrics.userId))
      .limit(PAGE)
      .offset(offset);
    if (rows.length === 0) break;
    for (const r of rows) {
      const projected = {
        user_id: r.userId,
        profile_status: r.profileStatus,
        profile_completion_pct: r.profileCompletionPct,
        profile_created_at: r.profileCreatedAt,
        profile_last_updated_at: r.profileLastUpdatedAt,
        age_days: r.ageDays,
        applications_pending: r.applicationsPending,
        applications_accepted: r.applicationsAccepted,
        applications_rejected: r.applicationsRejected,
        applications_total: r.applicationsTotal,
        actionable_tags: r.actionableTags,
      };
      yield COLUMNS.map((c) => csv_escape((projected as any)[c])).join(',') + '\n';
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
}

export const aggregator_export: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard/export',
    schema: { querystring: ExportQuery },
    handler: async (request, reply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({
          error: 'NOT_AGGREGATOR',
          message: 'caller must act on behalf of an aggregator org',
        });
      }

      await check_and_refresh_if_stale(acting.org_id);

      const { status } = request.query as { status?: string };
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="participants_${acting.org_id}_${new Date().toISOString().slice(0, 10)}.csv"`,
        );

      return reply.send(Readable.from(generate_csv(acting.org_id, status)));
    },
  });
};
```

Tests verify:
- 403 path
- CSV header line
- Escape behavior on `,`, `"`, `\n`, and the `actionable_tags` array
- Streams when row count > PAGE (use a fake `db` that returns 6000 rows split across two pages)

### Steps

- [ ] **Step 1: Write tests + implementation**
- [ ] **Step 2: Commit**

---

## Task 11: Integration test

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts`

Same gating pattern as Plan 2 Task 6. Env vars:
- `POSTGRES_URL` (or `POSTGRES_USER/PASSWORD/DB/HOST/PORT`)
- `TEST_AGGREGATOR_APIKEY`
- `TEST_AGGREGATOR_ORG_ID` (an aggregator-type org, not network_service)

Cases:
- Seed 10 participants via `/admin/onboard_participant`
- Hit `/dashboard` — confirm 200, `rollup.participants_total === 10`, list shape correct, `metadata.refreshed: true` on first hit
- Hit `/dashboard` again immediately — `metadata.refreshed: false`, `rollup` consistent
- Force staleness: `UPDATE participant_metrics SET last_computed_at = NOW() - INTERVAL '2 hours' WHERE onboarded_by_org_id = $1`. Hit again — `refreshed: true`.
- Filter: `/dashboard?status=new` — confirm scoped
- Pagination: 5 per page, two pages, correct `next_cursor`
- Export: `/dashboard/export` returns `text/csv` with 11 lines (1 header + 10 rows)

Invoke via `pnpm --filter api test:integration` (Plan 2's `vitest.integration.config.ts`).

### Steps

- [ ] **Step 1: Write the test**
- [ ] **Step 2: Document the manual invocation in the file header**
- [ ] **Step 3: Commit**

---

## Task 12: Docs

**Files:**
- Modify: `docs/operations/integrating-dpgs.md`

New section after "Onboarding a participant":

```markdown
## Aggregator dashboard

Per-aggregator metrics for the UI's hero + participant list views.

### Endpoint

\`\`\`bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard?page=1&limit=50&status=at_risk' \
  -H 'x-api-key: <aggregator-dpg apikey>' \
  -H 'x-acting-org-id: <BBMP org_id>'
\`\`\`

Response (abridged):

\`\`\`json
{
  "rollup": {
    "participants_total": 1247,
    "by_status": { "new": 84, "active": 612, "at_risk": 219, "satisfied": 270, "inactive": 62 },
    "applications_pending": 380, "applications_accepted": 421, "applications_rejected": 192
  },
  "participants": [ { "user_id": "...", "profile_completion_pct": 67, "actionable_tags": ["missing_phone_number"], ... } ],
  "next_cursor": "2",
  "total_matching": 219,
  "metadata": { "last_computed_at": "2026-05-22T07:00:00.000Z", "ttl_seconds": 3600, "refreshed": false }
}
\`\`\`

### Cache + TTL contract

- Rows are cached in `participant_metrics`. `last_computed_at` is the per-row TTL field.
- Every request checks `MIN(last_computed_at)` for the aggregator. If older than `DASHBOARD_CACHE_TTL_SECONDS` (default 1h), the handler recomputes synchronously under a Postgres advisory lock and returns fresh data with `metadata.refreshed: true`.
- Concurrent requests during a recompute don't pile up: the second-and-later requests serve stale data (`refreshed: false`); the in-flight recompute lands within at most ~`DASHBOARD_RECOMPUTE_TIMEOUT_SECONDS` (default 120).
- The `/admin/onboard_participant` route optionally invalidates the cache for the relevant aggregator on success, so newly-onboarded participants appear within seconds rather than waiting for TTL.

### CSV export

\`\`\`bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard/export?status=at_risk' \
  -H 'x-api-key: <key>' \
  -H 'x-acting-org-id: <org_id>' \
  -o participants.csv
\`\`\`

Same cache+staleness contract as the dashboard. Streamed `text/csv`; the response body is generated row-by-row via a server-side cursor so 200k+ participants don't OOM the API process.

### Frontend integration

Filtering and pagination always go through the API — the UI does **not** load all 200k rows and filter client-side. Use TanStack Query (or your preferred fetcher) and key the cache by `(aggregator_id, page, limit, status, q)`. Set `staleTime: 60_000` so users navigating back-and-forth across filters don't re-hit the server every time. Each new filter combination is one round-trip; the server returns the page in <100ms once metrics are warm.

### Plan 3 follow-ups (not in pilot)

- Async export + blob storage when sync export crosses 200k rows / 2 min / concurrent contention.
- Pre-warming on participant onboard (currently optional cache invalidation, not active warming).
- Full-text `q` filter via tsvector on profile fields.
- Per-aggregator schema override via `organization.metadata.network`/`domain` (today: first served binding wins).
- Inter-instance / multi-Signals aggregation.
```

### Steps

- [ ] **Step 1: Add the section**
- [ ] **Step 2: Commit**

---

## Self-Review Checklist

**Spec coverage:**
- [ ] `participant_metrics` table + indexes (Task 1)
- [ ] Schema-driven `profile_completion_pct` (Task 2)
- [ ] `compute_profile_status` (Task 3)
- [ ] Schema-derived + business `compute_actionable_tags` (Task 4)
- [ ] `schema_lookup` + `recompute_aggregator_metrics` (Task 5)
- [ ] TTL check + advisory-lock guard (Task 6)
- [ ] Zod schemas (Task 7)
- [ ] Failing dashboard tests (Task 8)
- [ ] Dashboard route impl + optional cache invalidation (Task 9)
- [ ] CSV export streaming (Task 10)
- [ ] Integration test (Task 11)
- [ ] Docs (Task 12)

**Type / method consistency:**
- `recompute_aggregator_metrics(aggregator_id)` is the only writer to `participant_metrics`. `check_and_refresh_if_stale` is the only caller. Dashboard + export route handlers call the latter, never the former.
- `last_computed_at` is the TTL field; `MIN(last_computed_at)` per aggregator is the staleness signal.
- Snake_case in DB, camelCase in Drizzle, snake_case in Zod/HTTP. Mapping at the route handler boundary; never let Drizzle's camelCase leak into the response.

## Open follow-ups (not in pilot)

1. **Async CSV export with blob storage** — sync export crosses 2 min / 200k rows / concurrent contention.
2. **Pre-warming** on participant onboard — fire-and-forget recompute, not just cache invalidation.
3. **`q` parameter (search)** — GIN index on tsvector across profile fields.
4. **Per-aggregator schema override** via `organization.metadata` (today: first served binding).
5. **Inter-instance aggregation** — query peer Signals instances.
6. **Recompute observability** — Plan 4 H (logging/metrics) hooks per recompute.
7. **Drop the recompute_timeout config** if measurements show it's never approached. Today it's just a documented knob.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-participant-metrics-service.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Claude dispatches a fresh subagent per task, reviews between tasks, fast iteration. Branch + PR per the agreed "branch per plan / PR only when complete" pattern.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Batch execution with checkpoints for review.

**Which approach?**
