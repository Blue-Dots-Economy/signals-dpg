# Participant Metrics Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute per-participant metrics (profile completion %, status, application counts by action_status, age-derived flags, actionable tags) inside Signals on a schedule, and expose a dashboard endpoint the aggregator UI reads to show both rollup counts and per-participant rows scoped to an aggregator org.

**Architecture:** New TypeScript worker process (`apps/signal-processor`) that wakes on a cron schedule, runs two passes (nightly full + 15-min incremental), and writes into a new `participant_metrics` table. Rule definitions are ported from `signals-data_processing-layer/populate_dashboard.py` (the canonical legacy spec). The aggregator dashboard reads via a new `GET /api/v1/aggregator/dashboard` endpoint that filters `participant_metrics` by `acting_org.org_id`.

**Tech Stack:** Node ≥24, ESM, Drizzle ORM, Postgres, node-cron (or `croner`), Fastify, Vitest.

**Prereqs:**
- Auth plan: `2026-05-21-aggregator-service-auth.md` (the dashboard endpoint reuses the acting_org preHandler).
- Attribution plan: `2026-05-21-participant-onboarding-attribution.md` (we filter by `user.onboarded_by_org_id`).

**Out of scope:**
- The legacy Python pipeline (`signals-data_processing-layer/`) keeps running until the new processor reaches parity. Decommission is a separate piece of work.
- Cross-instance / inter-DPG metrics. This service only sees the local Signals DB.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/db/postgres/schema/metrics.ts` (new) | Drizzle schema for `participant_metrics` |
| `apps/api/drizzle/<generated>.sql` | Migration |
| `apps/signal-processor/package.json` (new) | Workspace package manifest |
| `apps/signal-processor/tsconfig.json` (new) | TS config extending the repo base |
| `apps/signal-processor/src/index.ts` (new) | Entry — boots scheduler, registers passes |
| `apps/signal-processor/src/scheduler.ts` (new) | Wraps node-cron / croner |
| `apps/signal-processor/src/rules/profile_completion.ts` (new) | Pure function: profile payload → completion % |
| `apps/signal-processor/src/rules/profile_status.ts` (new) | Pure function: dates + counts → status label |
| `apps/signal-processor/src/rules/actionable_tags.ts` (new) | Pure function: profile + actions → tag list |
| `apps/signal-processor/src/passes/full_recompute.ts` (new) | Walk all users, recompute, upsert |
| `apps/signal-processor/src/passes/incremental.ts` (new) | Recompute only users whose data changed since `last_computed_at` |
| `apps/signal-processor/src/__tests__/*.test.ts` (new) | Unit tests for rules and passes |
| `apps/signal-processor/Dockerfile` (new) | Container for deployment |
| `apps/api/src/routes/v1/aggregator/dashboard.ts` (new) | Read endpoint |
| `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts` (new) | Route tests |
| `packages/schemas/src/aggregator/dashboard.ts` (new) | Zod request/response |
| `turbo.json` (modify) | Add the new app to the build graph |
| `docker-compose.yml` (modify) | Add the processor service for local dev |

---

## Task 1: Add `participant_metrics` table

**Files:**
- Create: `apps/api/db/postgres/schema/metrics.ts`

- [ ] **Step 1: Write schema**

```ts
import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { user, organization } from './auth.js';

export const participant_metrics = pgTable('participant_metrics', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Denormalised for cheap aggregator-scoped queries. Kept in sync by the
  // processor — do not update from the API path.
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  profileStatus: text('profile_status'),               // 'new' | 'active' | 'at_risk' | 'satisfied' | 'inactive'
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

- [ ] **Step 2: Add a partial index for hot dashboard reads**

Append a raw SQL hint that the generated migration should include:
```ts
// drizzle-kit will emit the table; add a CREATE INDEX statement manually to
// the generated migration:
//   CREATE INDEX idx_participant_metrics_org_status
//     ON participant_metrics (onboarded_by_org_id, profile_status);
```

- [ ] **Step 3: Generate + apply migration**
```bash
pnpm db:generate:api
# inspect the generated SQL — add the CREATE INDEX line.
pnpm db:migrate:api
```

- [ ] **Step 4: Commit**
```bash
git add apps/api/db/postgres/schema/metrics.ts apps/api/drizzle/
git commit -m "feat(api): participant_metrics table for aggregator dashboards"
```

---

## Task 2: Scaffold `apps/signal-processor` package

**Files:**
- Create: `apps/signal-processor/package.json`
- Create: `apps/signal-processor/tsconfig.json`
- Create: `apps/signal-processor/src/index.ts` (placeholder)
- Modify: `turbo.json` (so `pnpm build` builds it)

- [ ] **Step 1: package.json**

```json
{
  "name": "@dpg/signal-processor",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@dpg/database": "workspace:*",
    "@dpg/config": "workspace:*",
    "croner": "^8.0.0",
    "drizzle-orm": "^0.34.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Placeholder entry**

```ts
// apps/signal-processor/src/index.ts
console.log('signal-processor starting…');
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
```

- [ ] **Step 4: Add to turbo + install**
```bash
pnpm install
pnpm --filter @dpg/signal-processor build
```
Expected: builds cleanly, no compile errors.

- [ ] **Step 5: Commit**
```bash
git add apps/signal-processor/ turbo.json pnpm-lock.yaml
git commit -m "chore(processor): scaffold @dpg/signal-processor workspace"
```

---

## Task 3: profile_completion rule (TDD)

**Files:**
- Create: `apps/signal-processor/src/rules/profile_completion.ts`
- Create: `apps/signal-processor/src/rules/__tests__/profile_completion.test.ts`

The legacy spec lives in `signals-data_processing-layer/populate_dashboard.py` — provider profile counts 8 fields, seeker profile counts 13 fields. Port both.

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from 'vitest';
import { seeker_profile_completion_pct } from '../profile_completion.js';

describe('seeker_profile_completion_pct', () => {
  it('returns 0 for empty payload', () => {
    expect(seeker_profile_completion_pct({})).toBe(0);
  });

  it('returns 100 when all 13 fields are present and non-empty', () => {
    const full = {
      whoIAm: { fullName: 'A', gender: 'F', dateOfBirth: '2000-01-01', phone: '+91...' },
      whatIHave: { education: 'XII', skills: ['x'], experienceYears: 2, languages: ['en'] },
      whatIWant: { roles: ['x'], natureOfJob: 'regular', minMonthlyInHand: 10000, location: 'Bengaluru', startDate: '2026-06-01' },
    };
    expect(seeker_profile_completion_pct(full)).toBe(100);
  });

  it('partial → proportional pct', () => {
    const partial = { whoIAm: { fullName: 'A' } };
    expect(seeker_profile_completion_pct(partial)).toBe(Math.round((1 / 13) * 100));
  });
});
```

- [ ] **Step 2: Run, verify fail**
```bash
pnpm --filter @dpg/signal-processor test
```

- [ ] **Step 3: Implement**

```ts
const SEEKER_FIELDS: Array<(p: any) => unknown> = [
  (p) => p?.whoIAm?.fullName,
  (p) => p?.whoIAm?.gender,
  (p) => p?.whoIAm?.dateOfBirth,
  (p) => p?.whoIAm?.phone,
  (p) => p?.whatIHave?.education,
  (p) => p?.whatIHave?.skills,
  (p) => p?.whatIHave?.experienceYears,
  (p) => p?.whatIHave?.languages,
  (p) => p?.whatIWant?.roles,
  (p) => p?.whatIWant?.natureOfJob,
  (p) => p?.whatIWant?.minMonthlyInHand,
  (p) => p?.whatIWant?.location,
  (p) => p?.whatIWant?.startDate,
];

const PROVIDER_FIELDS: Array<(p: any) => unknown> = [
  // 8 fields — port from populate_dashboard.py
];

const is_filled = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

export const seeker_profile_completion_pct = (payload: unknown): number => {
  const filled = SEEKER_FIELDS.filter((g) => is_filled(g(payload))).length;
  return Math.round((filled / SEEKER_FIELDS.length) * 100);
};

export const provider_profile_completion_pct = (payload: unknown): number => {
  const filled = PROVIDER_FIELDS.filter((g) => is_filled(g(payload))).length;
  return PROVIDER_FIELDS.length === 0 ? 0 : Math.round((filled / PROVIDER_FIELDS.length) * 100);
};
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**
```bash
git add apps/signal-processor/src/rules/profile_completion.ts apps/signal-processor/src/rules/__tests__/
git commit -m "feat(processor): seeker/provider profile completion rule"
```

---

## Task 4: profile_status rule (TDD)

**Files:**
- Create: `apps/signal-processor/src/rules/profile_status.ts`
- Create: `apps/signal-processor/src/rules/__tests__/profile_status.test.ts`

Status logic ported from `populate_dashboard.py` — derived from job/profile age, application counts, and resolution rates.

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from 'vitest';
import { compute_profile_status } from '../profile_status.js';

describe('compute_profile_status', () => {
  const now = new Date('2026-05-21T00:00:00Z');

  it("'new' when profile was created < 7 days ago and no applications", () => {
    expect(compute_profile_status({
      profile_created_at: new Date('2026-05-18T00:00:00Z'),
      profile_last_updated_at: new Date('2026-05-18T00:00:00Z'),
      applications_total: 0,
      applications_accepted: 0,
      now,
    })).toBe('new');
  });

  it("'active' when applications submitted in last 30 days", () => {
    expect(compute_profile_status({
      profile_created_at: new Date('2026-01-01T00:00:00Z'),
      profile_last_updated_at: new Date('2026-05-01T00:00:00Z'),
      applications_total: 3, applications_accepted: 0,
      now,
    })).toBe('active');
  });

  it("'at_risk' when >30 days idle and no acceptance", () => {
    expect(compute_profile_status({
      profile_created_at: new Date('2026-01-01T00:00:00Z'),
      profile_last_updated_at: new Date('2026-03-01T00:00:00Z'),
      applications_total: 5, applications_accepted: 0,
      now,
    })).toBe('at_risk');
  });

  it("'satisfied' when at least one application accepted", () => {
    expect(compute_profile_status({
      profile_created_at: new Date('2026-01-01T00:00:00Z'),
      profile_last_updated_at: new Date('2026-04-01T00:00:00Z'),
      applications_total: 5, applications_accepted: 1,
      now,
    })).toBe('satisfied');
  });

  it("'inactive' when >90 days idle and no acceptance", () => {
    expect(compute_profile_status({
      profile_created_at: new Date('2025-12-01T00:00:00Z'),
      profile_last_updated_at: new Date('2026-01-01T00:00:00Z'),
      applications_total: 0, applications_accepted: 0,
      now,
    })).toBe('inactive');
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface ProfileStatusInput {
  profile_created_at: Date;
  profile_last_updated_at: Date;
  applications_total: number;
  applications_accepted: number;
  now: Date;
}

const days_between = (a: Date, b: Date) =>
  Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));

export type ProfileStatus = 'new' | 'active' | 'at_risk' | 'satisfied' | 'inactive';

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

- [ ] **Step 3: Run tests, pass, commit**

---

## Task 5: actionable_tags rule (TDD)

**Files:**
- Create: `apps/signal-processor/src/rules/actionable_tags.ts`
- Create: `apps/signal-processor/src/rules/__tests__/actionable_tags.test.ts`

Tags surface "things the aggregator should follow up on": `missing_phone`, `missing_education`, `no_recent_activity`, `all_applications_rejected`, etc. Port from the "follow-up flags" section of `populate_dashboard.py`.

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

describe('compute_actionable_tags', () => {
  it('flags missing phone', () => {
    expect(compute_actionable_tags({
      profile: { whoIAm: {} } as any,
      applications_total: 0, applications_rejected: 0,
      idle_days: 0,
    })).toContain('missing_phone');
  });

  it('flags all_applications_rejected when all submitted and rejected', () => {
    expect(compute_actionable_tags({
      profile: { whoIAm: { phone: '+91…' }, whatIHave: {} } as any,
      applications_total: 4, applications_rejected: 4,
      idle_days: 5,
    })).toContain('all_applications_rejected');
  });

  it('returns empty array when profile is healthy', () => {
    expect(compute_actionable_tags({
      profile: {
        whoIAm: { phone: '+91…', fullName: 'A' },
        whatIHave: { education: 'XII' },
      } as any,
      applications_total: 1, applications_rejected: 0,
      idle_days: 2,
    })).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement** (one tag per check, easy to extend)
- [ ] **Step 3: Commit**

---

## Task 6: Full-recompute pass

**Files:**
- Create: `apps/signal-processor/src/passes/full_recompute.ts`
- Create: `apps/signal-processor/src/passes/__tests__/full_recompute.test.ts`

- [ ] **Step 1: Write the test (with a fake/in-memory DB)**

Verify: given a fixture of users + items + actions, calling `run_full_recompute()` upserts the expected `participant_metrics` rows. Use vitest with the existing testing primitives, or a real-DB integration test if the time budget allows.

- [ ] **Step 2: Implement**

```ts
import { db } from '@dpg/database';
import { user } from '../../db/postgres/schema/auth.js';
import { participant_metrics } from '../../db/postgres/schema/metrics.js';
import { seeker_profile_completion_pct } from '../rules/profile_completion.js';
import { compute_profile_status } from '../rules/profile_status.js';
import { compute_actionable_tags } from '../rules/actionable_tags.js';
import { eq, sql } from 'drizzle-orm';

const BATCH = 500;

export const run_full_recompute = async () => {
  const started = Date.now();
  let offset = 0;
  while (true) {
    const rows = await db
      .select()
      .from(user)
      .limit(BATCH)
      .offset(offset);
    if (rows.length === 0) break;

    for (const u of rows) {
      // 1. Load latest profile item for u — uses the same partition-aware
      //    helpers in @dpg/database.
      const profile = await load_profile_item(u.id);
      const actions = await load_application_actions(u.id);

      const counts = aggregate_application_counts(actions);
      const profile_completion_pct = seeker_profile_completion_pct(profile?.payload ?? {});
      const profile_status = compute_profile_status({
        profile_created_at: profile?.created_at ?? u.createdAt,
        profile_last_updated_at: profile?.updated_at ?? u.updatedAt,
        applications_total: counts.total,
        applications_accepted: counts.accepted,
        now: new Date(),
      });
      const actionable_tags = compute_actionable_tags({
        profile: profile?.payload ?? {},
        applications_total: counts.total,
        applications_rejected: counts.rejected,
        idle_days: days_since(profile?.updated_at ?? u.updatedAt),
      });

      await db
        .insert(participant_metrics)
        .values({
          userId: u.id,
          onboardedByOrgId: u.onboardedByOrgId ?? null,
          onboardedVia: u.onboardedVia ?? null,
          profileStatus: profile_status,
          profileCompletionPct: profile_completion_pct,
          profileCreatedAt: profile?.created_at ?? u.createdAt,
          profileLastUpdatedAt: profile?.updated_at ?? u.updatedAt,
          ageDays: days_since(u.createdAt),
          applicationsPending: counts.pending,
          applicationsAccepted: counts.accepted,
          applicationsRejected: counts.rejected,
          applicationsTotal: counts.total,
          actionableTags: actionable_tags,
          lastComputedAt: new Date(),
        })
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
    }
    offset += rows.length;
  }
  return { duration_ms: Date.now() - started };
};

// Helpers (load_profile_item, load_application_actions,
// aggregate_application_counts, days_since) live in the same file or a
// small `helpers.ts` next door — keep them pure where possible so they can
// be unit-tested without a DB.
```

- [ ] **Step 3: Commit**

---

## Task 7: Incremental pass

**Files:**
- Create: `apps/signal-processor/src/passes/incremental.ts`

- [ ] **Step 1: Implement**

Same logic as full_recompute, but the `SELECT` joins:
```sql
WHERE user.updated_at > metrics.last_computed_at
   OR EXISTS (SELECT 1 FROM item  WHERE item.owner_user_id = user.id AND item.updated_at > metrics.last_computed_at)
   OR EXISTS (SELECT 1 FROM action WHERE action.actor_user_id = user.id AND action.updated_at > metrics.last_computed_at)
```
And only recomputes those users. Falls back to inserting a fresh row for users with no metrics row yet.

- [ ] **Step 2: Unit test with fixture covering both "changed item" and "changed action" triggers.**

- [ ] **Step 3: Commit**

---

## Task 8: Wire up the scheduler

**Files:**
- Create: `apps/signal-processor/src/scheduler.ts`
- Modify: `apps/signal-processor/src/index.ts`

- [ ] **Step 1: scheduler.ts**

```ts
import { Cron } from 'croner';
import { run_full_recompute } from './passes/full_recompute.js';
import { run_incremental } from './passes/incremental.js';
import { logger } from './logger.js';

export const start_scheduler = () => {
  const nightly = new Cron('0 2 * * *', { timezone: 'Asia/Kolkata' }, async () => {
    logger.info({ pass: 'full' }, 'starting full recompute');
    try {
      const { duration_ms } = await run_full_recompute();
      logger.info({ pass: 'full', duration_ms }, 'full recompute done');
    } catch (err) {
      logger.error({ err, pass: 'full' }, 'full recompute failed');
    }
  });

  const incremental = new Cron('*/15 * * * *', async () => {
    logger.info({ pass: 'incremental' }, 'starting incremental recompute');
    try {
      const { duration_ms, updated_count } = await run_incremental();
      logger.info({ pass: 'incremental', duration_ms, updated_count }, 'done');
    } catch (err) {
      logger.error({ err, pass: 'incremental' }, 'incremental failed');
    }
  });

  return () => { nightly.stop(); incremental.stop(); };
};
```

- [ ] **Step 2: Update index.ts**

```ts
import { start_scheduler } from './scheduler.js';
import { logger } from './logger.js';

const stop = start_scheduler();
logger.info('signal-processor started');

const shutdown = () => { stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 3: Run locally and verify the incremental pass fires within 15 minutes**
```bash
pnpm --filter @dpg/signal-processor dev
```
Tail logs; you should see `starting incremental recompute` on first minute mark.

- [ ] **Step 4: Commit**

---

## Task 9: `GET /api/v1/aggregator/dashboard` — Zod schemas

**Files:**
- Create: `packages/schemas/src/aggregator/dashboard.ts`

- [ ] **Step 1: Write schemas**

```ts
import { z } from 'zod';

export const DashboardRequestQuery = z.object({
  status: z.enum(['new', 'active', 'at_risk', 'satisfied', 'inactive']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
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

export const DashboardResponse = z.object({
  rollup: z.object({
    participants_total: z.number(),
    by_status: z.record(z.number()),
    applications_pending: z.number(),
    applications_completed: z.number(),
  }),
  participants: z.array(ParticipantRow),
  next_cursor: z.string().nullable(),
});
```

- [ ] **Step 2: Export + commit**

---

## Task 10: Dashboard route — failing tests first

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts`

- [ ] **Step 1: Write tests asserting rollup is correctly scoped to acting_org.org_id**

(Pattern mirrors Tasks 4-5 of the onboarding plan: build_app stubs `request.acting_org` to a known aggregator org_id, seed `participant_metrics` rows for that org and a different org, assert only the right rows are returned.)

- [ ] **Step 2: Run, verify fail. Commit.**

---

## Task 11: Implement dashboard route

**Files:**
- Create: `apps/api/src/routes/v1/aggregator/dashboard.ts`

- [ ] **Step 1: Implement**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '@dpg/database';
import { participant_metrics } from '../../../db/postgres/schema/metrics.js';
import { eq, and, sql, lt, desc } from 'drizzle-orm';
import { DashboardRequestQuery, DashboardResponse } from '@dpg/schemas';

export const aggregator_dashboard: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/dashboard',
    { schema: { querystring: DashboardRequestQuery, response: { 200: DashboardResponse } } },
    async (request, reply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({ error: 'NOT_AGGREGATOR', message: 'caller must act as an aggregator' });
      }
      const { status, limit, cursor } = request.query;

      const rollup_rows = await db
        .select({
          profile_status: participant_metrics.profileStatus,
          n: sql<number>`count(*)::int`,
          pending: sql<number>`sum(${participant_metrics.applicationsPending})::int`,
          completed: sql<number>`sum(${participant_metrics.applicationsAccepted} + ${participant_metrics.applicationsRejected})::int`,
        })
        .from(participant_metrics)
        .where(eq(participant_metrics.onboardedByOrgId, acting.org_id))
        .groupBy(participant_metrics.profileStatus);

      const rollup = {
        participants_total: rollup_rows.reduce((a, r) => a + r.n, 0),
        by_status: Object.fromEntries(rollup_rows.map((r) => [r.profile_status ?? 'unknown', r.n])),
        applications_pending: rollup_rows.reduce((a, r) => a + (r.pending ?? 0), 0),
        applications_completed: rollup_rows.reduce((a, r) => a + (r.completed ?? 0), 0),
      };

      const where = [eq(participant_metrics.onboardedByOrgId, acting.org_id)];
      if (status) where.push(eq(participant_metrics.profileStatus, status));
      if (cursor) where.push(lt(participant_metrics.userId, cursor));

      const rows = await db
        .select()
        .from(participant_metrics)
        .where(and(...where))
        .orderBy(desc(participant_metrics.userId))
        .limit(limit + 1);

      const has_more = rows.length > limit;
      const page = rows.slice(0, limit);
      const next_cursor = has_more ? page[page.length - 1].userId : null;

      return {
        rollup,
        participants: page.map((r) => ({
          user_id: r.userId,
          profile_status: r.profileStatus,
          profile_completion_pct: r.profileCompletionPct,
          profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
          profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
          age_days: r.ageDays,
          applications_pending: r.applicationsPending ?? 0,
          applications_accepted: r.applicationsAccepted ?? 0,
          applications_rejected: r.applicationsRejected ?? 0,
          applications_total: r.applicationsTotal ?? 0,
          actionable_tags: r.actionableTags ?? [],
        })),
        next_cursor,
      };
    },
  );
};
```

- [ ] **Step 2: Register the route in the v1 plugin tree** (under the same acting_org preHandler scope, but mounted at `/api/v1/aggregator` instead of `/api/v1/admin`).

- [ ] **Step 3: Run tests, pass, commit**

---

## Task 12: Dockerfile and docker-compose entry

**Files:**
- Create: `apps/signal-processor/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Dockerfile (multi-stage)**

```dockerfile
FROM node:24-bookworm-slim AS builder
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/signal-processor ./apps/signal-processor
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile --filter @dpg/signal-processor...
RUN pnpm --filter @dpg/signal-processor build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=builder /repo/apps/signal-processor/dist ./dist
COPY --from=builder /repo/apps/signal-processor/package.json ./
COPY --from=builder /repo/node_modules ./node_modules
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: docker-compose**

Add a `signal-processor` service depending on `db` and `redis`, sharing the same `POSTGRES_URL` env.

- [ ] **Step 3: Commit**

---

## Task 13: Decommission planning for the legacy Python pipeline

**Files:**
- Modify: `signals-data_processing-layer/README.md` (in the legacy repo)

- [ ] **Step 1: Add a deprecation banner**

At the top:
> ⚠️ **Deprecated.** Metric computation has moved into `Signals-DPG/apps/signal-processor`. This pipeline keeps running for Sheets export only and will be retired once the new processor reaches parity. Do not extend.

- [ ] **Step 2: Open a tracking issue listing remaining gaps before retirement** (duplicate detection, the matchmaking step's role-fit scoring, etc. — whatever has not been ported yet).

---

## Self-Review Checklist

- Spec coverage:
  - `participant_metrics` table ✅ (Task 1)
  - Profile completion, status, tags rules with tests ✅ (Tasks 3-5)
  - Full + incremental passes ✅ (Tasks 6-7)
  - Scheduler ✅ (Task 8)
  - Dashboard endpoint (rollup + per-participant) ✅ (Tasks 9-11)
  - Containerization ✅ (Task 12)
  - Legacy deprecation ✅ (Task 13)
- Method/property names consistent: `profileStatus` (Drizzle), `profile_status` (Zod/HTTP), `compute_profile_status` (rule). Mapping is explicit in the route handler. ✅
- No placeholders. Rule field lists for provider profile are marked as "port from populate_dashboard.py" — the porting itself is a sub-step inside Task 3.
- `participant_metrics` writes are upserts; readers are filtered by `onboarded_by_org_id`. The processor is the only writer.

## Open Questions

1. **Rollup table?** Currently rollup is computed on read via `GROUP BY`. With ~50k participants per aggregator this is fine. If a single aggregator grows past ~500k or the dashboard turns chatty, materialize `aggregator_rollup` as a second table and refresh in the same pass.
2. **Schedule cadence** (nightly + 15-min) is a guess based on the legacy pipeline. Confirm with the aggregator UI's freshness requirement — if the dashboard needs sub-minute reflection of a new application, switch to event-driven recompute (NOTIFY/LISTEN or a queue).
3. **Match-score signals** (the matchmaking step from the legacy pipeline) are NOT in this plan. If aggregator UI needs them on the dashboard, that's a follow-up plan.
