/**
 * #203 (P-follow-1) — facet indexes on `items.item_state`.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * Verifies the `apps/api/drizzle/0007_facet_item_state_indexes.sql` custom
 * migration (expression btree indexes on declared `filterable` facet paths,
 * e.g. `(item_state->>'gender')`) makes a partition-pruned facet filter query
 * use an index scan rather than a sequential scan, at a scale (several
 * thousand rows in one leaf partition) where the seq-scan cost would
 * otherwise dominate.
 *
 * Deliberately NOT a GIN-on-the-whole-column test: a jsonb GIN index (either
 * opclass) only accelerates the `@>`/`?`/`?|`/`?&` operators, never the
 * `item_state->>'field' = ...` text-extraction-equality pattern the
 * map/list facet filters use (Task 3 of the map-serverside-search plan uses
 * exactly `item_state->>'field' = ANY($1)`). Confirmed empirically against
 * this same Postgres image before writing this migration: a plain GIN on
 * item_state left the `->>'gender' = 'Male'` query on a Seq Scan; only an
 * expression btree on `(item_state->>'gender')` flips it to a Bitmap Index
 * Scan. So this test targets the `->>` pattern, matching what the migration
 * actually needs to accelerate — not the unrelated `item_state @> {...}`
 * containment filter already supported by the pre-existing `items_state_gin_idx`
 * (see `buildWhereClause` in `../item_fetch_runtime.ts`).
 *
 * RED before the migration existed (verified manually while building this
 * test): with `items_item_state_gender_idx` dropped, the same EXPLAIN below
 * reports a top-level `Seq Scan` and no Index/Bitmap-Index-Scan node
 * referencing `gender` — this test fails against that state. GREEN once the
 * migration's index is present (the state this file asserts).
 *
 * Self-contained: seeds a dedicated `facet_index_verify_net` partition (bulk
 * SQL insert, not one-row-at-a-time, to reach a scale where the planner's
 * cost model actually prefers the index) and deletes it in afterAll. Skips
 * when POSTGRES_URL / POSTGRES_USER is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items, ensureItemPartition } from '@dpg/database';
import { user } from '@api/db/postgres/schema';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

// Dedicated, isolated partition so we never touch real network data, and so
// the leaf partition's row count/selectivity is fully controlled by this
// suite (matters for a cost-based EXPLAIN assertion).
const NET = 'facet_index_verify_net';
const DOMAIN = 'facet_probe_domain';
const TYPE = 'facet_probe';
const OWNER_ID = 'facet-index-verify-suite-user';

// Enough rows, and a selective-enough facet value, that the Postgres planner
// prefers an index over a seq scan when one is available: 6000 rows in the
// leaf partition, 'Male' on ~2% of them (every 50th row).
const ROW_COUNT = 6000;
const MALE_EVERY_NTH = 50;

type PlanNode = {
  'Node Type'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Recheck Cond'?: string;
  Plans?: PlanNode[];
};

function collectPlanNodes(node: PlanNode, acc: PlanNode[] = []): PlanNode[] {
  acc.push(node);
  for (const child of node.Plans ?? []) {
    collectPlanNodes(child, acc);
  }
  return acc;
}

function extractRows<T>(result: unknown): T[] {
  return Array.isArray(result)
    ? (result as T[])
    : ((result as { rows?: T[] }).rows ?? []);
}

async function explainGenderFilter(): Promise<PlanNode> {
  const result = await db.execute<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
    sql`
      EXPLAIN (FORMAT JSON)
      SELECT item_id FROM items
      WHERE item_network = ${NET}
        AND item_domain = ${DOMAIN}
        AND item_state ->> 'gender' = 'Male'
    `
  );
  const rows = extractRows<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(result);
  return rows[0]['QUERY PLAN'][0].Plan;
}

describeIf(
  `facet index on item_state->>'gender' (#203 P-follow-1)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    beforeAll(async () => {
      await ensureItemPartition(db, NET, DOMAIN);
      await db.delete(items).where(eq(items.item_network, NET));
      await db
        .insert(user)
        .values({ id: OWNER_ID, name: 'Facet Index Verify Suite' })
        .onConflictDoNothing();

      // Bulk-seed via generate_series — a per-row insert() loop for 6000 rows
      // would make this suite unreasonably slow and isn't the point being
      // tested (the point is index usage, not the insert path).
      await db.execute(sql`
        INSERT INTO items (
          item_network, item_domain, item_type,
          item_instance_url, item_schema_url, created_by,
          item_state, lifecycle_status
        )
        SELECT
          ${NET}, ${DOMAIN}, ${TYPE},
          'http://localhost:2742', 'http://localhost:2742/schema', ${OWNER_ID},
          jsonb_build_object(
            'gender', CASE WHEN n % ${MALE_EVERY_NTH} = 0 THEN 'Male' ELSE 'Female' END,
            'probe_index', n
          ),
          'live'
        FROM generate_series(1, ${ROW_COUNT}) n
      `);

      // Without an explicit ANALYZE, the planner's row-count/selectivity
      // estimates for this freshly-bulk-inserted partition depend on
      // whatever autovacuum happened to have run by the time this test
      // executes — nondeterministic depending on suite ordering/timing.
      // Force fresh stats so the index-vs-seq-scan choice below is
      // deterministic.
      await db.execute(sql`ANALYZE items`);
    });

    afterAll(async () => {
      await db.delete(items).where(eq(items.item_network, NET));
      await db.delete(user).where(eq(user.id, OWNER_ID));
    });

    it('seeds the expected row + Male counts', async () => {
      const [{ count }] = extractRows<{ count: string }>(
        await db.execute(sql`
          SELECT count(*) FROM items
          WHERE item_network = ${NET} AND item_domain = ${DOMAIN}
        `)
      );
      expect(Number(count)).toBe(ROW_COUNT);

      const [{ count: maleCount }] = extractRows<{ count: string }>(
        await db.execute(sql`
          SELECT count(*) FROM items
          WHERE item_network = ${NET} AND item_domain = ${DOMAIN}
            AND item_state ->> 'gender' = 'Male'
        `)
      );
      expect(Number(maleCount)).toBe(Math.floor(ROW_COUNT / MALE_EVERY_NTH));
    });

    it('uses an index scan (not a seq scan) for a partition-pruned gender facet filter', async () => {
      const plan = await explainGenderFilter();
      const nodes = collectPlanNodes(plan);

      const seqScans = nodes.filter((n) => n['Node Type'] === 'Seq Scan');
      expect(seqScans).toEqual([]);

      // Only `Index Cond` / `Recheck Cond` prove the gender condition itself
      // drove index access; a `Filter` on an unrelated index scan (e.g. the
      // network+domain partition-pruning index) would still mention
      // 'gender' as a post-scan residual check without the facet index ever
      // being used — that must NOT count as a pass.
      const genderIndexNodes = nodes.filter(
        (n) =>
          (n['Node Type'] === 'Index Scan' || n['Node Type'] === 'Bitmap Index Scan') &&
          [n['Index Cond'], n['Recheck Cond']].some(
            (cond) => typeof cond === 'string' && cond.includes('gender')
          )
      );
      expect(genderIndexNodes.length).toBeGreaterThan(0);
    });
  }
);
