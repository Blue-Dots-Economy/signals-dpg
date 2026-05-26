# Metrics Config-Driven Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every Jobs/Blue-Dot-specific name from Signals' metrics module. Replace today's `applications_*` columns with 4 canonical bucket columns (`create`/`accept`/`reject`/`cancel`); replace TS-side `seeker_status.ts` / `provider_status.ts` with a config-driven DSL evaluator reading per-domain `status_rules` from `network.json`; resolve item display names from schema-declared `display_name_field`; add `?refresh=true` force-recompute knob.

**Architecture:** Three new pure-function modules in `apps/api/src/services/metrics/` (`buckets.ts`, `evaluate_status_rules.ts`, `resolve_display_name.ts`) replace the per-domain status functions. `item_metrics` table gets a uniform shape (same columns for seeker + provider; no domain-specific NULLs). `network.json` gains per-item-schema `display_name_field` and per-domain `status_rules`; Zod validation rejects bad configs at boot. Recompute aggregates actions in both source/target directions, evaluates rules, stores result. Dashboard + export routes rename `participants` → `items`, drop 3 ID columns, add a `?refresh` query param backed by a blocking `pg_advisory_lock`.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Fastify + Zod, Drizzle ORM, PostgreSQL, pnpm + Turborepo monorepo. Reference network: `purple_dot` (PWD discovery + services).

**Spec:** `docs/superpowers/specs/2026-05-26-metrics-config-driven-redesign-design.md`

**Branch:** `chore/metrics-config-driven-redesign` off latest `origin/develop`.

---

## File map

**Create:**
- `apps/api/src/services/metrics/buckets.ts` — `CANONICAL_BUCKETS`, `CANONICAL_STATUSES` consts + Zod enums.
- `apps/api/src/services/metrics/evaluate_status_rules.ts` — DSL interpreter.
- `apps/api/src/services/metrics/__tests__/evaluate_status_rules.test.ts`
- `apps/api/src/services/metrics/resolve_display_name.ts` — display name resolver.
- `apps/api/src/services/metrics/__tests__/resolve_display_name.test.ts`

**Modify:**
- `packages/schemas/src/network_workflow.ts` — `MetricCategoriesSchema` canonical keys; new `StatusRuleSchema`; `display_name_field` on item_schemas; superRefine validations.
- `packages/schemas/src/aggregator/dashboard.ts` — `ItemRollup`, `ItemRow` (renamed from `ParticipantRow`), `DashboardResponse`, queries with `refresh`.
- `apps/api/db/postgres/schema/metrics.ts` — drop 8 cols, add 9 cols.
- `apps/api/drizzle/0000_light_anthem.sql` — regenerated via `pnpm db:generate:api` (manual delete + regen since baseline is squashed).
- `packages/database/src/utils/sql_scripts/metrics.sql` — mirror schema changes by hand (Plan 4 A.3 parity).
- `helmcharts/dpg/charts/api/files/schema.sql` — regenerated via `pnpm schema:bundle`.
- `apps/api/src/services/metrics/metric_categories.ts` — canonical bucket keys; helper return type.
- `apps/api/src/services/metrics/actionable_tags.ts` — drop all hardcoded business tags; keep schema-derived `missing_<field>` only.
- `apps/api/src/services/metrics/recompute.ts` — bidirectional aggregation; rule-driven status; display-name resolution; new column writes.
- `apps/api/src/services/metrics/staleness.ts` — add `force` arg + blocking lock path.
- `apps/api/src/routes/v1/aggregator/dashboard.ts` — new rollup query + response; `?refresh` plumbing; `items` key.
- `apps/api/src/routes/v1/aggregator/export.ts` — new column list; `?refresh`; filename `items_*`.
- `examples/schemas/purple_dot/network.json`
- `examples/schemas/blue_dot/network.json`
- `examples/schemas/yellow_dot/network.json`
- `examples/schemas/inter-network-action/blue_dot/network.json`
- `examples/schemas/inter-network-action/yellow_dot/network.json`
- `docs/operations/integrating-dpgs.md` — new response shape, `status_rules`, `display_name_field`.
- `docs/postman/` (relevant aggregator collection JSON) — request/response samples.

**Delete:**
- `apps/api/src/services/metrics/seeker_status.ts`
- `apps/api/src/services/metrics/provider_status.ts`
- `apps/api/src/services/metrics/__tests__/seeker_status.test.ts`
- `apps/api/src/services/metrics/__tests__/provider_status.test.ts`

---

## Task 1: Canonical bucket + status constants

**Files:**
- Create: `apps/api/src/services/metrics/buckets.ts`

- [ ] **Step 1: Write the file**

```ts
// apps/api/src/services/metrics/buckets.ts
import { z } from 'zod';

/**
 * The 4 canonical action buckets every action event in Signals maps into.
 * Network-specific event_schema.status enum values are mapped to these via
 * each interaction's `metric_categories` block in network.json. These names
 * appear in column names, API field names, and the status-rule DSL — they
 * are the Signals-internal vocabulary, not a network's wire format.
 */
export const CANONICAL_BUCKETS = ['create', 'accept', 'reject', 'cancel'] as const;
export type CanonicalBucket = (typeof CANONICAL_BUCKETS)[number];
export const CanonicalBucketSchema = z.enum(CANONICAL_BUCKETS);

/**
 * The 4 fixed status buckets every item lands in after recompute. Rule
 * authors in network.json's status_rules MUST emit only these values;
 * the network-config validator rejects anything else. The final
 * `default` tail rule guarantees no item is left with a null status.
 */
export const CANONICAL_STATUSES = ['new', 'active', 'at_risk', 'inactive'] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];
export const CanonicalStatusSchema = z.enum(CANONICAL_STATUSES);
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS (no errors related to new file).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/metrics/buckets.ts
git commit -m "feat(metrics): add canonical bucket + status constants"
```

---

## Task 2: Status-rule DSL evaluator (TDD)

**Files:**
- Create: `apps/api/src/services/metrics/__tests__/evaluate_status_rules.test.ts`
- Create: `apps/api/src/services/metrics/evaluate_status_rules.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/metrics/__tests__/evaluate_status_rules.test.ts
import { describe, it, expect } from 'vitest';
import {
  evaluate_status_rules,
  type RuleInput,
  type StatusRule,
} from '../evaluate_status_rules.js';

const NOW = new Date('2026-05-26T00:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

const baseInput = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  item_age_days: 10,
  count: { create: 0, accept: 0, reject: 0, cancel: 0 },
  days_since_last: { create: null, accept: null, reject: null, cancel: null },
  ...overrides,
});

describe('evaluate_status_rules', () => {
  it('matches new on item_age_days lte', () => {
    const rules: StatusRule[] = [
      { status: 'new', when: { item_age_days: { lte: 7 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 7 }))).toBe('new');
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 8 }))).toBe('inactive');
  });

  it('matches active via days_since_last with buckets', () => {
    const rules: StatusRule[] = [
      { status: 'active', when: { days_since_last: { buckets: ['accept'], lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(
        rules,
        baseInput({ days_since_last: { create: null, accept: 20, reject: null, cancel: null } }),
      ),
    ).toBe('active');
    expect(
      evaluate_status_rules(
        rules,
        baseInput({ days_since_last: { create: null, accept: 35, reject: null, cancel: null } }),
      ),
    ).toBe('inactive');
  });

  it('days_since_last predicate is false when no action in those buckets', () => {
    const rules: StatusRule[] = [
      { status: 'active', when: { days_since_last: { buckets: ['accept'], lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    // no accept action exists → predicate false → falls through to default
    expect(evaluate_status_rules(rules, baseInput())).toBe('inactive');
  });

  it('between operator is inclusive both ends', () => {
    const rules: StatusRule[] = [
      { status: 'at_risk', when: { days_since_last: { buckets: ['create'], between: [31, 90] } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 31, accept: null, reject: null, cancel: null } })),
    ).toBe('at_risk');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 90, accept: null, reject: null, cancel: null } })),
    ).toBe('at_risk');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 30, accept: null, reject: null, cancel: null } })),
    ).toBe('inactive');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 91, accept: null, reject: null, cancel: null } })),
    ).toBe('inactive');
  });

  it('count predicate sums across listed buckets', () => {
    const rules: StatusRule[] = [
      { status: 'active', when: { count: { buckets: ['create', 'accept'], gte: 1 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(rules, baseInput({ count: { create: 0, accept: 1, reject: 0, cancel: 0 } })),
    ).toBe('active');
    expect(
      evaluate_status_rules(rules, baseInput({ count: { create: 0, accept: 0, reject: 5, cancel: 5 } })),
    ).toBe('inactive');
  });

  it('all combinator ANDs children', () => {
    const rules: StatusRule[] = [
      {
        status: 'inactive',
        when: {
          all: [
            { count: { buckets: ['create', 'accept', 'reject'], eq: 0 } },
            { item_age_days: { gt: 90 } },
          ],
        },
      },
      { status: 'new', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 100 }))).toBe('inactive');
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 50 }))).toBe('new');
    expect(
      evaluate_status_rules(
        rules,
        baseInput({ item_age_days: 100, count: { create: 1, accept: 0, reject: 0, cancel: 0 } }),
      ),
    ).toBe('new');
  });

  it('any combinator ORs children', () => {
    const rules: StatusRule[] = [
      {
        status: 'at_risk',
        when: {
          any: [
            { days_since_last: { buckets: ['accept'], between: [31, 90] } },
            { days_since_last: { buckets: ['reject'], between: [31, 90] } },
          ],
        },
      },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: null, accept: 50, reject: null, cancel: null } })),
    ).toBe('at_risk');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: null, accept: null, reject: 50, cancel: null } })),
    ).toBe('at_risk');
    expect(evaluate_status_rules(rules, baseInput())).toBe('inactive');
  });

  it('first-match-wins ordering', () => {
    const rules: StatusRule[] = [
      { status: 'new', when: { item_age_days: { lte: 7 } } },
      { status: 'active', when: { item_age_days: { lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 5 }))).toBe('new');
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 20 }))).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/evaluate_status_rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the evaluator**

```ts
// apps/api/src/services/metrics/evaluate_status_rules.ts
import type { CanonicalBucket, CanonicalStatus } from './buckets.js';

export interface RuleInput {
  /** Days between profile_created_at and now (Math.floor of ms / 86_400_000). */
  item_age_days: number;
  /** Sum of action events per canonical bucket for this item. */
  count: Record<CanonicalBucket, number>;
  /**
   * Days since most recent action in each bucket. `null` when no action of
   * that bucket exists for this item — predicates referencing the bucket
   * via days_since_last evaluate FALSE in that case.
   */
  days_since_last: Record<CanonicalBucket, number | null>;
}

type Comparison =
  | { lt: number }
  | { lte: number }
  | { gt: number }
  | { gte: number }
  | { eq: number }
  | { between: [number, number] };

interface ItemAgePredicate {
  item_age_days: Comparison;
}
interface DaysSinceLastPredicate {
  days_since_last: { buckets: CanonicalBucket[] } & Comparison;
}
interface CountPredicate {
  count: { buckets: CanonicalBucket[] } & Comparison;
}
interface AllPredicate {
  all: Predicate[];
}
interface AnyPredicate {
  any: Predicate[];
}
export type Predicate =
  | ItemAgePredicate
  | DaysSinceLastPredicate
  | CountPredicate
  | AllPredicate
  | AnyPredicate;

export interface StatusRule {
  status: CanonicalStatus;
  /** Object predicate, or the literal string 'default' for the tail rule. */
  when: Predicate | 'default';
}

const compare = (value: number, op: Comparison): boolean => {
  if ('lt' in op) return value < op.lt;
  if ('lte' in op) return value <= op.lte;
  if ('gt' in op) return value > op.gt;
  if ('gte' in op) return value >= op.gte;
  if ('eq' in op) return value === op.eq;
  if ('between' in op) {
    const [lo, hi] = op.between;
    return value >= lo && value <= hi;
  }
  return false;
};

const min_not_null = (vals: Array<number | null>): number | null => {
  let best: number | null = null;
  for (const v of vals) {
    if (v === null) continue;
    if (best === null || v < best) best = v;
  }
  return best;
};

const evaluate_predicate = (pred: Predicate, input: RuleInput): boolean => {
  if ('all' in pred) {
    return pred.all.every((p) => evaluate_predicate(p, input));
  }
  if ('any' in pred) {
    return pred.any.some((p) => evaluate_predicate(p, input));
  }
  if ('item_age_days' in pred) {
    return compare(input.item_age_days, pred.item_age_days);
  }
  if ('days_since_last' in pred) {
    const { buckets, ...op } = pred.days_since_last;
    const candidate = min_not_null(buckets.map((b) => input.days_since_last[b]));
    if (candidate === null) return false;
    return compare(candidate, op as Comparison);
  }
  if ('count' in pred) {
    const { buckets, ...op } = pred.count;
    const total = buckets.reduce((s, b) => s + (input.count[b] ?? 0), 0);
    return compare(total, op as Comparison);
  }
  return false;
};

/**
 * First-match-wins evaluation of a per-domain status_rules array. The
 * final entry must be `{ status: ..., when: 'default' }` — guaranteed by
 * the network-config validator so this function never falls off the end.
 */
export const evaluate_status_rules = (
  rules: StatusRule[],
  input: RuleInput,
): CanonicalStatus => {
  for (const rule of rules) {
    if (rule.when === 'default') return rule.status;
    if (evaluate_predicate(rule.when, input)) return rule.status;
  }
  throw new Error(
    'evaluate_status_rules: no rule matched and no default tail present (config validation should have caught this)',
  );
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/evaluate_status_rules.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/evaluate_status_rules.ts apps/api/src/services/metrics/__tests__/evaluate_status_rules.test.ts
git commit -m "feat(metrics): status-rule DSL evaluator"
```

---

## Task 3: Display-name resolver (TDD)

**Files:**
- Create: `apps/api/src/services/metrics/__tests__/resolve_display_name.test.ts`
- Create: `apps/api/src/services/metrics/resolve_display_name.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/metrics/__tests__/resolve_display_name.test.ts
import { describe, it, expect } from 'vitest';
import { resolve_display_name } from '../resolve_display_name.js';

describe('resolve_display_name', () => {
  it('returns the declared field value when present and non-empty', () => {
    const schema = {
      display_name_field: 'organisation_name',
      properties: { organisation_name: { type: 'string' } },
    };
    expect(
      resolve_display_name({
        schema,
        item_state: { organisation_name: 'Helping Hands' },
        item_id: 'itm_01',
      }),
    ).toBe('Helping Hands');
  });

  it('falls back to item_id when display_name_field is not declared', () => {
    const schema = { properties: { foo: { type: 'string' } } };
    expect(
      resolve_display_name({
        schema,
        item_state: { foo: 'whatever' },
        item_id: 'itm_02',
      }),
    ).toBe('itm_02');
  });

  it('falls back to item_id when value is missing in item_state', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: {}, item_id: 'itm_03' }),
    ).toBe('itm_03');
  });

  it('falls back to item_id when value is empty string', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: { name: '   ' }, item_id: 'itm_04' }),
    ).toBe('itm_04');
  });

  it('falls back to item_id when value is null', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: { name: null }, item_id: 'itm_05' }),
    ).toBe('itm_05');
  });

  it('falls back to item_id when item_state is null', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: null, item_id: 'itm_06' }),
    ).toBe('itm_06');
  });

  it('falls back to item_id when value is not a string', () => {
    const schema = { display_name_field: 'count', properties: { count: { type: 'integer' } } };
    expect(
      resolve_display_name({ schema, item_state: { count: 42 }, item_id: 'itm_07' }),
    ).toBe('itm_07');
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/resolve_display_name.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```ts
// apps/api/src/services/metrics/resolve_display_name.ts

export interface ResolveDisplayNameSchema {
  /** Optional pointer to the item_state property to use as the display name. */
  display_name_field?: string;
  /** Standard JSON Schema `properties` object; only structurally checked here. */
  properties?: Record<string, unknown>;
}

export interface ResolveDisplayNameInput {
  schema: ResolveDisplayNameSchema;
  item_state: Record<string, unknown> | null;
  item_id: string;
}

/**
 * Resolves an item's display name for the aggregator dashboard.
 *
 * 1. If the item's schema declares `display_name_field` AND the value at
 *    `item_state[display_name_field]` is a non-empty trimmed string, return it.
 * 2. Otherwise return `item_id` as the fallback.
 *
 * Privacy is enforced upstream by the network-config validator (a schema with
 * `display_name_field` pointing at a `private: true` property fails to load),
 * so this function does not re-check privacy at recompute time.
 */
export const resolve_display_name = (i: ResolveDisplayNameInput): string => {
  const field = i.schema.display_name_field;
  if (!field) return i.item_id;
  if (!i.item_state) return i.item_id;
  const raw = i.item_state[field];
  if (typeof raw !== 'string') return i.item_id;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return i.item_id;
  return trimmed;
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/resolve_display_name.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/resolve_display_name.ts apps/api/src/services/metrics/__tests__/resolve_display_name.test.ts
git commit -m "feat(metrics): display-name resolver"
```

---

## Task 4: `network.json` Zod schema — canonical buckets, status_rules, display_name_field

**Files:**
- Modify: `packages/schemas/src/network_workflow.ts`

- [ ] **Step 1: Replace `MetricCategoriesSchema` with the canonical bucket version**

Locate the existing definition (around line 40):

```ts
const MetricCategoriesSchema = z.object({
  shortlisted: z.array(z.string().min(1)).optional().default([]),
  rejected: z.array(z.string().min(1)).optional().default([]),
  pending: z.array(z.string().min(1)).optional().default([]),
});
```

Replace with:

```ts
const MetricCategoriesSchema = z.object({
  create: z.array(z.string().min(1)).optional().default([]),
  accept: z.array(z.string().min(1)).optional().default([]),
  reject: z.array(z.string().min(1)).optional().default([]),
  cancel: z.array(z.string().min(1)).optional().default([]),
}).strict();
```

The `.strict()` rejects unknown keys at parse time — this is where bad bucket names get caught.

- [ ] **Step 2: Add canonical bucket + status enums at module top (after the Ajv import)**

After line 1-2 (the imports), add:

```ts
const CANONICAL_BUCKETS = ['create', 'accept', 'reject', 'cancel'] as const;
const CANONICAL_STATUSES = ['new', 'active', 'at_risk', 'inactive'] as const;
const CanonicalBucketSchema = z.enum(CANONICAL_BUCKETS);
const CanonicalStatusSchema = z.enum(CANONICAL_STATUSES);
```

These are duplicated here (vs. importing from `apps/api`) because `@dpg/schemas` is downstream of the canonical-bucket source of truth in `apps/api/src/services/metrics/buckets.ts` — the package can't depend up the tree. Both stay in lockstep; if a future change adds a bucket, both updates are required.

- [ ] **Step 3: Add the `StatusRuleSchema` (just before `NetworkDomainSchema`)**

```ts
const ComparisonSchema = z.union([
  z.object({ lt: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ gt: z.number() }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ eq: z.number() }).strict(),
  z.object({ between: z.tuple([z.number(), z.number()]) }).strict(),
]);

const BucketScopedComparisonSchema = z.intersection(
  z.object({ buckets: z.array(CanonicalBucketSchema).min(1) }),
  ComparisonSchema,
);

const ItemAgePredicateSchema = z.object({ item_age_days: ComparisonSchema }).strict();
const DaysSinceLastPredicateSchema = z.object({ days_since_last: BucketScopedComparisonSchema }).strict();
const CountPredicateSchema = z.object({ count: BucketScopedComparisonSchema }).strict();

// Recursive predicate: leaf predicates + all/any combinators
type PredicateInput =
  | z.input<typeof ItemAgePredicateSchema>
  | z.input<typeof DaysSinceLastPredicateSchema>
  | z.input<typeof CountPredicateSchema>
  | { all: PredicateInput[] }
  | { any: PredicateInput[] };
type PredicateOutput = PredicateInput;

const PredicateSchema: z.ZodType<PredicateOutput, z.ZodTypeDef, PredicateInput> = z.lazy(() =>
  z.union([
    ItemAgePredicateSchema,
    DaysSinceLastPredicateSchema,
    CountPredicateSchema,
    z.object({ all: z.array(PredicateSchema).min(1) }).strict(),
    z.object({ any: z.array(PredicateSchema).min(1) }).strict(),
  ]),
);

const StatusRuleSchema = z.object({
  status: CanonicalStatusSchema,
  when: z.union([PredicateSchema, z.literal('default')]),
}).strict();
```

- [ ] **Step 4: Add `display_name_field` to item_schema parsing**

The current `NetworkDomainSchema` parses `item_schemas` as `z.record(z.string(), JsonSchemaDocumentSchema)` where `JsonSchemaDocumentSchema` is `z.record(z.string(), z.unknown())`. The `display_name_field` is a non-standard top-level key on each item_schema — it survives the record parse as an unknown key. Validation happens in `superRefine` (Step 5).

No structural change here; `display_name_field` rides along as part of the schema document. Continue.

- [ ] **Step 5: Add `status_rules` to `NetworkDomainSchema`**

Locate `NetworkDomainSchema` (around line 6) and add the field. The full updated definition:

```ts
const NetworkDomainSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  minimum_cache_ttl_seconds: z.number().int().positive().optional().default(300),
  item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  default_item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  status_rules: z.array(StatusRuleSchema).min(1).optional(),
}).superRefine((domain, ctx) => {
  if (domain.status_rules) {
    const last = domain.status_rules[domain.status_rules.length - 1];
    if (last.when !== 'default') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'status_rules must end with a `{ when: "default" }` tail rule',
        path: ['status_rules', domain.status_rules.length - 1, 'when'],
      });
    }
  }
}).transform((domain) => ({
  ...domain,
  item_schemas: {
    ...domain.default_item_schemas,
    ...domain.item_schemas,
  },
}));
```

`status_rules` is **optional** here at the Zod level — the loader will require it via a separate runtime check. (Reason: networks like `inter-network-action` use stripped-down configs that don't have dashboard semantics; failing the parse would block their use. We enforce at use-site.)

- [ ] **Step 6: Add a top-level network superRefine for `display_name_field` privacy**

At the bottom of `NetworkConfigSchema` (around line 111+), wrap the existing object in a `superRefine` that walks every domain's item_schemas and checks `display_name_field`:

Find the current `NetworkConfigSchema = z.object({ ... })` and change it to retain a reference to the object then `.superRefine` it. If it already has a `.superRefine`, append to that. Concretely, after the closing brace of the `z.object({...})` body, add:

```ts
.superRefine((cfg, ctx) => {
  for (const [domainIdx, domain] of cfg.domains.entries()) {
    for (const [schemaName, schemaDoc] of Object.entries(domain.item_schemas ?? {})) {
      const doc = schemaDoc as Record<string, unknown>;
      const field = doc.display_name_field;
      if (field === undefined) continue;
      if (typeof field !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field must be a string`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const props = (doc.properties as Record<string, unknown> | undefined) ?? {};
      const target = props[field];
      if (!target || typeof target !== 'object') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field "${field}" does not exist in properties`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const t = target as Record<string, unknown>;
      if (t.private === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field "${field}" points at a private property; pick a non-private field`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      }
      if (t.type !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field "${field}" must point at a property of type "string"`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      }
    }
  }
});
```

- [ ] **Step 7: Add tests**

Create `packages/schemas/src/__tests__/network_workflow_metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NetworkConfigSchema } from '../network_workflow';

const baseConfig = {
  id: 'test_net',
  domains: [
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: { name: { type: 'string' }, secret: { type: 'string', private: true } },
        },
      },
      status_rules: [
        { status: 'new', when: { item_age_days: { lte: 7 } } },
        { status: 'inactive', when: 'default' },
      ],
    },
  ],
  instances: [],
  actions: {},
};

describe('NetworkConfigSchema metrics extensions', () => {
  it('accepts a domain with valid status_rules and display_name_field', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].item_schemas['profile_1.0'].display_name_field = 'name';
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects status_rules without a default tail', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].status_rules = [{ status: 'new', when: { item_age_days: { lte: 7 } } }];
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow(/default.*tail/);
  });

  it('rejects status with value outside CANONICAL_STATUSES', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].status_rules = [
      { status: 'satisfied', when: { item_age_days: { lte: 7 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('rejects metric_categories with unknown bucket key', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.actions = {
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: { shortlisted: ['accepted'] },
          },
        ],
      },
    };
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('accepts canonical metric_categories keys', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.actions = {
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              create: ['created'],
              accept: ['accepted'],
              reject: ['rejected'],
              cancel: ['cancelled'],
            },
          },
        ],
      },
    };
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects display_name_field pointing at a private property', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].item_schemas['profile_1.0'].display_name_field = 'secret';
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow(/private/);
  });

  it('rejects display_name_field pointing at a missing property', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].item_schemas['profile_1.0'].display_name_field = 'nonexistent';
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow(/does not exist/);
  });
});
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/network_workflow_metrics.test.ts`
Expected: 7 tests pass.

(The existing `example_network_configs.test.ts` will now FAIL because purple_dot + blue_dot still have old bucket keys — that's expected; Task 5 fixes them.)

- [ ] **Step 9: Commit**

```bash
git add packages/schemas/src/network_workflow.ts packages/schemas/src/__tests__/network_workflow_metrics.test.ts
git commit -m "feat(schemas): canonical buckets, status_rules, display_name_field in network.json"
```

---

## Task 5: Update reference `network.json` files

Five files to update. Each gets: canonical bucket keys in `metric_categories`, `status_rules` on each domain, `display_name_field` on each item_schema.

**Files:**
- Modify: `examples/schemas/purple_dot/network.json`
- Modify: `examples/schemas/blue_dot/network.json`
- Modify: `examples/schemas/yellow_dot/network.json`
- Modify: `examples/schemas/inter-network-action/blue_dot/network.json`
- Modify: `examples/schemas/inter-network-action/yellow_dot/network.json`

### Common `status_rules` to use for ALL domains in pilot

(Author can tune per-domain later; for this refactor we ship one template.)

```jsonc
"status_rules": [
  { "status": "new",      "when": { "item_age_days": { "lte": 7 } } },
  { "status": "active",   "when": { "days_since_last": { "buckets": ["create", "accept"], "lte": 30 } } },
  { "status": "at_risk",  "when": { "days_since_last": { "buckets": ["create", "accept", "reject"], "between": [31, 90] } } },
  { "status": "inactive", "when": "default" }
]
```

### 5a. purple_dot

- [ ] **Step 1: Edit `examples/schemas/purple_dot/network.json`**

Inside each domain object (seeker + provider), add `status_rules` (above) and add `display_name_field` to each item_schema:

For `domains[0]` (seeker) `item_schemas["profile_1.0"]`: omit `display_name_field` (every personally-identifying property is private). The seeker rows will have `name = item_id`.

For `domains[1]` (provider) `item_schemas["profile_1.0"]`: add `"display_name_field": "organisation_name"` (organisation_name is not marked private).

Update `actions.connect.interactions[0].metric_categories` to canonical keys:

```jsonc
"metric_categories": {
  "create": ["created"],
  "accept": ["accepted"],
  "reject": ["rejected"],
  "cancel": ["cancelled"]
}
```

`interactions[1]` (provider→seeker) keeps `metric_categories: null`.

### 5b. blue_dot

- [ ] **Step 2: Edit `examples/schemas/blue_dot/network.json`**

Add `"display_name_field": "name"` to `seeker.item_schemas["profile_1.0"]`.

Add `"display_name_field": "jobProviderName"` to `provider.item_schemas["job_posting_1.0"]`.

Add `status_rules` (template above) to both domains.

Update `actions.apply.interactions[0].metric_categories` from:
```jsonc
"metric_categories": {
  "shortlisted": ["shortlisted"],
  "rejected":    ["rejected"],
  "pending":     ["created", "submitted"]
}
```
to:
```jsonc
"metric_categories": {
  "create": ["created", "submitted"],
  "accept": ["shortlisted"],
  "reject": ["rejected"],
  "cancel": []
}
```

`interactions[1]` (provider→seeker invite) keeps `metric_categories: null`.

### 5c. yellow_dot

- [ ] **Step 3: Edit `examples/schemas/yellow_dot/network.json`**

Add `"display_name_field": "Full Name"` to whichever item_schema(s) exist in each domain. `Full Name` is not marked private in yellow_dot.

Add `status_rules` (template above) to every domain.

No `metric_categories` updates needed (yellow_dot doesn't declare any today; recompute treats it as zero counts).

### 5d. inter-network-action variants

- [ ] **Step 4: Edit `examples/schemas/inter-network-action/blue_dot/network.json` and `inter-network-action/yellow_dot/network.json`**

For each domain in both files: add `status_rules` (template) and `display_name_field` (matching the non-inter-network versions above). Update `metric_categories` keys to canonical (using the same mapping as the parent network).

- [ ] **Step 5: Update existing `example_network_configs.test.ts` if assertions break**

Check current assertions in `packages/schemas/src/__tests__/example_network_configs.test.ts`. The test asserts the seeker→provider interaction exists and `reveals_pii_on_status` works. These should still pass after the bucket rename — but the test also reads `metric_categories` indirectly via `parseNetworkConfigDocument`, which now uses canonical keys.

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/example_network_configs.test.ts`
Expected: PASS. If any assertion mentions `shortlisted`/`rejected`/`pending` bucket keys, update to `accept`/`reject`/`create`. (Inspect first; only edit if needed.)

- [ ] **Step 6: Commit**

```bash
git add examples/schemas/
git commit -m "feat(networks): canonical bucket keys, status_rules, display_name_field"
```

---

## Task 6: `item_metrics` schema — drop 8 columns, add 9

**Files:**
- Modify: `apps/api/db/postgres/schema/metrics.ts`
- Modify: `packages/database/src/utils/sql_scripts/metrics.sql`
- Regen: `apps/api/drizzle/0000_light_anthem.sql`
- Regen: `helmcharts/dpg/charts/api/files/schema.sql`

- [ ] **Step 1: Replace the body of `apps/api/db/postgres/schema/metrics.ts`**

Replace the whole `item_metrics` definition with:

```ts
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

/**
 * Item-keyed metrics for the aggregator dashboard.
 *
 * Each item gets one row. The 4 canonical action buckets
 * (create / accept / reject / cancel) drive all count + last-at columns.
 * display_name is resolved at recompute time from the item's schema-declared
 * display_name_field (or item_id as fallback).
 *
 * No FK on item_id — items is partitioned and Drizzle's FK story doesn't
 * reach partition keys cleanly. Recompute is the only writer.
 *
 * No cascade on onboarded_by_org_id FK — attribution survives org deletion.
 */
export const item_metrics = pgTable('item_metrics', {
  itemId: text('item_id').primaryKey(),
  itemNetwork: text('item_network').notNull(),
  itemDomain: text('item_domain').notNull(),
  itemType: text('item_type').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  displayName: text('display_name').notNull(),

  profileStatus: text('profile_status'),
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  countCreate: integer('count_create').default(0).notNull(),
  countAccept: integer('count_accept').default(0).notNull(),
  countReject: integer('count_reject').default(0).notNull(),
  countCancel: integer('count_cancel').default(0).notNull(),

  lastCreateAt: timestamp('last_create_at'),
  lastAcceptAt: timestamp('last_accept_at'),
  lastRejectAt: timestamp('last_reject_at'),
  lastCancelAt: timestamp('last_cancel_at'),

  actionableTags: text('actionable_tags').array(),

  lastComputedAt: timestamp('last_computed_at').notNull(),
}, (table) => [
  index('item_metrics_org_domain_status_idx').on(
    table.onboardedByOrgId,
    table.itemDomain,
    table.profileStatus,
  ),
  index('item_metrics_org_domain_last_computed_idx').on(
    table.onboardedByOrgId,
    table.itemDomain,
    table.lastComputedAt,
  ),
  index('item_metrics_owner_domain_idx').on(
    table.ownerUserId,
    table.itemDomain,
  ),
]);
```

- [ ] **Step 2: Update `packages/database/src/utils/sql_scripts/metrics.sql`**

Replace the `CREATE TABLE item_metrics (...)` body (and keep the FK constraint block + indexes underneath) with the new column shape:

```sql
DROP TABLE IF EXISTS item_metrics CASCADE;

CREATE TABLE IF NOT EXISTS item_metrics (
  item_id                   text PRIMARY KEY,
  item_network              text NOT NULL,
  item_domain               text NOT NULL,
  item_type                 text NOT NULL,
  owner_user_id             text NOT NULL,
  onboarded_by_org_id       text,
  onboarded_via             text,

  display_name              text NOT NULL,

  profile_status            text,
  profile_completion_pct    integer,
  profile_created_at        timestamp,
  profile_last_updated_at   timestamp,
  age_days                  integer,

  count_create              integer NOT NULL DEFAULT 0,
  count_accept              integer NOT NULL DEFAULT 0,
  count_reject              integer NOT NULL DEFAULT 0,
  count_cancel              integer NOT NULL DEFAULT 0,

  last_create_at            timestamp,
  last_accept_at            timestamp,
  last_reject_at            timestamp,
  last_cancel_at            timestamp,

  actionable_tags           text[],

  last_computed_at          timestamp NOT NULL
);
```

The downstream `DO $$ ... ALTER TABLE item_metrics ADD CONSTRAINT ... FOREIGN KEY (onboarded_by_org_id) REFERENCES organization(id);` block and the three indexes underneath stay as-is (they reference column names that did not change: `onboarded_by_org_id`, `item_domain`, `profile_status`, `last_computed_at`, `owner_user_id`).

The top `DROP TABLE IF EXISTS participant_metrics CASCADE;` line should also stay — it's a no-op on fresh installs but documents intent.

- [ ] **Step 3: Regenerate Drizzle migration**

```bash
rm -f apps/api/drizzle/0000_light_anthem.sql apps/api/drizzle/meta/*
pnpm db:generate:api
```

This regenerates the baseline. Verify the generated file contains `display_name`, `count_create`, `count_accept`, `count_reject`, `count_cancel`, `last_create_at`, `last_accept_at`, `last_reject_at`, `last_cancel_at` and does **not** contain `applications_total`, `applications_pending`, `applications_shortlisted`, `applications_rejected`, `last_applied_at`, `last_shortlisted_at`, `last_rejected_at`, `openings`:

```bash
grep -E '(display_name|count_create|applications_total)' apps/api/drizzle/0000_light_anthem.sql
```

Expected: 5 hits for the new columns, 0 for the old ones.

- [ ] **Step 4: Regenerate the helm-bundled schema**

```bash
pnpm schema:bundle
pnpm schema:bundle:check
```

Both should succeed; the check verifies the bundled `helmcharts/dpg/charts/api/files/schema.sql` matches the source SQL scripts.

- [ ] **Step 5: Verify typecheck passes (subsequent recompute.ts changes are still pending, so existing references will break — that's expected; just confirm the schema file itself typechecks)**

```bash
pnpm --filter api exec tsc --noEmit apps/api/db/postgres/schema/metrics.ts
```

Expected: PASS for the schema file in isolation (other files reference the dropped columns and will fail; that's fixed in Task 10).

- [ ] **Step 6: Commit**

```bash
git add apps/api/db/postgres/schema/metrics.ts \
        apps/api/drizzle/ \
        packages/database/src/utils/sql_scripts/metrics.sql \
        helmcharts/dpg/charts/api/files/schema.sql
git commit -m "feat(db): item_metrics canonical bucket columns + display_name"
```

---

## Task 7: Refactor `metric_categories.ts` to canonical buckets

**Files:**
- Modify: `apps/api/src/services/metrics/metric_categories.ts`
- Modify: `apps/api/src/services/metrics/__tests__/metric_categories.test.ts`

- [ ] **Step 1: Rewrite `metric_categories.ts`**

```ts
// apps/api/src/services/metrics/metric_categories.ts
import type { NetworkConfigDocument } from '@dpg/schemas';
import { CANONICAL_BUCKETS, type CanonicalBucket } from './buckets.js';

/** Per-bucket arrays of raw `event_schema.status` values that map to each canonical bucket. */
export type MetricCategoriesMap = Record<CanonicalBucket, string[]>;

export interface InteractionWithCategories {
  actionType: string;
  fromDomain: string;
  toDomain: string;
  categories: MetricCategoriesMap;
}

const empty_categories = (): MetricCategoriesMap => ({
  create: [],
  accept: [],
  reject: [],
  cancel: [],
});

const normalize = (
  raw: Partial<MetricCategoriesMap> | null | undefined,
): MetricCategoriesMap | null => {
  if (!raw) return null;
  const out = empty_categories();
  for (const b of CANONICAL_BUCKETS) {
    out[b] = raw[b] ?? [];
  }
  // If every bucket is empty, treat as null (nothing to count).
  if (CANONICAL_BUCKETS.every((b) => out[b].length === 0)) return null;
  return out;
};

/**
 * Walks the network config and collects every interaction whose
 * `metric_categories` is non-null and non-empty. Each entry carries the
 * (action_type, from_domain, to_domain) tuple plus its canonical mapping.
 *
 * Recompute uses this list to aggregate item_actions in BOTH directions
 * (the same item can be source OR target). Interactions with null/empty
 * metric_categories are skipped (the historical "not tracked" sentinel).
 */
export const collect_tracked_interactions = (
  networkConfig: NetworkConfigDocument,
): InteractionWithCategories[] => {
  const out: InteractionWithCategories[] = [];
  for (const [actionType, action] of Object.entries(networkConfig.actions ?? {})) {
    for (const interaction of action.interactions) {
      const raw = (interaction as { metric_categories?: Partial<MetricCategoriesMap> | null })
        .metric_categories;
      const categories = normalize(raw);
      if (!categories) continue;
      out.push({
        actionType,
        fromDomain: interaction.from_domain,
        toDomain: interaction.to_domain,
        categories,
      });
    }
  }
  return out;
};
```

This **replaces** the old `discover_metric_categories` / `resolve_metric_categories` functions. The new model walks ALL tracked interactions, not just the first one.

- [ ] **Step 2: Rewrite tests**

Replace `apps/api/src/services/metrics/__tests__/metric_categories.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { collect_tracked_interactions } from '../metric_categories.js';
import type { NetworkConfigDocument } from '@dpg/schemas';

const makeConfig = (interactions: unknown[]): NetworkConfigDocument =>
  ({
    id: 'test',
    domains: [],
    instances: [],
    actions: { connect: { interactions } },
  }) as unknown as NetworkConfigDocument;

describe('collect_tracked_interactions', () => {
  it('returns empty list when no interactions declare metric_categories', () => {
    const cfg = makeConfig([
      { from_domain: 'seeker', to_domain: 'provider', metric_categories: null, requirement_schema: {} },
    ]);
    expect(collect_tracked_interactions(cfg)).toEqual([]);
  });

  it('returns each interaction with non-empty canonical map', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker', to_domain: 'provider',
        requirement_schema: {},
        metric_categories: { create: ['created'], accept: ['accepted'], reject: ['rejected'], cancel: ['cancelled'] },
      },
      {
        from_domain: 'provider', to_domain: 'seeker',
        requirement_schema: {},
        metric_categories: null,
      },
    ]);
    const result = collect_tracked_interactions(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      actionType: 'connect',
      fromDomain: 'seeker',
      toDomain: 'provider',
      categories: { create: ['created'], accept: ['accepted'], reject: ['rejected'], cancel: ['cancelled'] },
    });
  });

  it('treats an interaction with all-empty buckets as untracked', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker', to_domain: 'provider',
        requirement_schema: {},
        metric_categories: { create: [], accept: [], reject: [], cancel: [] },
      },
    ]);
    expect(collect_tracked_interactions(cfg)).toEqual([]);
  });

  it('partial maps fill missing buckets with empty arrays', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker', to_domain: 'provider',
        requirement_schema: {},
        metric_categories: { create: ['created'] },
      },
    ]);
    const result = collect_tracked_interactions(cfg);
    expect(result[0].categories).toEqual({
      create: ['created'],
      accept: [],
      reject: [],
      cancel: [],
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/metric_categories.test.ts`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/metrics/metric_categories.ts apps/api/src/services/metrics/__tests__/metric_categories.test.ts
git commit -m "refactor(metrics): canonical-bucket metric_categories; collect all tracked interactions"
```

---

## Task 8: Simplify `actionable_tags.ts` — drop business tags

**Files:**
- Modify: `apps/api/src/services/metrics/actionable_tags.ts`
- Modify: `apps/api/src/services/metrics/__tests__/actionable_tags.test.ts`

- [ ] **Step 1: Replace `actionable_tags.ts`**

```ts
// apps/api/src/services/metrics/actionable_tags.ts
import { is_populated } from './profile_completion.js';

interface ActionableTagsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export interface ActionableTagsInput {
  payload: Record<string, unknown>;
  schema: ActionableTagsSchema;
}

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Schema-derived `missing_<required_field>` tags only.
 *
 * Network-specific business tags (`all_applications_rejected`,
 * `no_recent_activity`, `no_applications_yet`, `decisions_overdue`)
 * are removed — those names baked Jobs vocabulary into Signals. If a
 * future product need calls for business tags, add them via a config-
 * driven `tag_rules` array reusing the status-rule DSL.
 */
export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];
  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }
  return tags;
};
```

- [ ] **Step 2: Replace tests**

```ts
// apps/api/src/services/metrics/__tests__/actionable_tags.test.ts
import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

describe('compute_actionable_tags', () => {
  it('returns empty when all required fields are populated', () => {
    expect(
      compute_actionable_tags({
        payload: { name: 'Acme', phone: '+91...' },
        schema: { required: ['name', 'phone'], properties: { name: {}, phone: {} } },
      }),
    ).toEqual([]);
  });

  it('emits missing_<slugified_field> for each unpopulated required field', () => {
    expect(
      compute_actionable_tags({
        payload: { name: 'Acme' },
        schema: { required: ['name', 'Phone Number', 'email_address'], properties: {} },
      }),
    ).toEqual(['missing_phone_number', 'missing_email_address']);
  });

  it('treats empty strings and empty arrays as unpopulated', () => {
    expect(
      compute_actionable_tags({
        payload: { name: '', tags: [] },
        schema: { required: ['name', 'tags'], properties: {} },
      }),
    ).toEqual(['missing_name', 'missing_tags']);
  });

  it('returns empty when schema has no required fields', () => {
    expect(compute_actionable_tags({ payload: {}, schema: {} })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/actionable_tags.test.ts`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/metrics/actionable_tags.ts apps/api/src/services/metrics/__tests__/actionable_tags.test.ts
git commit -m "refactor(metrics): drop hardcoded business tags; schema-derived only"
```

---

## Task 9: Delete obsolete per-domain status modules

**Files:**
- Delete: `apps/api/src/services/metrics/seeker_status.ts`
- Delete: `apps/api/src/services/metrics/provider_status.ts`
- Delete: `apps/api/src/services/metrics/__tests__/seeker_status.test.ts`
- Delete: `apps/api/src/services/metrics/__tests__/provider_status.test.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm apps/api/src/services/metrics/seeker_status.ts \
       apps/api/src/services/metrics/provider_status.ts \
       apps/api/src/services/metrics/__tests__/seeker_status.test.ts \
       apps/api/src/services/metrics/__tests__/provider_status.test.ts
```

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(metrics): drop per-domain status functions in favor of rule evaluator"
```

(`recompute.ts` still imports these — typecheck will fail until Task 10 lands. That's expected and contained.)

---

## Task 10: Rewrite `recompute.ts` — bidirectional, rule-driven, display-name

**Files:**
- Modify: `apps/api/src/services/metrics/recompute.ts`
- Modify: `apps/api/src/services/metrics/__tests__/recompute.test.ts`

- [ ] **Step 1: Replace `recompute.ts`**

```ts
// apps/api/src/services/metrics/recompute.ts
import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../db/postgres/schema/metrics.js';
import { profile_completion_pct } from './profile_completion.js';
import { compute_actionable_tags } from './actionable_tags.js';
import { get_item_schema } from './schema_lookup.js';
import { collect_tracked_interactions, type MetricCategoriesMap } from './metric_categories.js';
import { evaluate_status_rules, type StatusRule } from './evaluate_status_rules.js';
import { resolve_display_name } from './resolve_display_name.js';
import { CANONICAL_BUCKETS, type CanonicalBucket, type CanonicalStatus } from './buckets.js';
import { getNetworkConfigById } from '@/network_configs';

const BATCH_SIZE = 1000;
const MS_PER_DAY = 86_400_000;

const to_date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  throw new TypeError(`to_date: unexpected ${typeof v}`);
};

const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

export interface RecomputeResult {
  processed: number;
  duration_ms: number;
}

interface AggregatedRow {
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
  count_create: number;
  count_accept: number;
  count_reject: number;
  count_cancel: number;
  last_create_at: Date | string | null;
  last_accept_at: Date | string | null;
  last_reject_at: Date | string | null;
  last_cancel_at: Date | string | null;
}

/**
 * Build the WHERE clauses for action aggregation. For every tracked
 * interaction (action_type, from_domain, to_domain) in the network config,
 * we emit a row in a UNION ALL — each row tags actions whose item_id can
 * be matched from the source OR target side depending on which side this
 * domain participates in.
 *
 * The result is a `(item_id, bucket, created_at)` event stream the outer
 * GROUP BY in the main CTE buckets into counts and MAX timestamps.
 */
const buildInteractionEvents = (
  tracked: Array<{ actionType: string; fromDomain: string; toDomain: string; categories: MetricCategoriesMap }>,
  domain: string,
): import('drizzle-orm').SQL | null => {
  const pieces: import('drizzle-orm').SQL[] = [];

  for (const t of tracked) {
    const isSource = t.fromDomain === domain;
    const isTarget = t.toDomain === domain;
    if (!isSource && !isTarget) continue;

    const idCol = isSource ? sql`source_item_id` : sql`target_item_id`;

    for (const bucket of CANONICAL_BUCKETS) {
      const statuses = t.categories[bucket];
      if (statuses.length === 0) continue;
      const list = sql.join(statuses.map((s) => sql`${s}`), sql`, `);
      pieces.push(sql`
        SELECT
          ${idCol} AS item_id,
          ${bucket} AS bucket,
          created_at
        FROM item_actions
        WHERE action_type = ${t.actionType}
          AND source_item_domain = ${t.fromDomain}
          AND target_item_domain = ${t.toDomain}
          AND action_status IN (${list})
          AND ${idCol} IS NOT NULL
      `);
    }
  }

  if (pieces.length === 0) return null;
  return sql.join(pieces, sql` UNION ALL `);
};

/**
 * Recomputes item_metrics for all items owned by users onboarded by the
 * given aggregator within the given domain. Bidirectional: aggregates
 * actions in both source and target positions, per the tracked-interactions
 * collected from the network config. Per-item status is evaluated against
 * the domain's status_rules from network.json.
 */
export const recompute_aggregator_domain_metrics = async (
  aggregator_id: string,
  domain: string,
): Promise<RecomputeResult> => {
  const started = Date.now();
  const now = new Date();

  // Discover the network for this (aggregator, domain) via a one-row sample.
  // All items in a (aggregator, domain) share a network in our data model.
  const sample = await db.execute<{ item_network: string }>(sql`
    SELECT i.item_network
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain}
    LIMIT 1
  `);
  const sampleRows: Array<{ item_network: string }> = Array.isArray(sample)
    ? (sample as Array<{ item_network: string }>)
    : ((sample as { rows?: Array<{ item_network: string }> }).rows ?? []);
  if (sampleRows.length === 0) {
    return { processed: 0, duration_ms: Date.now() - started };
  }
  const network = sampleRows[0].item_network;

  const networkConfig = await getNetworkConfigById(network);
  const tracked = collect_tracked_interactions(networkConfig);
  const eventsCte = buildInteractionEvents(tracked, domain);

  // Resolve status_rules for this domain.
  const domainCfg = networkConfig.domains.find((d) => d.id === domain);
  if (!domainCfg) {
    throw new Error(
      `recompute: domain "${domain}" not found in network "${network}" config`,
    );
  }
  const status_rules = (domainCfg as { status_rules?: StatusRule[] }).status_rules;
  if (!status_rules || status_rules.length === 0) {
    throw new Error(
      `recompute: network "${network}" domain "${domain}" has no status_rules — add per spec`,
    );
  }

  // Main query: aggregate events into per-item bucket counts/timestamps,
  // join to items + user attribution. Empty `eventsCte` (no tracked
  // interactions touch this domain) → action_counts is an empty CTE so
  // every join yields 0 counts via COALESCE.
  const actionCountsCte = eventsCte
    ? sql`
        WITH ev AS (${eventsCte}),
        action_counts AS (
          SELECT
            item_id,
            COUNT(*) FILTER (WHERE bucket = 'create')::int AS count_create,
            COUNT(*) FILTER (WHERE bucket = 'accept')::int AS count_accept,
            COUNT(*) FILTER (WHERE bucket = 'reject')::int AS count_reject,
            COUNT(*) FILTER (WHERE bucket = 'cancel')::int AS count_cancel,
            MAX(created_at) FILTER (WHERE bucket = 'create') AS last_create_at,
            MAX(created_at) FILTER (WHERE bucket = 'accept') AS last_accept_at,
            MAX(created_at) FILTER (WHERE bucket = 'reject') AS last_reject_at,
            MAX(created_at) FILTER (WHERE bucket = 'cancel') AS last_cancel_at
          FROM ev
          GROUP BY item_id
        )
      `
    : sql`
        WITH action_counts AS (
          SELECT
            ''::text AS item_id,
            0::int AS count_create, 0::int AS count_accept,
            0::int AS count_reject, 0::int AS count_cancel,
            NULL::timestamp AS last_create_at,
            NULL::timestamp AS last_accept_at,
            NULL::timestamp AS last_reject_at,
            NULL::timestamp AS last_cancel_at
          WHERE FALSE
        )
      `;

  const result = await db.execute<AggregatedRow>(sql`
    ${actionCountsCte}
    SELECT
      i.item_id            AS item_id,
      i.item_network       AS item_network,
      i.item_domain        AS item_domain,
      i.item_type          AS item_type,
      i.created_by         AS owner_user_id,
      u.onboarded_by_org_id AS onboarded_by_org_id,
      u.onboarded_via      AS onboarded_via,
      i.item_state         AS item_state,
      i.created_at         AS profile_created_at,
      i.updated_at         AS profile_last_updated_at,
      COALESCE(ac.count_create, 0) AS count_create,
      COALESCE(ac.count_accept, 0) AS count_accept,
      COALESCE(ac.count_reject, 0) AS count_reject,
      COALESCE(ac.count_cancel, 0) AS count_cancel,
      ac.last_create_at, ac.last_accept_at,
      ac.last_reject_at, ac.last_cancel_at
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    LEFT JOIN action_counts ac ON ac.item_id = i.item_id
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain};
  `);
  const rows: AggregatedRow[] = Array.isArray(result)
    ? (result as AggregatedRow[])
    : ((result as { rows?: AggregatedRow[] }).rows ?? []);

  let processed = 0;
  let buffer: Array<typeof item_metrics.$inferInsert> = [];

  for (const r of rows) {
    const payload = (r.item_state ?? {}) as Record<string, unknown>;
    const profile_created = to_date(r.profile_created_at) ?? now;
    const profile_updated = to_date(r.profile_last_updated_at) ?? profile_created;
    const last_create = to_date(r.last_create_at);
    const last_accept = to_date(r.last_accept_at);
    const last_reject = to_date(r.last_reject_at);
    const last_cancel = to_date(r.last_cancel_at);

    const schema = await get_item_schema(r.item_network, r.item_domain, r.item_type);

    const age_days = days_between(profile_created, now);

    const dsl_input = {
      item_age_days: age_days,
      count: {
        create: r.count_create,
        accept: r.count_accept,
        reject: r.count_reject,
        cancel: r.count_cancel,
      } as Record<CanonicalBucket, number>,
      days_since_last: {
        create: last_create === null ? null : days_between(last_create, now),
        accept: last_accept === null ? null : days_between(last_accept, now),
        reject: last_reject === null ? null : days_between(last_reject, now),
        cancel: last_cancel === null ? null : days_between(last_cancel, now),
      } as Record<CanonicalBucket, number | null>,
    };

    const profileStatus: CanonicalStatus = evaluate_status_rules(status_rules, dsl_input);

    const displayName = resolve_display_name({
      schema: schema as { display_name_field?: string; properties?: Record<string, unknown> },
      item_state: payload,
      item_id: r.item_id,
    });

    buffer.push({
      itemId: r.item_id,
      itemNetwork: r.item_network,
      itemDomain: r.item_domain,
      itemType: r.item_type,
      ownerUserId: r.owner_user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      displayName,
      profileStatus,
      profileCompletionPct: profile_completion_pct(payload, schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: age_days,
      countCreate: r.count_create,
      countAccept: r.count_accept,
      countReject: r.count_reject,
      countCancel: r.count_cancel,
      lastCreateAt: last_create,
      lastAcceptAt: last_accept,
      lastRejectAt: last_reject,
      lastCancelAt: last_cancel,
      actionableTags: compute_actionable_tags({ payload, schema }),
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

const flush = async (
  rows: Array<typeof item_metrics.$inferInsert>,
): Promise<void> => {
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
        displayName: sql`excluded.display_name`,
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileCreatedAt: sql`excluded.profile_created_at`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        countCreate: sql`excluded.count_create`,
        countAccept: sql`excluded.count_accept`,
        countReject: sql`excluded.count_reject`,
        countCancel: sql`excluded.count_cancel`,
        lastCreateAt: sql`excluded.last_create_at`,
        lastAcceptAt: sql`excluded.last_accept_at`,
        lastRejectAt: sql`excluded.last_reject_at`,
        lastCancelAt: sql`excluded.last_cancel_at`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
```

- [ ] **Step 2: Rewrite `recompute.test.ts`**

Replace existing tests with a focused happy-path mock-driven test:

```ts
// apps/api/src/services/metrics/__tests__/recompute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be defined before importing recompute.ts.
const executeMock = vi.fn();
const insertMock = vi.fn(() => ({
  values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(async () => undefined) })),
}));
vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { execute: executeMock, insert: insertMock },
}));
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'purple_dot',
    domains: [
      {
        id: 'seeker',
        item_schemas: {
          'profile_1.0': {
            type: 'object',
            required: ['beneficiary_name'],
            properties: { beneficiary_name: { type: 'string', private: true } },
          },
        },
        status_rules: [
          { status: 'new', when: { item_age_days: { lte: 7 } } },
          { status: 'inactive', when: 'default' },
        ],
      },
    ],
    actions: {
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              create: ['created'],
              accept: ['accepted'],
              reject: ['rejected'],
              cancel: ['cancelled'],
            },
          },
        ],
      },
    },
  })),
}));
vi.mock('../schema_lookup.js', () => ({
  get_item_schema: vi.fn(async () => ({
    type: 'object',
    required: ['beneficiary_name'],
    properties: { beneficiary_name: { type: 'string', private: true } },
  })),
}));

import { recompute_aggregator_domain_metrics } from '../recompute.js';

describe('recompute_aggregator_domain_metrics', () => {
  beforeEach(() => {
    executeMock.mockReset();
    insertMock.mockClear();
  });

  it('returns processed: 0 when no items exist for the (aggregator, domain)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // sample
    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(0);
  });

  it('computes and upserts one item with empty action counts → status new (age <= 7)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ item_network: 'purple_dot' }] }); // sample
    const now = new Date();
    const created = new Date(now.getTime() - 3 * 86_400_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          item_id: 'itm_1',
          item_network: 'purple_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          owner_user_id: 'u_1',
          onboarded_by_org_id: 'org_1',
          onboarded_via: 'bulk',
          item_state: { beneficiary_name: 'Asha' },
          profile_created_at: created,
          profile_last_updated_at: created,
          count_create: 0,
          count_accept: 0,
          count_reject: 0,
          count_cancel: 0,
          last_create_at: null,
          last_accept_at: null,
          last_reject_at: null,
          last_cancel_at: null,
        },
      ],
    });

    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(1);
    expect(insertMock).toHaveBeenCalledOnce();
    // The mock chain captures buffer rows — verify count_create / displayName values
    // by inspecting insertMock's downstream value via a custom spy if needed.
  });
});
```

(Heavier integration coverage lives in the PG-backed test in Task 13.)

- [ ] **Step 3: Run tests**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/recompute.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4: Typecheck the whole API**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS for everything except the dashboard/export routes (those are fixed in Tasks 13 + 14). If only those two files complain, proceed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/recompute.ts apps/api/src/services/metrics/__tests__/recompute.test.ts
git commit -m "feat(metrics): bidirectional recompute with rule-driven status + display name"
```

---

## Task 11: `staleness.ts` — add `force` argument

**Files:**
- Modify: `apps/api/src/services/metrics/staleness.ts`
- Modify: `apps/api/src/services/metrics/__tests__/staleness.test.ts`

- [ ] **Step 1: Update `check_and_refresh_if_stale` signature**

Replace the existing function in `staleness.ts` with:

```ts
export const check_and_refresh_if_stale = async (
  aggregator_id: string,
  domain: string,
  force = false,
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
    force ||
    min_ts === null ||
    (Date.now() - min_ts.getTime()) / 1000 > TTL_SECONDS;

  if (!stale) {
    return { refreshed: false, last_computed_at: min_ts };
  }

  const lock_key = lock_key_for(aggregator_id, domain);
  // force=true uses BLOCKING pg_advisory_lock so a concurrent recompute is
  // awaited; non-force uses pg_try_advisory_lock to skip-on-contention.
  const lock_sql = force
    ? sql`SELECT pg_advisory_lock(${lock_key.toString()}::bigint) AS locked`
    : sql`SELECT pg_try_advisory_lock(${lock_key.toString()}::bigint) AS locked`;
  const lockResult: unknown = await db.execute(lock_sql);
  const lock_rows: Array<{ locked?: unknown }> = Array.isArray(lockResult)
    ? (lockResult as Array<{ locked?: unknown }>)
    : ((lockResult as { rows?: Array<{ locked?: unknown }> }).rows ?? []);
  // pg_advisory_lock returns void/true; pg_try_advisory_lock returns boolean.
  const acquired = force ? true : lock_rows[0]?.locked === true;

  if (!acquired) {
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

- [ ] **Step 2: Extend tests**

Add to existing `staleness.test.ts` (alongside whatever's there):

```ts
it('force=true bypasses TTL and uses pg_advisory_lock', async () => {
  // Minimal mock — set up so a not-stale row exists and force forces refresh.
  // Implementation-specific; consult existing patterns in the file.
});
```

(Concrete test code depends on the mocking style already used in `staleness.test.ts`. Keep the additions minimal — the integration test in Task 13 covers end-to-end semantics.)

- [ ] **Step 3: Run tests**

Run: `pnpm --filter api exec vitest run src/services/metrics/__tests__/staleness.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/metrics/staleness.ts apps/api/src/services/metrics/__tests__/staleness.test.ts
git commit -m "feat(metrics): force=true on staleness check uses blocking advisory lock"
```

---

## Task 12: Update `@dpg/schemas` `aggregator/dashboard.ts`

**Files:**
- Modify: `packages/schemas/src/aggregator/dashboard.ts`

- [ ] **Step 1: Replace the file**

```ts
import z from 'zod';

const StatusEnum = z.enum(['new', 'active', 'at_risk', 'inactive']);
const BucketEnum = z.enum(['create', 'accept', 'reject', 'cancel']);

/**
 * Query parameters for GET /api/v1/aggregator/dashboard.
 *
 * page, limit  — offset pagination over item_metrics.
 * domain       — narrows the response to one of org.metadata.domains.
 * status       — filter item rows by profile_status.
 * q            — free-text search (accepted, not yet wired).
 * refresh      — force recompute, bypass TTL, blocking advisory lock.
 */
export const DashboardRequestQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  domain: z.string().min(1).optional(),
  status: StatusEnum.optional(),
  q: z.string().min(1).max(200).optional(),
  refresh: z.coerce.boolean().optional().default(false),
});

export const ItemRollup = z.object({
  // 7 fixed tiles
  total_items: z.number(),
  complete_profiles: z.number(),
  has_applications: z.number(),
  by_status: z.record(StatusEnum, z.number()),

  // generic derived (network-agnostic)
  by_action_status: z.record(BucketEnum, z.number()),
  avg_items_per_user: z.number(),
  avg_actions_per_user: z.number(),
  mode_wise_counts: z.record(z.string(), z.number()),
});

/**
 * One item row. Same shape across every domain — no NULL-on-other-side.
 * Acting org context is implicit from the calling header, so item_id,
 * owner_user_id, onboarded_by_org_id are intentionally omitted.
 */
export const ItemRow = z.object({
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  name: z.string(),
  onboarded_via: z.string().nullable(),

  profile_status: StatusEnum.nullable(),
  profile_completion_pct: z.number().nullable(),
  profile_created_at: z.string().nullable(),
  profile_last_updated_at: z.string().nullable(),
  age_days: z.number().nullable(),

  count_create: z.number(),
  count_accept: z.number(),
  count_reject: z.number(),
  count_cancel: z.number(),

  last_create_at: z.string().nullable(),
  last_accept_at: z.string().nullable(),
  last_reject_at: z.string().nullable(),
  last_cancel_at: z.string().nullable(),

  actionable_tags: z.array(z.string()),
});

export const DomainBlock = z.object({
  rollup: ItemRollup,
  items: z.array(ItemRow),
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
  refresh: z.coerce.boolean().optional().default(false),
});

export type DashboardRequestQuery = z.infer<typeof DashboardRequestQuery>;
export type ItemRollup = z.infer<typeof ItemRollup>;
export type ItemRow = z.infer<typeof ItemRow>;
export type DomainBlock = z.infer<typeof DomainBlock>;
export type DashboardResponse = z.infer<typeof DashboardResponse>;
export type ExportQuery = z.infer<typeof ExportQuery>;
```

- [ ] **Step 2: Typecheck the package**

```bash
pnpm --filter @dpg/schemas exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/schemas/src/aggregator/dashboard.ts
git commit -m "feat(schemas): canonical dashboard response shape (items, refresh, by_action_status)"
```

---

## Task 13: Rewrite dashboard route handler

**Files:**
- Modify: `apps/api/src/routes/v1/aggregator/dashboard.ts`
- Modify: `apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts`
- Modify: `apps/api/src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts`

- [ ] **Step 1: Replace `dashboard.ts`**

```ts
import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization } from '../../../../db/postgres/schema/auth.js';
import { eq, and, sql, desc, getTableColumns } from 'drizzle-orm';
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

  const [org] = (await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, acting.org_id))
    .limit(1)) as Array<{ metadata: string | null }>;

  let configured_domains: string[] = [];
  if (org?.metadata) {
    try {
      const meta = JSON.parse(org.metadata) as { domains?: unknown };
      if (Array.isArray(meta.domains)) {
        configured_domains = (meta.domains as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        );
      }
    } catch { /* fallthrough → 400 below */ }
  }
  if (configured_domains.length === 0) {
    return reply.code(400).send({
      error: 'NO_DOMAINS_CONFIGURED',
      message: 'org.metadata.domains is empty — re-upsert with domains array',
    });
  }

  const { page, limit, domain: requested_domain, status, refresh } = request.query;
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

  const staleness = await Promise.all(
    scope.map((d) => check_and_refresh_if_stale(acting.org_id, d, refresh)),
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

  // Single aggregate query for the rollup tiles + derived metrics.
  const rollupRes: unknown = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_items,
      COUNT(*) FILTER (WHERE ${item_metrics.profileCompletionPct} >= 100)::int AS complete_profiles,
      COUNT(*) FILTER (
        WHERE (${item_metrics.countCreate} + ${item_metrics.countAccept}
             + ${item_metrics.countReject} + ${item_metrics.countCancel}) > 0
      )::int AS has_applications,

      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'new')::int      AS s_new,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'active')::int   AS s_active,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'at_risk')::int  AS s_at_risk,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'inactive')::int AS s_inactive,

      COALESCE(SUM(${item_metrics.countCreate}), 0)::int AS b_create,
      COALESCE(SUM(${item_metrics.countAccept}), 0)::int AS b_accept,
      COALESCE(SUM(${item_metrics.countReject}), 0)::int AS b_reject,
      COALESCE(SUM(${item_metrics.countCancel}), 0)::int AS b_cancel,

      COUNT(DISTINCT ${item_metrics.ownerUserId})::int AS unique_users,
      COALESCE(SUM(
        ${item_metrics.countCreate} + ${item_metrics.countAccept}
        + ${item_metrics.countReject} + ${item_metrics.countCancel}
      ), 0)::int AS total_actions,
      COUNT(DISTINCT ${item_metrics.ownerUserId}) FILTER (
        WHERE (${item_metrics.countCreate} + ${item_metrics.countAccept}
             + ${item_metrics.countReject} + ${item_metrics.countCancel}) > 0
      )::int AS engaged_users
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain};
  `);
  const rollupRow: Record<string, number> = (Array.isArray(rollupRes)
    ? (rollupRes as Array<Record<string, number>>)[0]
    : ((rollupRes as { rows?: Array<Record<string, number>> }).rows ?? [])[0]) ?? {};

  const modeRes: unknown = await db.execute(sql`
    SELECT ${item_metrics.onboardedVia} AS via, COUNT(*)::int AS n
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain}
    GROUP BY ${item_metrics.onboardedVia};
  `);
  const modeRows: Array<{ via: string | null; n: number }> = Array.isArray(modeRes)
    ? (modeRes as Array<{ via: string | null; n: number }>)
    : ((modeRes as { rows?: Array<{ via: string | null; n: number }> }).rows ?? []);
  const mode_wise_counts: Record<string, number> = {};
  for (const r of modeRows) if (r?.via) mode_wise_counts[r.via] = r.n;

  const total_items = rollupRow.total_items ?? 0;
  const unique_users = rollupRow.unique_users ?? 0;
  const total_actions = rollupRow.total_actions ?? 0;
  const engaged_users = rollupRow.engaged_users ?? 0;

  const rollup = {
    total_items,
    complete_profiles: rollupRow.complete_profiles ?? 0,
    has_applications: rollupRow.has_applications ?? 0,
    by_status: {
      new: rollupRow.s_new ?? 0,
      active: rollupRow.s_active ?? 0,
      at_risk: rollupRow.s_at_risk ?? 0,
      inactive: rollupRow.s_inactive ?? 0,
    },
    by_action_status: {
      create: rollupRow.b_create ?? 0,
      accept: rollupRow.b_accept ?? 0,
      reject: rollupRow.b_reject ?? 0,
      cancel: rollupRow.b_cancel ?? 0,
    },
    avg_items_per_user: unique_users > 0 ? total_items / unique_users : 0,
    avg_actions_per_user: engaged_users > 0 ? total_actions / engaged_users : 0,
    mode_wise_counts,
  };

  const total_rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(item_metrics)
    .where(filter_where!)) as Array<{ n: number }>;
  const total_matching = total_rows[0]?.n ?? 0;

  const list_rows = await db
    .select(getTableColumns(item_metrics))
    .from(item_metrics)
    .where(filter_where!)
    .orderBy(desc(item_metrics.profileLastUpdatedAt), desc(item_metrics.itemId))
    .limit(limit)
    .offset((page - 1) * limit);

  const items = list_rows.map((r) => ({
    item_network: r.itemNetwork,
    item_domain: r.itemDomain,
    item_type: r.itemType,
    name: r.displayName,
    onboarded_via: r.onboardedVia,

    profile_status: r.profileStatus as 'new' | 'active' | 'at_risk' | 'inactive' | null,
    profile_completion_pct: r.profileCompletionPct,
    profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
    profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
    age_days: r.ageDays,

    count_create: r.countCreate ?? 0,
    count_accept: r.countAccept ?? 0,
    count_reject: r.countReject ?? 0,
    count_cancel: r.countCancel ?? 0,

    last_create_at: r.lastCreateAt?.toISOString() ?? null,
    last_accept_at: r.lastAcceptAt?.toISOString() ?? null,
    last_reject_at: r.lastRejectAt?.toISOString() ?? null,
    last_cancel_at: r.lastCancelAt?.toISOString() ?? null,

    actionable_tags: r.actionableTags ?? [],
  }));

  return {
    rollup,
    items,
    total_matching,
    next_cursor: list_rows.length === limit ? String(page + 1) : null,
  };
}

export default aggregator_dashboard;
```

- [ ] **Step 2: Update existing dashboard tests**

The existing `dashboard.test.ts` and `dashboard_multidomain.test.ts` assert against the old shape. Skim each test and update:
- Rename assertions from `participants` to `items`.
- Replace expected fields `applications_total/pending/shortlisted/rejected` with `count_create/accept/reject/cancel`.
- Replace `last_applied_at/last_shortlisted_at/last_rejected_at/openings` with `last_create_at/last_accept_at/last_reject_at/last_cancel_at`.
- Remove `unique_users`, `complete_profiles_count`, `users_with_applications`, `new_users_last_7_days` assertions.
- Replace with `total_items`, `complete_profiles`, `has_applications`, `by_status`, `by_action_status`, `avg_items_per_user`, `avg_actions_per_user`.

Run the updated tests:

```bash
pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/dashboard.test.ts \
                                  src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run integration test**

If docker is available locally:

```bash
docker compose up -d db redis
pnpm --filter api test:integration -- src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts
```

Update the integration test to seed connect actions (not apply), assert new shape. If the seed is more elaborate than a quick test update can handle, mark the integration test with `it.todo` and address in Task 15.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1/aggregator/dashboard.ts \
        apps/api/src/routes/v1/aggregator/__tests__/dashboard.test.ts \
        apps/api/src/routes/v1/aggregator/__tests__/dashboard_multidomain.test.ts \
        apps/api/src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts
git commit -m "feat(aggregator): dashboard returns items, canonical counts, ?refresh"
```

---

## Task 14: Rewrite export route handler

**Files:**
- Modify: `apps/api/src/routes/v1/aggregator/export.ts`
- Modify: `apps/api/src/routes/v1/aggregator/__tests__/export.test.ts`

- [ ] **Step 1: Replace `export.ts`**

```ts
import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { Readable } from 'node:stream';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization } from '../../../../db/postgres/schema/auth.js';
import { eq, and, inArray, asc, getTableColumns } from 'drizzle-orm';
import { ExportQuery, type ExportQuery as ExportQueryType } from '@dpg/schemas';
import { check_and_refresh_if_stale } from '@/services/metrics/staleness';

const COLUMNS = [
  'item_network',
  'item_domain',
  'item_type',
  'name',
  'onboarded_via',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'count_create',
  'count_accept',
  'count_reject',
  'count_cancel',
  'last_create_at',
  'last_accept_at',
  'last_reject_at',
  'last_cancel_at',
  'actionable_tags',
] as const;

const PAGE_SIZE = 5000;

const csv_escape = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s: string;
  if (Array.isArray(v)) s = v.join('|');
  else if (v instanceof Date) s = v.toISOString();
  else s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const read_configured_domains = async (
  org_id: string,
): Promise<string[] | null> => {
  const [org] = (await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, org_id))
    .limit(1)) as Array<{ metadata: string | null }>;
  if (!org?.metadata) return null;
  try {
    const meta = JSON.parse(org.metadata) as { domains?: unknown };
    if (!Array.isArray(meta.domains)) return null;
    return (meta.domains as unknown[]).filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
};

async function* generate_csv(
  aggregator_id: string,
  scope: string[],
  status: string | undefined,
): AsyncGenerator<string> {
  yield COLUMNS.join(',') + '\n';

  const base_where = and(
    eq(item_metrics.onboardedByOrgId, aggregator_id),
    inArray(item_metrics.itemDomain, scope),
  );
  const where = status
    ? and(base_where, eq(item_metrics.profileStatus, status))
    : base_where;

  let offset = 0;
  for (;;) {
    const rows = await db
      .select(getTableColumns(item_metrics))
      .from(item_metrics)
      .where(where!)
      .orderBy(asc(item_metrics.itemDomain), asc(item_metrics.itemId))
      .limit(PAGE_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const r of rows) {
      const projected: Record<(typeof COLUMNS)[number], unknown> = {
        item_network: r.itemNetwork,
        item_domain: r.itemDomain,
        item_type: r.itemType,
        name: r.displayName,
        onboarded_via: r.onboardedVia,
        profile_status: r.profileStatus,
        profile_completion_pct: r.profileCompletionPct,
        profile_created_at: r.profileCreatedAt,
        profile_last_updated_at: r.profileLastUpdatedAt,
        age_days: r.ageDays,
        count_create: r.countCreate,
        count_accept: r.countAccept,
        count_reject: r.countReject,
        count_cancel: r.countCancel,
        last_create_at: r.lastCreateAt,
        last_accept_at: r.lastAcceptAt,
        last_reject_at: r.lastRejectAt,
        last_cancel_at: r.lastCancelAt,
        actionable_tags: r.actionableTags,
      };
      yield COLUMNS.map((c) => csv_escape(projected[c])).join(',') + '\n';
    }

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

type ExportRequest = FastifyRequest<{ Querystring: ExportQueryType }>;

export const aggregator_export: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard/export',
    schema: { tags: ['aggregator'], querystring: ExportQuery },
    handler: async (request: ExportRequest, reply: FastifyReply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({
          error: 'NOT_AGGREGATOR',
          message: 'caller must act on behalf of an aggregator org',
        });
      }

      const configured = await read_configured_domains(acting.org_id);
      if (!configured || configured.length === 0) {
        return reply.code(400).send({
          error: 'NO_DOMAINS_CONFIGURED',
          message: 'org.metadata.domains is empty — re-upsert with domains array',
        });
      }

      const { domain: requested_domain, status, refresh } = request.query;
      let scope = configured;
      if (requested_domain) {
        if (!configured.includes(requested_domain)) {
          return reply.code(400).send({
            error: 'DOMAIN_NOT_CONFIGURED',
            message: `?domain=${requested_domain} is not in org.metadata.domains`,
          });
        }
        scope = [requested_domain];
      }

      await Promise.all(
        scope.map((d) => check_and_refresh_if_stale(acting.org_id, d, refresh)),
      );

      const filename = `items_${acting.org_id}_${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`);

      return reply.send(Readable.from(generate_csv(acting.org_id, scope, status)));
    },
  });
};

export default aggregator_export;
```

- [ ] **Step 2: Update tests**

In `export.test.ts`:
- Assert the new 19-column header line: `item_network,item_domain,item_type,name,onboarded_via,profile_status,profile_completion_pct,profile_created_at,profile_last_updated_at,age_days,count_create,count_accept,count_reject,count_cancel,last_create_at,last_accept_at,last_reject_at,last_cancel_at,actionable_tags`.
- Assert filename starts with `items_`.
- Assert `?refresh=true` triggers a refresh (mock `check_and_refresh_if_stale` and verify the `force` arg is `true`).
- Drop assertions on `item_id`, `owner_user_id`, `onboarded_by_org_id`, `name` (from user join), `applications_*`, `last_applied_at`, `last_shortlisted_at`, `last_rejected_at`, `openings`.

Run:

```bash
pnpm --filter api exec vitest run src/routes/v1/aggregator/__tests__/export.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/v1/aggregator/export.ts apps/api/src/routes/v1/aggregator/__tests__/export.test.ts
git commit -m "feat(aggregator): export streams new column set, items_ filename, ?refresh"
```

---

## Task 15: Postman + docs

**Files:**
- Modify: `docs/postman/` aggregator collection JSON (locate via `ls docs/postman/`)
- Modify: `docs/operations/integrating-dpgs.md`

- [ ] **Step 1: Locate Postman aggregator collection**

```bash
ls docs/postman/
```

The aggregator collection likely lives at `docs/postman/<n>-aggregator.postman_collection.json` (Plan 3 / Plan B added it). Open it.

- [ ] **Step 2: Update dashboard request example response body**

Find the `GET /api/v1/aggregator/dashboard` request inside the collection. Replace the example response body's structure with the new shape from the spec:

```jsonc
{
  "by_domain": {
    "seeker": {
      "rollup": {
        "total_items": 5,
        "complete_profiles": 2,
        "has_applications": 3,
        "by_status": { "new": 2, "active": 1, "at_risk": 1, "inactive": 1 },
        "by_action_status": { "create": 4, "accept": 1, "reject": 1, "cancel": 0 },
        "avg_items_per_user": 1.0,
        "avg_actions_per_user": 2.0,
        "mode_wise_counts": { "bulk": 5 }
      },
      "items": [
        {
          "item_network": "purple_dot",
          "item_domain": "seeker",
          "item_type": "profile_1.0",
          "name": "itm_abc...",
          "onboarded_via": "bulk",
          "profile_status": "new",
          "profile_completion_pct": 80,
          "profile_created_at": "2026-05-26T...",
          "profile_last_updated_at": "2026-05-26T...",
          "age_days": 3,
          "count_create": 1, "count_accept": 0, "count_reject": 0, "count_cancel": 0,
          "last_create_at": "2026-05-26T...",
          "last_accept_at": null, "last_reject_at": null, "last_cancel_at": null,
          "actionable_tags": []
        }
      ],
      "total_matching": 5,
      "next_cursor": null
    }
  },
  "metadata": { "last_computed_at": "2026-05-26T...", "ttl_seconds": 3600, "refreshed": false }
}
```

Also add the `refresh` query parameter to the request's `url.query[]` block (boolean, optional, default false).

- [ ] **Step 3: Update export request example**

In the same collection, find the `GET /api/v1/aggregator/dashboard/export` request. Update the example body to a CSV snippet with the 19 new columns. Add `refresh` query param.

- [ ] **Step 4: Update `docs/operations/integrating-dpgs.md`**

Find the section(s) describing the dashboard and export endpoints. Replace:
- `participants` → `items`
- `applications_*` → `count_*` and `last_*_at` (canonical buckets)
- Add `?refresh=true` description
- Document the `display_name_field` requirement in `network.json` (under each item_schema)
- Document the per-domain `status_rules` requirement and DSL (link to the spec for grammar)
- Document the new rollup tile names and what each derives from

Aim for clear short paragraphs; no full duplication of the spec — link to it for the DSL reference.

- [ ] **Step 5: Verify docs site builds**

If the docs app is wired into `pnpm typecheck`:

```bash
pnpm --filter docs exec astro check
```

Expected: PASS.

- [ ] **Step 6: Run full typecheck**

```bash
pnpm typecheck
```

Expected: PASS across all packages.

- [ ] **Step 7: Run all unit tests one more time**

```bash
pnpm --filter api test && pnpm --filter @dpg/schemas test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add docs/postman/ docs/operations/integrating-dpgs.md
git commit -m "docs: dashboard/export response shape, ?refresh, status_rules + display_name_field"
```

---

## Self-review against spec

| Spec section | Task |
|---|---|
| Canonical model — 4 buckets, 4 statuses, 7 rollup tile names | Task 1 (constants), Task 12 (Zod), Task 13 (rollup query) |
| `metric_categories` canonical bucket keys | Task 4 (Zod), Task 5 (network.json edits), Task 7 (helper) |
| Per-domain `status_rules` DSL | Task 2 (evaluator), Task 4 (Zod + validation), Task 5 (network.json edits) |
| `display_name_field` per item_schema | Task 3 (resolver), Task 4 (validation), Task 5 (network.json edits), Task 10 (recompute writes) |
| `item_metrics` schema (drop 8, add 9) | Task 6 |
| Bidirectional recompute (source + target) | Task 10 |
| `?refresh=true` with blocking advisory lock | Task 11, Task 12 (queries), Task 13 + 14 (route plumbing) |
| Drop hardcoded business tags | Task 8 |
| Delete seeker_status / provider_status modules | Task 9 |
| `participants` → `items` rename | Task 12 (Zod), Task 13 (handler) |
| Drop `item_id`, `owner_user_id`, `onboarded_by_org_id` from row | Task 12 (Zod), Task 13 + 14 (handler/export) |
| New rollup field names (`total_items`, `by_action_status`, `avg_items_per_user`, etc.) | Task 12 + 13 |
| CSV filename `items_*` | Task 14 |
| Network config validation at boot (status_rules, bucket keys, display_name_field) | Task 4 |
| Postman + docs/operations update | Task 15 |
| `interaction with metric_categories: null` excluded from counts | Task 7 (collect_tracked_interactions skips null) |

All spec items have a task.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-metrics-config-driven-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
