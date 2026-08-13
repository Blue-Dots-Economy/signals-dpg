# Map bbox fallback when `item_search` is unpopulated — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `item_search` has zero rows for a network+domain (no signals-search worker in the environment), the map's bbox markers query falls back to filtering `items.item_locations` directly instead of returning nothing.

**Architecture:** One probe + one branch inside `buildWhereClause`'s bbox branch in `apps/api/src/utils/item_fetch_runtime.ts`. Probe true → existing GiST-gated `item_search.geo` condition, unchanged. Probe false → jsonb lat/lng range check on the item's own `item_locations`. No UI, route, schema, or signals-search changes; counts and markers share `buildWhereClause` so they flip together.

**Tech Stack:** Fastify API workspace (`apps/api`), Drizzle ORM `sql` templates, Vitest integration tests (Testcontainers-free — needs local `docker compose up -d db redis`).

**Spec:** `docs/superpowers/specs/2026-08-06-map-bbox-index-fallback-design.md`

## Global Constraints

- Work happens in the worktree `/Users/srivastha/KKB/Github/Signals-DPG.worktrees/map-bbox-fallback` on branch `feat/map-bbox-index-fallback`. Never commit to `feature`/`develop`.
- The GiST-gated bbox condition for the probe-true path must remain byte-for-byte what it is today (healthy deployments keep the fast path).
- No config flag, no probe caching (spec decision — YAGNI at the <10k-item scale of fallback environments).
- No `// TODO` comments; no `console.log` (repo conventions).
- Integration tests require the repo-root `.env`. The worktree does not have one (gitignored): `cp /Users/srivastha/KKB/Github/Signals-DPG/.env .env` at the worktree root before running them, plus `docker compose up -d db redis` and `pnpm db:init:api`.

---

### Task 1: Probe + fallback branch in `buildWhereClause` (TDD)

**Files:**
- Modify: `apps/api/src/utils/item_fetch_runtime.ts` (bbox branch of `buildWhereClause`, currently the `else if (filters.min_lat !== undefined && ...)` block near line 312; add one helper function directly above `buildWhereClause`)
- Test: `apps/api/src/utils/__tests__/item_fetch_runtime.integration.test.ts` (new top-level `describeIf` block appended at the end of the file)

**Interfaces:**
- Consumes: existing `db` (Drizzle), `items` table object, `sql` template, `ItemFetchFilters` — all already imported in the file.
- Produces: `hasSearchIndexRows(item_network: string, item_domain: string): Promise<boolean>` — module-private helper (not exported); the observable interface is unchanged `fetchLocalMarkers` / `countLocalItems` behavior.

- [ ] **Step 1: Write the failing integration tests**

Append this block at the end of `apps/api/src/utils/__tests__/item_fetch_runtime.integration.test.ts`. It reuses the module-level constants (`MIN_LAT`…`MAX_LNG`, `inA`, `inC`, `outA`, `describeIf`) and imports already present in the file.

```ts
// ── bbox fallback when item_search has no rows for the network+domain ───────
// Spec: docs/superpowers/specs/2026-08-06-map-bbox-index-fallback-design.md.
// When the signals-search worker has never indexed anything for a
// network+domain (local dev, worker-less deploys, fresh data migrations),
// the bbox filter falls back to gating on items.item_locations directly
// instead of silently returning zero markers.
//
// Ordering note: this is a SEPARATE top-level describe that runs AFTER the
// Option B suite above (describes execute in declaration order, and the
// integration config sets fileParallelism: false). That suite deletes every
// item_search row it seeded in its afterAll, so item_search is empty again
// for the resolved network+domain when this block starts; the beforeAll
// below also clears it defensively in case a prior aborted run left rows.
describeIf('fetchLocalMarkers bbox fallback (empty item_search)', () => {
  let NET: string;
  let DOMAIN: string;
  let TYPE: string;
  const OWNER_ID = `map-fallback-owner-${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {};

  async function seedItem(
    key: string,
    locations: Array<{ lat: number; lng: number }>
  ): Promise<string> {
    const [row] = await db
      .insert(items)
      .values({
        item_network: NET,
        item_domain: DOMAIN,
        item_type: TYPE,
        item_instance_url: 'http://localhost:2742',
        item_schema_url: 'http://localhost:2742/schema',
        created_by: OWNER_ID,
        item_locations: locations,
        item_state: {},
        lifecycle_status: 'live',
      })
      .returning({ item_id: items.item_id });
    ids[key] = row.item_id;
    return row.item_id;
  }

  beforeAll(async () => {
    const { primary } = await resolveBindings();
    NET = primary.network;
    DOMAIN = primary.domain;
    TYPE = primary.item_type;

    await ensureItemPartition(db, NET, DOMAIN);
    await db.insert(user).values({ id: OWNER_ID, name: 'Map Fallback Suite' });

    // item_search is a rebuildable read-model (the signals-search sweep
    // re-creates rows from `items` within a cycle), so clearing the resolved
    // network+domain here is safe and guarantees the probe sees "empty"
    // regardless of leftovers from an aborted earlier run.
    await db.execute(
      sql`DELETE FROM item_search WHERE item_network = ${NET} AND item_domain = ${DOMAIN}`
    );

    await seedItem('fbIn', [inA]); // in box
    await seedItem('fbOut', [outA]); // out of box
    await seedItem('fbMultiOneIn', [outA, inC]); // one of two locations in box
  });

  afterAll(async () => {
    await db
      .delete(items)
      .where(and(eq(items.item_network, NET), eq(items.item_type, TYPE)));
    // The index-path test below inserts one item_search row — remove it.
    await db.execute(
      sql`DELETE FROM item_search WHERE item_network = ${NET} AND item_domain = ${DOMAIN}`
    );
    await db.delete(user).where(eq(user.id, OWNER_ID));
  });

  function bboxFilters() {
    return {
      item_network: NET,
      item_domain: DOMAIN,
      item_type: TYPE,
      limit: 100,
      offset: 0,
      lifecycle_filter: 'live_only' as const,
      min_lat: MIN_LAT,
      min_lng: MIN_LNG,
      max_lat: MAX_LAT,
      max_lng: MAX_LNG,
    };
  }

  it('empty item_search: falls back to item_locations — in-box items (incl. any-location-in-box) returned, out-of-box excluded, meta.total matches', async () => {
    const res = await fetchLocalMarkers(bboxFilters());
    const got = new Set(res.markers.map((m) => m.item_id));
    expect(got.has(ids.fbIn)).toBe(true);
    expect(got.has(ids.fbMultiOneIn)).toBe(true);
    expect(got.has(ids.fbOut)).toBe(false);
    expect(res.meta.total).toBe(2);
  });

  it('empty item_search: degenerate (inverted) box still returns empty, not an error', async () => {
    const res = await fetchLocalMarkers({
      ...bboxFilters(),
      min_lat: MAX_LAT,
      max_lat: MIN_LAT,
    });
    expect(res.markers).toHaveLength(0);
    expect(res.meta.total).toBe(0);
  });

  // MUST run last in this describe: it makes item_search non-empty for the
  // domain, flipping every later bbox call back to the index-gated path.
  it('one item_search row for the domain flips bbox back to the index-gated path', async () => {
    await db.execute(sql`
      INSERT INTO item_search (item_network, item_domain, item_type, item_id, geo, lifecycle_status)
      VALUES (
        ${NET}, ${DOMAIN}, ${TYPE}, ${ids.fbIn},
        ST_GeogFromText(${`MULTIPOINT(${inA.lng} ${inA.lat})`}),
        'live'
      )
    `);
    const res = await fetchLocalMarkers(bboxFilters());
    const got = new Set(res.markers.map((m) => m.item_id));
    // fbIn is indexed and in-box → returned by the index path.
    expect(got.has(ids.fbIn)).toBe(true);
    // fbMultiOneIn has an in-box location but NO item_search row: with the
    // probe now true, the index governs again and it is excluded — proving
    // the switch is empty-vs-not-empty, not per-item.
    expect(got.has(ids.fbMultiOneIn)).toBe(false);
    expect(res.meta.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail for the right reason**

From the worktree root (`.env` copied, `docker compose up -d db redis` and `pnpm db:init:api` done — see Global Constraints):

```bash
pnpm --filter api exec vitest run src/utils/__tests__/item_fetch_runtime.integration.test.ts --config vitest.integration.config.ts -t 'fallback'
```

Expected: the **first test FAILS** (`got.has(ids.fbIn)` is `false` — today's bbox `EXISTS` against an empty `item_search` matches nothing, so the map-empty bug reproduces). The degenerate-box test and the flip-back test PASS even before the change (they assert behavior that already holds); they are regression guards, not the red bar. The pre-existing Option B describe must still pass untouched.

- [ ] **Step 3: Implement the probe and the fallback branch**

In `apps/api/src/utils/item_fetch_runtime.ts`, add this helper directly above `buildWhereClause`:

```ts
/**
 * Map bbox fallback (spec 2026-08-06-map-bbox-index-fallback-design): whether
 * the signals-search ingestion worker has ever indexed anything for this
 * network+domain. `item_search` is maintained ONLY by that worker; in
 * environments without it (local dev, worker-less deploys, fresh data
 * migrations) the table is empty and the bbox branch below would otherwise
 * exclude every item. Index-only probe on the leading PK columns —
 * sub-millisecond — so it runs per call with no cache and no config knob.
 * Deliberately empty-vs-not-empty, not per-item: one indexed row means "a
 * worker exists, trust the index" (its ~60s reconciliation sweep is the
 * recovery path for partial lag).
 */
async function hasSearchIndexRows(
  item_network: string,
  item_domain: string
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM item_search
      WHERE item_network = ${item_network} AND item_domain = ${item_domain}
    ) AS has_rows
  `);
  const rows =
    (result as unknown as { rows?: Array<{ has_rows: boolean }> }).rows ?? [];
  return rows[0]?.has_rows === true;
}
```

Then, inside the bbox `else if` branch of `buildWhereClause` (near line 312), keep the degenerate-box guard first, and wrap the existing GiST condition in the probe. The existing multi-line comment about `&&`/`ST_Intersects` and the GiST `EXISTS` SQL stay exactly as they are — only the surrounding `if/else` changes:

```ts
    if (filters.min_lat >= filters.max_lat || filters.min_lng >= filters.max_lng) {
      // Inverted/degenerate box (e.g. swapped corners): defined as an empty
      // result rather than an error, so a malformed viewport never 500s —
      // it just shows no markers. Checked before the index probe so a
      // malformed viewport never costs a query.
      conditions.push(sql`false`);
    } else if (await hasSearchIndexRows(filters.item_network, filters.item_domain)) {
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM item_search s
            WHERE s.item_network = ${items.item_network} AND s.item_id = ${items.item_id}
              AND s.lifecycle_status = 'live'
              AND s.geo && ST_MakeEnvelope(${filters.min_lng}, ${filters.min_lat}, ${filters.max_lng}, ${filters.max_lat}, 4326)::geography
              AND ST_Intersects(s.geo, ST_MakeEnvelope(${filters.min_lng}, ${filters.min_lat}, ${filters.max_lng}, ${filters.max_lat}, 4326)::geography)
          )
        `
      );
    } else {
      // Fallback: item_search has NEVER been populated for this
      // network+domain (see hasSearchIndexRows above), so gate on the item's
      // own item_locations. A bbox on lat/lng is a pure numeric range check —
      // same "any location inside the box" semantics as the ST_Intersects
      // recheck, computed without the read-model. Fine at the <10k-item
      // scale of worker-less environments; the moment the worker indexes its
      // first row for the domain, the probe flips and the GiST path above
      // takes over with no restart.
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(${items.item_locations}) loc
            WHERE (loc->>'lat')::float8 BETWEEN ${filters.min_lat} AND ${filters.max_lat}
              AND (loc->>'lng')::float8 BETWEEN ${filters.min_lng} AND ${filters.max_lng}
          )
        `
      );
    }
```

Note: the existing GiST comment block (lines ~318-332, "#203 Task 3 — bbox viewport search (Option B)...") remains above this `if/else` chain, where it already sits.

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
pnpm --filter api exec vitest run src/utils/__tests__/item_fetch_runtime.integration.test.ts --config vitest.integration.config.ts
```

Expected: ALL tests in the file pass — the new fallback describe (3 tests) AND the pre-existing Option B describe (whose `notIndexed` exclusion test still passes because its domain's `item_search` is non-empty at that point, so the probe stays true).

- [ ] **Step 5: Typecheck and unit tests (regression)**

```bash
pnpm --filter api exec tsc --noEmit
pnpm --filter api test
```

Expected: typecheck clean; 620 unit tests pass (baseline count — none of them touch this branch, so no change).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/item_fetch_runtime.ts apps/api/src/utils/__tests__/item_fetch_runtime.integration.test.ts
git commit -m "feat(map): fall back to item_locations bbox filter when item_search is unpopulated

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Align the coupling documentation with the new behavior

**Files:**
- Modify: `apps/api/src/utils/__tests__/item_fetch_runtime.integration.test.ts` (file-header comment, lines ~32-39)
- Modify: `apps/api/src/utils/item_fetch_runtime.ts` (the `ItemFetchFilters` bbox-fields doc comment, near line 60)
- Modify: `CLAUDE.md` (repo root — the "Discover / markers (search BFF)" bullet)

**Interfaces:**
- Consumes: Task 1's merged behavior (probe + fallback).
- Produces: documentation only — no code interface changes.

- [ ] **Step 1: Update the integration test file-header comment**

The header currently ends its `item_search` paragraph with:

```
 * un-indexed (no item_search row) to characterize that coupling: an item
 * with a real in-box location but no item_search row is excluded from bbox
 * results.
```

Replace those lines with:

```
 * un-indexed (no item_search row) to characterize that coupling: an item
 * with a real in-box location but no item_search row is excluded from bbox
 * results — as long as item_search has at least one row for the
 * network+domain. When it has none (no worker in the environment), the
 * fallback describe at the end of this file applies: the bbox gates on
 * items.item_locations directly (spec
 * docs/superpowers/specs/2026-08-06-map-bbox-index-fallback-design.md).
```

- [ ] **Step 2: Update the bbox fields doc on `ItemFetchFilters`**

In `item_fetch_runtime.ts`, the bbox fields comment currently reads (near line 60):

```ts
  // Bounding-box viewport search (#203 Task 2 schema, Task 3 SQL), mutually
```

Extend that comment block (keep its existing text, append one sentence at its end, before the fields):

```ts
  // Bbox filtering gates on the item_search read-model when it has rows for
  // the network+domain, and falls back to items.item_locations when it has
  // none — see hasSearchIndexRows below.
```

(Adjust placement to wherever that comment block ends; the intent is one appended sentence, not a rewrite.)

- [ ] **Step 3: Update root `CLAUDE.md`'s markers bullet**

In the "Discover / markers (search BFF)" bullet, after the sentence "`/markers` serves the map viewport.", append:

```
When `item_search` has no rows for the network+domain (no signals-search worker in the environment), the bbox filter falls back to `items.item_locations` automatically and self-heals once the worker indexes its first row.
```

- [ ] **Step 4: Verify nothing broke**

```bash
pnpm --filter api exec tsc --noEmit
pnpm --filter api exec vitest run src/utils/__tests__/item_fetch_runtime.integration.test.ts --config vitest.integration.config.ts
```

Expected: typecheck clean, full integration file passes (comment-only changes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils/item_fetch_runtime.ts apps/api/src/utils/__tests__/item_fetch_runtime.integration.test.ts CLAUDE.md
git commit -m "docs(map): document the item_search bbox fallback coupling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
