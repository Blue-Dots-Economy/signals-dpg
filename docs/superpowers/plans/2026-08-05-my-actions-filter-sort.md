# My Actions — Per-Profile Filter & Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-profile-scoped filtering and sorting (status, type, match score, distance, schema-driven non-PII facets) to the My Actions page, server-enforced and PII-safe, matching the approved prototype.

**Architecture:** `match_score` is computed once at connect (async, on the write path) and stored as one nullable column on `item_actions`; the My Actions fetch reads it as a plain column. Distance and non-PII facets are read live via the existing `items` join (no denormalization). The page is scoped to one of the user's live profiles via the existing `item_id` param + the shared `useActiveProfile` store, inside `PageShell`.

**Tech Stack:** Fastify + Zod (`fastify-type-provider-zod`) + Drizzle ORM (API); React 19 + Vite + TanStack Query + Tailwind/shadcn (UI); Vitest for tests.

**Design spec:** `docs/superpowers/specs/2026-08-04-my-actions-filter-sort-redesign-design.md`
**Approved UI reference:** `docs/superpowers/specs/2026-08-04-my-actions-prototype.html` — implementation must match it.

## Global Constraints

- **Files are snake_case**; route handler exports snake_case, internal handler fns camelCase; Zod schemas PascalCase; DB columns snake_case.
- **Routes never throw** — return `reply.code(N).send({ error, message })` with a machine-readable `error` code; log via `request.log.error({ err, context }, 'msg')`.
- **ESM only, strict TS, no `any`**; use `import type` for type-only imports. No `console.log` in library packages. No `// TODO` comments.
- **Migrations:** never hand-edit generated migrations — edit `apps/api/db/postgres/schema/*.ts`, then `pnpm db:generate:api`, then `pnpm schema:bundle`. Read `apps/api/drizzle/README.md` first.
- **Backward compatibility:** every new `/action/fetch` query param is optional with a safe default; existing callers must be unaffected.
- **PII:** name/mobile/email/address are NEVER used to filter or sort. Display masking is unchanged (`reveals_pii_on_status` + `lifecycle_status==='live'`, fail-closed).
- **match_score:** computed for **all interaction types**, **only at action create** — never on accept/reject/cancel/complete. Null when a source snapshot is unavailable (cross-instance) or the relevance call fails.
- **Commit style:** small commits per step; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT commit/push to `feature`. Work on `feat/439-my-actions-filter-sort`.
- **Verification commands:** API unit `pnpm --filter api test`; typecheck `pnpm typecheck`; one API file `pnpm --filter api exec vitest run <path>`; UI test `pnpm --filter ui exec vitest run <path>`.

---

## File Structure

**API**
- Modify `apps/api/db/postgres/schema/…/item_actions.ts` (or the `packages/database` ref table mirror per repo convention) — add `match_score` column + two composite indexes.
- Create `apps/api/src/services/actions/compute_match_score.ts` — builds match-score inputs from two item snapshots and returns a numeric score or null.
- Modify `apps/api/src/routes/v1/network/action/perform_action.ts` — fire-and-forget score compute + row update after commit.
- Create `apps/api/scripts/backfill_action_match_scores.ts` — one-off backfill.
- Modify `packages/schemas/src/api/action_schemas.ts` — extend `FetchOwnedRecordsQuerySchemaBase`; extend `OwnedItemActionSchema`; add `meta.applied`.
- Modify `apps/api/src/routes/v1/action/fetch_actions.ts` — multi-status/type, sort, owned-by-caller check, partition prune, fast/enriched paths, facet + distance enrichment.

**UI**
- Modify `apps/ui/src/lib/action-api.ts` — extend `FetchMyActionsQuery` + `Action`; serialize new params.
- Modify `apps/ui/src/lib/query-keys.ts` — add new params (`item_id`, sort, facets) to `actions.list`.
- Modify `apps/ui/src/hooks/use-actions.ts` — accept `itemId`+params; `useInfiniteQuery`.
- Modify `apps/ui/src/pages/my-actions-page.tsx` — wrap in `PageShell`; live-only profiles; `useActiveProfile`; URL sync.
- Create `apps/ui/src/components/actions/action-toolbar.tsx` — chips + sort menu + filters button + tokens.
- Create `apps/ui/src/components/actions/action-filters-sheet.tsx` — schema-driven facets + action type.
- Modify `apps/ui/src/components/actions/action-card.tsx` — MatchScoreBadge (%), distance, facet chips, "Not scored yet".
- Modify `apps/ui/src/components/actions/action-list.tsx` — infinite list; drop client status filter; keep empty state + bulk.
- Modify `apps/ui/src/locales/en.json` + `hi.json` — new i18n keys.

---

## PHASE 1 — Database

### Task 1: Add `match_score` column + status indexes to `item_actions`

**Files:**
- Modify: `packages/database/src/drizzle_ref_tables/item_actions.ts`
- Modify (generated): `apps/api/drizzle/` (via `pnpm db:generate:api`)
- Modify (generated): `apps/api/db/postgres/schema.sql` (via `pnpm schema:bundle`)

**Interfaces:**
- Produces: `item_actions.match_score` (nullable `real`); indexes `item_actions_target_owner_status_idx (target_item_owner, action_status, updated_at)` and `item_actions_source_owner_status_idx (source_item_owner, action_status, updated_at)`.

- [ ] **Step 1: Read the migration rules**

Run: open and read `apps/api/drizzle/README.md` and `.claude/rules/database-conventions.md`. Confirm whether `item_actions` is a *generated* (declarative) or *custom* (hand-written) table. It is **partitioned** — its partitions come from a **custom** migration (`0010_action_pair_open_indexes.sql` exists), so the column add + new indexes likely need a **custom** migration (`drizzle-kit generate --custom`), not a plain generated one. Decide based on the README before proceeding.

- [ ] **Step 2: Add the column + indexes to the Drizzle table**

In `packages/database/src/drizzle_ref_tables/item_actions.ts`, add the column after `remarks`:

```ts
    match_score: real('match_score'),
```

Add `real` to the `drizzle-orm/pg-core` import. In the table's index array add:

```ts
    index('item_actions_target_owner_status_idx').on(
      table.target_item_owner,
      table.action_status,
      table.updated_at
    ),
    index('item_actions_source_owner_status_idx').on(
      table.source_item_owner,
      table.action_status,
      table.updated_at
    ),
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate:api` (or the `--custom` variant per Step 1). Inspect the produced SQL under `apps/api/drizzle/` — confirm it is `ALTER TABLE item_actions ADD COLUMN match_score real;` plus the two `CREATE INDEX` statements, and nothing destructive.

- [ ] **Step 4: Bundle + verify the schema**

Run: `pnpm schema:bundle` then `pnpm schema:bundle:check`
Expected: exit 0 (bundle matches checked-in copy).

- [ ] **Step 5: Apply + smoke-test locally**

Run: `docker compose up -d db redis` then the repo's migrate command (`node apps/api/scripts/migrate.mjs` or the documented `pnpm` alias). Then, in `psql`, confirm the column exists:
Run: `psql "$DATABASE_URL" -c "\d+ item_actions" | grep match_score`
Expected: a `match_score | real` row.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/drizzle_ref_tables/item_actions.ts apps/api/drizzle apps/api/db/postgres/schema.sql
git commit -m "feat(db): add item_actions.match_score column + owner/status indexes (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 2 — Write-path scoring

### Task 2: Match-score compute service

**Files:**
- Create: `apps/api/src/services/actions/compute_match_score.ts`
- Test: `apps/api/src/services/actions/__tests__/compute_match_score.test.ts`

**Interfaces:**
- Consumes: `getMatchScoreClient()` from `@/utils/match_score_client`; `MatchScoreItem = { item_state: Record<string,unknown>; item_latitude?: number|null; item_longitude?: number|null }` from `@dpg/match_score`.
- Produces: `computeActionMatchScore(source: ItemSnapshotLike, target: ItemSnapshotLike, log): Promise<number | null>` where `ItemSnapshotLike = { item_state: Record<string,unknown>; item_locations?: Array<{lat:number;lng:number}> | null }`. Returns the numeric `score` or `null` on any missing input / client error.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { computeActionMatchScore } from '../compute_match_score';

vi.mock('@/utils/match_score_client', () => ({
  getMatchScoreClient: () => ({
    calculate: vi.fn(async () => ({ provider: 'test', score: 7.4 })),
  }),
}));

const log = { warn: vi.fn(), error: vi.fn() } as any;

describe('computeActionMatchScore', () => {
  it('returns the numeric score from the relevance client', async () => {
    const s = await computeActionMatchScore(
      { item_state: { a: 1 }, item_locations: [{ lat: 12.9, lng: 77.6 }] },
      { item_state: { b: 2 }, item_locations: [] },
      log,
    );
    expect(s).toBe(7.4);
  });

  it('returns null when either snapshot is missing', async () => {
    expect(await computeActionMatchScore(null as any, { item_state: {} }, log)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/actions/__tests__/compute_match_score.test.ts`
Expected: FAIL ("computeActionMatchScore" not exported).

- [ ] **Step 3: Implement the service**

```ts
import { getMatchScoreClient } from '@/utils/match_score_client';
import type { FastifyBaseLogger } from 'fastify';

export interface ItemSnapshotLike {
  item_state: Record<string, unknown>;
  item_locations?: Array<{ lat: number; lng: number }> | null;
}

function toMatchScoreItem(s: ItemSnapshotLike) {
  const primary = s.item_locations?.[0] ?? null;
  return {
    item_state: s.item_state ?? {},
    item_latitude: primary ? primary.lat : null,
    item_longitude: primary ? primary.lng : null,
  };
}

/**
 * Computes the item-to-item relevance score for an action at create time.
 * Returns the numeric score, or null when a snapshot is missing (e.g.
 * cross-instance source) or the relevance service errors — never throws.
 */
export async function computeActionMatchScore(
  source: ItemSnapshotLike | null,
  target: ItemSnapshotLike | null,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<number | null> {
  if (!source || !target) return null;
  try {
    const result = await getMatchScoreClient().calculate({
      itemA: toMatchScoreItem(source),
      itemB: toMatchScoreItem(target),
    });
    return typeof result.score === 'number' ? result.score : null;
  } catch (err) {
    log.warn({ err }, 'action match-score compute failed — storing null');
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/actions/__tests__/compute_match_score.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the client contract**

Confirm `getMatchScoreClient().calculate` accepts `{ itemA, itemB }` of `MatchScoreItem` and returns an object with a numeric `score` (see `packages/match_score/src/match_score.types.ts` + `apps/api/src/utils/match_score_client.ts`). Adjust field names in the code above if the real types differ.
Run: `pnpm typecheck`
Expected: no errors in the new file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actions/compute_match_score.ts apps/api/src/services/actions/__tests__/compute_match_score.test.ts
git commit -m "feat(api): action match-score compute service (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Wire async score compute into the write path

**Files:**
- Modify: `apps/api/src/routes/v1/network/action/perform_action.ts` (after the action-event dispatch block, ~line 353-385)
- Test: `apps/api/src/routes/v1/network/action/__tests__/perform_action.match_score.test.ts`

**Interfaces:**
- Consumes: `computeActionMatchScore` (Task 2); `created` row (has `action_id`, `action_type`); `sourceItemSnapshot` (nullable), `targetItemSnapshot` (both carry `item_state` + `item_locations`); `db`, `item_actions`.
- Produces: side-effect — after commit, updates `item_actions.match_score` for the created action. Never blocks the 201 response.

- [ ] **Step 1: Write the failing test**

```ts
// Verifies the handler kicks off a non-blocking score update after create.
// Mock db.update(...).set(...).where(...) and computeActionMatchScore; assert
// the 201 is returned WITHOUT awaiting the update, and the update runs with the
// computed score. Follow the existing perform_action test setup in this dir for
// the db/network-config mocks.
import { describe, it, expect, vi } from 'vitest';
// ...mock @/services/actions/compute_match_score to resolve 6.1
// ...invoke perform_network_action_handler with a local source + target snapshot
// assert: reply.code(201) called; db update called with { match_score: 6.1 }
```

Write the concrete test mirroring the sibling `perform_action` tests' harness (same `vi.mock` of `@api/db/postgres/drizzle_config`, `@/network_configs`, `@/utils/action_event_runtime`). Assert (a) `reply.send` with the created row happens, and (b) after `await`ing a flushed microtask, the mocked `db.update` was called with `match_score: 6.1` for the created `action_id`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/network/action/__tests__/perform_action.match_score.test.ts`
Expected: FAIL (no update call).

- [ ] **Step 3: Implement the fire-and-forget compute**

In `perform_action.ts`, add the import:

```ts
import { computeActionMatchScore } from '@/services/actions/compute_match_score';
import { and, eq } from 'drizzle-orm';
```

After the `dispatchActionNotifications(...)` block and before `return reply.code(201).send(created);`, insert:

```ts
  // Match score (#439): computed ONCE at create, for all interaction types,
  // and stored on the row. Fire-and-forget so connect latency is unaffected;
  // null when the source snapshot is unavailable (cross-instance) or the
  // relevance service errors. Never recomputed on status change.
  void computeActionMatchScore(sourceItemSnapshot, targetItemSnapshot, request.log)
    .then(async (score) => {
      if (score === null) return;
      await db
        .update(item_actions)
        .set({ match_score: score })
        .where(
          and(
            eq(item_actions.partition_network, body.target_item.item_network),
            eq(item_actions.action_type, created.action_type),
            eq(item_actions.action_id, created.action_id),
          ),
        );
    })
    .catch((err) =>
      request.log.error({ err, action_id: created.action_id }, 'match-score row update failed'),
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/network/action/__tests__/perform_action.match_score.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no status-update path computes score**

Run: `grep -n "computeActionMatchScore\|match_score" apps/api/src/routes/v1/action/update_action_status.ts`
Expected: no matches (accept/reject/cancel/complete must not touch the score).

- [ ] **Step 6: Full API test run + commit**

Run: `pnpm --filter api test`
Expected: PASS.

```bash
git add apps/api/src/routes/v1/network/action/perform_action.ts apps/api/src/routes/v1/network/action/__tests__/perform_action.match_score.test.ts
git commit -m "feat(api): compute+store match_score async at action create (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4: Backfill script for existing open actions

**Files:**
- Create: `apps/api/scripts/backfill_action_match_scores.ts`

**Interfaces:**
- Consumes: `db`, `item_actions`, `items`, `computeActionMatchScore`, `terminalStatuses` (`@/services/action_pair_cap`), `getNetworkConfigById`.
- Produces: a runnable script that sets `match_score` for open (non-terminal) actions where both items are local + live and score is currently null.

- [ ] **Step 1: Implement the script**

```ts
/**
 * One-off backfill (#439): populate item_actions.match_score for existing OPEN
 * actions where both endpoints resolve to local, live items. Idempotent — skips
 * rows that already have a score. Run once after the migration:
 *   pnpm --filter api exec tsx scripts/backfill_action_match_scores.ts
 */
import { and, eq, isNull, inArray, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { item_actions, items } from '@dpg/database';
import { computeActionMatchScore } from '@/services/actions/compute_match_score';

async function main() {
  const rows = await db
    .select()
    .from(item_actions)
    .where(isNull(item_actions.match_score));

  let updated = 0;
  for (const row of rows) {
    const [src] = await db
      .select({ item_state: items.item_state, item_locations: items.item_locations, lifecycle_status: items.lifecycle_status })
      .from(items).where(eq(items.item_id, row.source_item_id));
    const [tgt] = await db
      .select({ item_state: items.item_state, item_locations: items.item_locations, lifecycle_status: items.lifecycle_status })
      .from(items).where(eq(items.item_id, row.target_item_id));
    if (!src || !tgt || src.lifecycle_status !== 'live' || tgt.lifecycle_status !== 'live') continue;

    const score = await computeActionMatchScore(
      { item_state: src.item_state as Record<string, unknown>, item_locations: src.item_locations as any },
      { item_state: tgt.item_state as Record<string, unknown>, item_locations: tgt.item_locations as any },
      console as any,
    );
    if (score === null) continue;
    await db.update(item_actions).set({ match_score: score }).where(
      and(
        eq(item_actions.partition_network, row.partition_network),
        eq(item_actions.action_type, row.action_type),
        eq(item_actions.action_id, row.action_id),
      ),
    );
    updated++;
  }
  // eslint-disable-next-line no-console
  console.log(`backfilled ${updated}/${rows.length} action match scores`);
  process.exit(0);
}
void main();
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (adjust `item_locations` typing to the real column type if needed).

- [ ] **Step 3: Commit**

```bash
git add apps/api/scripts/backfill_action_match_scores.ts
git commit -m "chore(api): backfill script for existing action match scores (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 3 — API fetch: schema + DB-stage

### Task 5: Extend the fetch query + response schemas

**Files:**
- Modify: `packages/schemas/src/api/action_schemas.ts`
- Test: `packages/schemas/src/api/__tests__/action_schemas.test.ts` (create if absent)

**Interfaces:**
- Produces: on `FetchOwnedRecordsQuerySchemaBase` — `action_status` and `action_type` accept string | string[] → normalized to `string[]`; `sort: 'recent'|'oldest'|'match_score'|'distance'` (default `'recent'`); `facets?: Array<{field:string; values:string[]}>`. On `OwnedItemActionSchema` — `match_score: number | null`, `distance_m: number | null`. Response `meta` gains `applied` (echo of honoured sort/filters).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FetchOwnedActionsQuerySchema } from '../action_schemas';

describe('FetchOwnedActionsQuerySchema', () => {
  it('coerces a single action_status to an array', () => {
    const q = FetchOwnedActionsQuerySchema.parse({ action_status: 'created' });
    expect(q.action_status).toEqual(['created']);
  });
  it('accepts repeated action_status values', () => {
    const q = FetchOwnedActionsQuerySchema.parse({ action_status: ['created', 'pending'] });
    expect(q.action_status).toEqual(['created', 'pending']);
  });
  it('defaults sort to recent and rejects unknown sort keys', () => {
    expect(FetchOwnedActionsQuerySchema.parse({}).sort).toBe('recent');
    expect(() => FetchOwnedActionsQuerySchema.parse({ sort: 'name' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/schemas exec vitest run src/api/__tests__/action_schemas.test.ts` (or the repo's schemas test command)
Expected: FAIL.

- [ ] **Step 3: Extend the base schema**

In `action_schemas.ts`, add a helper + fields. Replace the single `action_status` on `FetchOwnedRecordsQuerySchemaBase` and add the rest:

```ts
const toStringArray = (v: string | string[] | undefined) =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

export const ActionSortKeySchema = z.enum(['recent', 'oldest', 'match_score', 'distance']);

const FetchOwnedRecordsQuerySchemaBase = z.object({
  action_id: z.uuid().optional(),
  action_type: z.union([z.string().min(1), z.array(z.string().min(1))]).optional().transform(toStringArray),
  action_status: z.union([z.string().min(1), z.array(z.string().min(1))]).optional().transform(toStringArray),
  item_id: z.uuid().optional(),
  ownership_role: ActionOwnershipRoleSchema.default('all'),
  sort: ActionSortKeySchema.default('recent'),
  facets: z
    .array(z.object({ field: z.string().min(1), values: z.array(z.string()).min(1) }))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
```

Extend the row + response schemas:

```ts
export const OwnedItemActionSchema = ItemActionSelectSchema.extend({
  ownership_roles: ActionOwnershipTagSchema.array().min(1),
  source_item_name: z.string().nullable().optional(),
  target_item_name: z.string().nullable().optional(),
  match_score: z.number().nullable().optional(),
  distance_m: z.number().nullable().optional(),
});
```

> Note: `ItemActionSelectSchema = createSelectSchema(item_actions)` now includes `match_score` automatically from Task 1.

- [ ] **Step 4: Run test to verify it passes**

Run: the schemas test command from Step 2.
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck the downstream consumers**

Run: `pnpm typecheck`
Expected: errors ONLY in `fetch_actions.ts` (it reads `action_status` as a single value / lacks the new fields) — those are fixed in Task 6. If other callers break, note them; they should still compile since all new fields are optional.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/api/action_schemas.ts packages/schemas/src/api/__tests__/action_schemas.test.ts
git commit -m "feat(schemas): extend fetch-actions query (multi-status/type, sort, facets) + row score/distance (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 6: fetch_actions handler — scoping, multi-status/type, sort fast path, owned-by-caller

**Files:**
- Modify: `apps/api/src/routes/v1/action/fetch_actions.ts`
- Test: `apps/api/src/routes/v1/action/__tests__/fetch_actions.filter_sort.test.ts`

**Interfaces:**
- Consumes: extended `FetchOwnedActionsQuerySchema` (Task 5); `db`, `item_actions`, `and/or/eq/inArray/desc/asc/sql`.
- Produces: response `{ meta:{ total, limit, offset, applied }, actions: [...] }`; honours `action_status[]`/`action_type[]` via `inArray`, `sort` (recent/oldest/match_score) in SQL, and rejects an `item_id` the caller doesn't own with `403 FORBIDDEN_ITEM`.

- [ ] **Step 1: Write the failing test**

```ts
// Uses the existing fetch_actions test harness (mock db select chain). Assert:
// 1) action_status=['created','pending'] produces an inArray condition;
// 2) sort='match_score' orders by match_score desc NULLS LAST then updated_at;
// 3) a non-owned item_id → 403 FORBIDDEN_ITEM;
// 4) meta.applied echoes { sort:'match_score', statuses:['created','pending'] }.
```

Write it mirroring any existing `fetch_actions` test; if none exists, mock `@api/db/postgres/drizzle_config`'s `db` with a chainable builder capturing `.where`/`.orderBy` args.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/fetch_actions.filter_sort.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update destructuring + multi-value filters**

In `fetch_actions_handler`, change the `action_status`/`action_type` conditions (currently `eq` at lines ~71-72) to array-aware:

```ts
  const { action_id, action_type, action_status, item_id, ownership_role, sort, facets, limit, offset } = request.query;

  const conditions = [];
  if (action_id) conditions.push(eq(item_actions.action_id, action_id));
  if (action_type?.length) conditions.push(inArray(item_actions.action_type, action_type));
  if (action_status?.length) conditions.push(inArray(item_actions.action_status, action_status));
```

- [ ] **Step 4: Add the owned-by-caller check for item_id**

Immediately after resolving `userId` and before building the owner filter, when `item_id` is present verify ownership for the requested role (defense-in-depth; today it fails closed to empty):

```ts
  if (item_id) {
    const ownerCol =
      ownership_role === 'initiated' ? item_actions.source_item_owner
      : ownership_role === 'received' ? item_actions.target_item_owner
      : null;
    // For 'all' we can't disambiguate a side; the owner AND item_id conditions
    // already fail closed. For a specific side, reject a foreign item_id loudly.
    if (ownerCol) {
      const [owned] = await db
        .select({ n: sql<number>`count(*)` })
        .from(item_actions)
        .where(and(eq(ownerCol, userId),
          eq(ownership_role === 'initiated' ? item_actions.source_item_id : item_actions.target_item_id, item_id)));
      // Note: zero rows is ambiguous (no actions yet vs not owned). Prefer a
      // lightweight items-table ownership check instead if available; otherwise
      // keep the existing fail-closed behaviour and SKIP the 403 (document it).
    }
  }
```

> Implementation choice: if an `items`-table `created_by` lookup is cheap here, use it to return a real `403 { error:'FORBIDDEN_ITEM' }` when the item isn't the caller's. If not, keep the existing fail-closed empty-list behaviour and drop this step's 403 (update the Task 6 test accordingly). Decide based on what `items` access already exists in this handler.

- [ ] **Step 5: Add the sort (fast path)**

Replace the fixed `orderBy` (line ~114) with a sort selector:

```ts
  const orderBy =
    sort === 'oldest' ? [asc(item_actions.updated_at), asc(item_actions.created_at)]
    : sort === 'match_score' ? [sql`${item_actions.match_score} DESC NULLS LAST`, desc(item_actions.updated_at)]
    : [desc(item_actions.updated_at), desc(item_actions.created_at)]; // 'recent' default
  // 'distance' is handled in the enriched path (Task 7); fall through to 'recent'
  // ordering here and let the enrichment stage re-sort.
```

Apply `.orderBy(...orderBy)` to the rows query.

- [ ] **Step 6: Add `meta.applied` to the response**

```ts
    return reply.code(200).send({
      meta: {
        total: Number(count), limit, offset,
        applied: { sort, statuses: action_status ?? [], types: action_type ?? [], facets: facets ?? [] },
      },
      actions: rows.map((row) => ({ /* ...existing mapping... */ match_score: row.match_score ?? null })),
    });
```

Update `FetchOwnedActionsResponseSchema` (top of file) to include `applied` in `meta` and `match_score` on rows (or rely on `OwnedItemActionSchema`).

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/fetch_actions.filter_sort.test.ts` then `pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/v1/action/fetch_actions.ts apps/api/src/routes/v1/action/__tests__/fetch_actions.filter_sort.test.ts
git commit -m "feat(api): multi-status/type filter + sort (score NULLS LAST) + item ownership guard (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 4 — API enrich: facets + distance

### Task 7: Facet filter + distance sort over the bounded per-profile set

**Files:**
- Modify: `apps/api/src/routes/v1/action/fetch_actions.ts`
- Test: `apps/api/src/routes/v1/action/__tests__/fetch_actions.enrich.test.ts`

**Interfaces:**
- Consumes: `resolveAllowedFacetFilters` (`@/utils/facet_guard`), `nearestDistanceMeters` (add a server util or reuse the shared geo helper), the extended `resolveItemNames` (now also selecting `items.item_locations`).
- Produces: when `facets?.length` or `sort==='distance'`, the handler loads all rows matching the SQL WHERE (bounded), enriches with counterparty `item_state`/`item_locations`, applies facet filters + computes `distance_m`, re-sorts, paginates in memory; `meta.total` = filtered length. Always attaches page-sized `distance_m` for display.

- [ ] **Step 1: Extend `resolveItemNames` to also return locations + state**

In the `resolveItemNames` `db.select({...})` (lines ~318-328) add `item_locations: items.item_locations`. Extend the returned `ResolvedName` map (or a parallel map) so the handler can read each item's `item_state` and `item_locations` by id. Keep the existing name-masking behaviour untouched.

- [ ] **Step 2: Write the failing test**

```ts
// Assert: with facets=[{field:'looking_for',values:['maths']}], only rows whose
// counterparty item_state.looking_for intersects ['maths'] are returned, and a
// private/undeclared facet field is dropped (not applied). With sort='distance',
// rows are ordered by computed distance asc, nulls last. Mock the items load to
// return item_state + item_locations per id.
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/fetch_actions.enrich.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the enriched path**

Branch after building `conditions`: if `facets?.length` or `sort === 'distance'`, load ALL matching rows (no limit), resolve counterparty item_state/locations, then:

```ts
  // Counterparty side depends on ownership: received → source item is the
  // counterparty; initiated → target item is.
  const counterpartyId = (row) =>
    row.target_item_owner === userId ? row.source_item_id : row.target_item_id;
  const myId = (row) =>
    row.target_item_owner === userId ? row.target_item_id : row.source_item_id;

  // facet_guard: keep only declared, non-private fields for the counterparty
  // item's schema; drop everything else server-side.
  const allowed = resolveAllowedFacetFilters(counterpartySchema, facets ?? []);
  let enriched = allRows.filter((row) =>
    allowed.every(({ field, values }) => {
      const state = stateById.get(counterpartyId(row)) ?? {};
      const v = state[field];
      const arr = Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
      return arr.some((x) => values.includes(x));
    }),
  );

  const distanceOf = (row) => {
    const a = locById.get(myId(row)); const b = locById.get(counterpartyId(row));
    if (!a?.length || !b?.length) return null;
    return nearestDistanceMeters(a, b); // min pairwise
  };
  const withDist = enriched.map((row) => ({ row, distance_m: distanceOf(row) }));

  if (sort === 'distance') {
    withDist.sort((x, y) =>
      x.distance_m == null ? 1 : y.distance_m == null ? -1 : x.distance_m - y.distance_m);
  }
  const total = withDist.length;
  const page = withDist.slice(offset, offset + limit);
```

Map `page` to response rows carrying `distance_m` and `match_score`. In the **fast path**, still compute page-sized `distance_m` for display from the already-loaded locations.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/fetch_actions.enrich.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the no-PII-leak assertion test**

Add a test: a `facets` request naming a `private:true` field returns rows unfiltered by it (the field is dropped by `resolveAllowedFacetFilters`) and no PII value appears in the response. Run it; expect PASS.

- [ ] **Step 7: Full API run + commit**

Run: `pnpm --filter api test` then `pnpm typecheck`
Expected: PASS.

```bash
git add apps/api/src/routes/v1/action/fetch_actions.ts apps/api/src/routes/v1/action/__tests__/fetch_actions.enrich.test.ts
git commit -m "feat(api): live facet filter + distance sort for my-actions fetch (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 5 — UI shell

### Task 8: Extend the action API client + query keys

**Files:**
- Modify: `apps/ui/src/lib/action-api.ts`
- Modify: `apps/ui/src/lib/query-keys.ts`

**Interfaces:**
- Produces: `FetchMyActionsQuery` gains `sort?`, `facets?: {field:string;values:string[]}[]`, `action_status?: string[]`, `action_type?: string[]`; `Action` gains `match_score?: number | null`, `distance_m?: number | null`. `queryKeys.actions.list(filters)` includes the new fields.

- [ ] **Step 1: Extend the types**

In `action-api.ts`, add to `FetchMyActionsQuery`:

```ts
  sort?: 'recent' | 'oldest' | 'match_score' | 'distance';
  facets?: Array<{ field: string; values: string[] }>;
  action_status?: string | string[];
  action_type?: string | string[];
```

Add to `Action`:

```ts
  match_score?: number | null;
  distance_m?: number | null;
```

In `fetchMyActions`, serialize arrays as repeated params and `facets` as JSON (matching how discover sends `filters`). Keep `item_id` forwarding as-is.

- [ ] **Step 2: Update the query key**

In `query-keys.ts`, ensure `actions.list` keys on the full query object (it already does per the caching doc). If it destructures specific fields, add `sort`, `facets`, `item_id`, `action_status`.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add apps/ui/src/lib/action-api.ts apps/ui/src/lib/query-keys.ts
git commit -m "feat(ui): action-api types for sort/facets/score/distance + cache keys (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 9: Per-profile scoping + PageShell + infinite query

**Files:**
- Modify: `apps/ui/src/pages/my-actions-page.tsx`
- Modify: `apps/ui/src/hooks/use-actions.ts`
- Test: `apps/ui/src/hooks/__tests__/use-actions.test.tsx`

**Interfaces:**
- Consumes: `useMyItems`, `useActiveProfile`, `PageShell`, extended `FetchMyActionsQuery`.
- Produces: `useReceivedActions(itemId, params)` / `useInitiatedActions(itemId, params)` returning an infinite query; the page passes the selected live profile's `item_id` and filter/sort state.

- [ ] **Step 1: Write the failing hook test**

```tsx
// Assert useActions forwards item_id + sort + action_status into the query passed
// to fetchMyActions (mock fetchMyActions; render the hook with a QueryClientProvider).
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-actions.test.tsx`

- [ ] **Step 3: Update `use-actions.ts`**

Change `useActions(role)` to `useActions(role, { itemId, status, type, sort, facets, ... })`, build the query with those fields (drop the hardcoded `limit:100`), and convert the received/initiated hooks to `useInfiniteQuery` with `getNextPageParam` advancing `offset` by `limit` until `offset+limit >= meta.total`. Keep the 60s `refetchInterval` on the first page.

- [ ] **Step 4: Run test — expect PASS.**

- [ ] **Step 5: Wrap the page in PageShell + wire selection**

In `my-actions-page.tsx`:

```tsx
const { data: myItems = [] } = useMyItems(network);
const liveItems = myItems.filter((i) => i.lifecycle_status === 'live');
const { activeProfileId, setActiveProfile } = useActiveProfile(network, myItems);
// scope locally to a live profile without clobbering the shared store:
const scopedId = liveItems.some((i) => i.item_id === activeProfileId)
  ? activeProfileId
  : liveItems[0]?.item_id ?? null;
```

Render inside `<PageShell variant="form" title={t('actions.title')} myItems={liveItems} activeProfileId={scopedId} onActiveProfileChange={setActiveProfile} ...>`; pass `scopedId` as `itemId` into the hooks. Sync `?profile=<scopedId>` and the filter/sort state to the URL (use `useSearchParams`), reading `?profile` on mount (fallback to the shared store).

- [ ] **Step 6: Manual smoke + commit**

Run the UI (`pnpm dev:ui` with the stack up), switch profiles, confirm the list re-scopes and the URL updates.

```bash
git add apps/ui/src/pages/my-actions-page.tsx apps/ui/src/hooks/use-actions.ts apps/ui/src/hooks/__tests__/use-actions.test.tsx
git commit -m "feat(ui): per-profile scoping (PageShell + active-profile) + infinite actions query (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 6 — UI controls

### Task 10: Action toolbar (status chips + sort menu + filters button + tokens)

**Files:**
- Create: `apps/ui/src/components/actions/action-toolbar.tsx`
- Test: `apps/ui/src/components/actions/__tests__/action-toolbar.test.tsx`

**Interfaces:**
- Produces: `<ActionToolbar status sort activeFacets onStatusChange onSortChange onOpenFilters onRemoveFacet onClearFilters />`. Sort options: Match score / Newest / Oldest / Distance. Presentational only.

- [ ] **Step 1: Write a failing test** — render with `sort='match_score'`, click "Newest", assert `onSortChange('recent')`; render one active facet token, click ✕, assert `onRemoveFacet` called.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the toolbar matching the prototype (status chip group, a `DropdownMenu` for sort, a Filters button showing the active count, and removable facet tokens with "Clear all"). Use `t()` for all labels.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/components/actions/action-toolbar.tsx apps/ui/src/components/actions/__tests__/action-toolbar.test.tsx
git commit -m "feat(ui): my-actions toolbar (status chips, sort menu, filter tokens) (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 11: Filters slide-over (schema-driven facets)

**Files:**
- Create: `apps/ui/src/components/actions/action-filters-sheet.tsx`
- Test: `apps/ui/src/components/actions/__tests__/action-filters-sheet.test.tsx`

**Interfaces:**
- Consumes: `getEnumFilterFieldsForDomains` (`@/lib/enum-filters`) over the selected profile's counterparty domain(s); `Sheet` primitive.
- Produces: `<ActionFiltersSheet open domains selected onChange onClose />`; renders Action type + one checkbox group per derived `EnumFilterField`. No distance filter, no PII section.

- [ ] **Step 1: Write a failing test** — pass a fake domain schema with a `looking_for` enum and a `private:true` `phone` field; assert `looking_for` renders as a facet group and `phone` does NOT appear.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** using `getEnumFilterFieldsForDomains(domains)` (which already skips `private:true`); render checkbox groups; toggling calls `onChange(nextSelected)`. Slide-over via `Sheet`; full-height; touch-target rows.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/components/actions/action-filters-sheet.tsx apps/ui/src/components/actions/__tests__/action-filters-sheet.test.tsx
git commit -m "feat(ui): schema-driven filters slide-over for my-actions (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 12: Card additions — match badge, distance, facet chips, "Not scored yet"

**Files:**
- Modify: `apps/ui/src/components/actions/action-card.tsx`
- Test: `apps/ui/src/components/actions/__tests__/action-card.test.tsx`

**Interfaces:**
- Consumes: `MatchScoreBadge` (`@/components/match-score/match-score-badge`), `formatScorePercentage`/`getMatchScoreBand` (`@/utils/match-score-cache`); `Action.match_score`, `Action.distance_m`.
- Produces: card renders a percentage+band badge when `match_score != null`, "Not scored yet" chip when null, a distance line when `distance_m != null`, and non-PII facet chips from the counterparty `item_state`.

- [ ] **Step 1: Write failing tests** — (a) `match_score=8.4` → badge shows a percentage (assert `formatScorePercentage`-style text present); (b) `match_score=null` → "Not scored yet"; (c) `distance_m=3200` → "3.2 km".
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — feed the stored `match_score` to `MatchScoreBadge` (it normalizes `/10` → %); render the null and distance cases; add facet chips. Keep name masking untouched.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/components/actions/action-card.tsx apps/ui/src/components/actions/__tests__/action-card.test.tsx
git commit -m "feat(ui): action card match badge (%), distance, facet chips, not-scored state (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 13: Action list — infinite scroll, drop client filter, keep empty state

**Files:**
- Modify: `apps/ui/src/components/actions/action-list.tsx`
- Test: `apps/ui/src/components/actions/__tests__/action-list.test.tsx`

**Interfaces:**
- Consumes: the infinite-query result (pages of `Action[]`, `fetchNextPage`, `hasNextPage`), the toolbar + sheet.
- Produces: renders the toolbar, flattened pages into the responsive grid, a load-more sentinel/button, the existing per-tab empty state, and preserves bulk-selection.

- [ ] **Step 1: Write a failing test** — with `hasNextPage=true`, clicking "Load more" calls `fetchNextPage`; with zero rows, the "Nothing here yet" empty state renders.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — remove the client-side `FILTER_STATUSES` `useMemo`; flatten `data.pages`; render toolbar + grid + load-more; keep the empty-state and `BulkActionBar` logic.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/components/actions/action-list.tsx apps/ui/src/components/actions/__tests__/action-list.test.tsx
git commit -m "feat(ui): server-driven infinite my-actions list with toolbar + filters (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 14: i18n keys + final verification

**Files:**
- Modify: `apps/ui/src/locales/en.json`, `apps/ui/src/locales/hi.json`

- [ ] **Step 1: Add keys** for every new label (sort options, filter labels, "Not scored yet", distance unit, filters/clear-all, action-type options) under the `actions.*` namespace in `en.json` and `hi.json`.
- [ ] **Step 2: Grep for hardcoded strings** in the new components; replace any with `t()` keys.
Run: `grep -rn ">[A-Z][a-z].*<" apps/ui/src/components/actions/action-toolbar.tsx apps/ui/src/components/actions/action-filters-sheet.tsx`
Expected: no user-facing literal strings (all via `t()`).
- [ ] **Step 3: Full verification.**
Run: `pnpm typecheck` then `pnpm --filter ui exec vitest run src/components/actions src/hooks/__tests__/use-actions.test.tsx` then `pnpm --filter api test`
Expected: all PASS.
- [ ] **Step 4: Manual QA against the prototype** — desktop + mobile: profile switch, tabs, status chips, each sort (score sinks nulls, distance orders), filters sheet facets + tokens + clear, masked names on pending, "Not scored yet", load-more, mobile drawer.
- [ ] **Step 5: Commit.**

```bash
git add apps/ui/src/locales/en.json apps/ui/src/locales/hi.json
git commit -m "feat(ui): i18n keys for my-actions filter/sort (#439)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- D0 per-profile scoping → Task 9. D1 both tabs → Tasks 9/13. D2 match score → Tasks 1-4, 12. D3 server-side + backward-compat → Tasks 5-7. D4 facets (schema-driven) → Tasks 7, 11. D5 distance sort-only → Tasks 7, 12. D6 PII dropped → enforced by omission + Task 7 Step 6 test. D7 load-more → Tasks 9, 13. UI layout / prototype → Tasks 9-13. Mobile → Tasks 9/11/13 + manual QA (Task 14). PR-description notes (§12) → carried into the PR, not a code task.

**Placeholder scan:** The two flagged decision points (Task 1 generated-vs-custom migration; Task 6 Step 4 403-vs-fail-closed for `item_id`) are genuine "verify against the codebase" branches with both outcomes specified, not vague TODOs. All logic-bearing steps include concrete code.

**Type consistency:** `match_score`/`distance_m` names match across DB (Task 1), schema (Task 5), API mapping (Tasks 6-7), client `Action` (Task 8), and card (Task 12). `computeActionMatchScore` signature is consistent between Tasks 2, 3, 4. `sort` enum values match between Task 5 (schema), Task 6 (SQL), Task 8 (client), Task 10 (toolbar).

**Note for executor:** Tasks 1, 6, and 3 touch code whose exact local shape (partitioned-table migration style, the existing `fetch_actions` test harness, the `perform_action` test mocks) must be read first — each such step says so explicitly.
