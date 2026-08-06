/**
 * #203 (map-serverside-search plan, Task 3) — `fetchLocalMarkers` bbox filter
 * (Option B: join `item_search.geo`) + `item_state` facet filters + truthful
 * `meta.total`.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * Uses `resolveBindings()` (the same helper `routes/v1/**` integration suites
 * use) to find the actually-served network/domain rather than hardcoding
 * "blue_dot" — but then reads that domain's real JSON-schema `properties` to
 * find a genuine declared+non-private facet field and a genuine
 * `private: true` field, so the security-guard assertions exercise the real
 * network.json markers (`examples/schemas/blue_dot/network.json`'s `gender` /
 * `name`) rather than a fabricated schema. Seeds a dedicated `item_type`
 * probe string + owner so this suite never collides with other data in the
 * same partition; cleans up in afterAll. Skips when POSTGRES_URL /
 * POSTGRES_USER is unset.
 *
 * #394: the `filterable: true` network.json marker (and the guard's
 * additional requirement of it) has been removed — `resolveAllowedFacetFields`
 * (`../item_fetch_runtime.ts`) now allows every declared, non-private field.
 * This suite's "filterable" field and its "second, also-declared,
 * non-private" field therefore behave IDENTICALLY (both applied); only the
 * `private: true` field remains guarded. See #360 for the proper long-term
 * schema-driven search/filter declaration.
 *
 * `item_search` rows (the Option B join target) are seeded directly via raw
 * SQL — in production these come from the signals-search ingestion pipeline,
 * which this suite deliberately does not depend on (Option B's documented
 * coupling, see the plan's issue #1). One item is deliberately left
 * un-indexed (no item_search row) to characterize that coupling: an item
 * with a real in-box location but no item_search row is excluded from bbox
 * results — as long as item_search has at least one row for the
 * network+domain. When it has none (no worker in the environment), the
 * fallback describe at the end of this file applies: the bbox gates on
 * items.item_locations directly (spec
 * docs/superpowers/specs/2026-08-06-map-bbox-index-fallback-design.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@api/db/postgres/drizzle_config';
import { items, ensureItemPartition } from '@dpg/database';
import { user } from '@api/db/postgres/schema';
import { resolveBindings } from '../../routes/v1/__tests__/integration_helpers';
import { fetchLocalMarkers } from '../item_fetch_runtime';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

// bbox under test. 1° latitude ≈ 111.32 km, so these offsets give predictable
// in/out placement independent of longitude scaling (same construction as
// geosearch_radius.integration.test.ts / markers.integration.test.ts).
const MIN_LAT = 24.9;
const MIN_LNG = 79.9;
const MAX_LAT = 25.1;
const MAX_LNG = 80.1;

const inA = { lat: 25.0, lng: 80.0 }; // in box
const inB = { lat: 25.05, lng: 80.02 }; // in box
const inC = { lat: 25.02, lng: 80.01 }; // in box (used as the "in" half of a multi-location item)
const outA = { lat: 26.0, lng: 82.0 }; // out of box
const outB = { lat: 27.0, lng: 83.0 }; // out of box

// #203 review fix: a multi-location item whose two points straddle the box on
// opposite sides — same latitude (inside the box's lat range [MIN_LAT,
// MAX_LAT]), one west of MIN_LNG and one east of MAX_LNG. Neither point is
// individually inside the box, but the MultiPoint's AGGREGATE envelope
// (lng [79.0, 81.0] x lat [25.0, 25.0]) overlaps the query envelope — the
// exact geometry that makes `&&` alone (bounding-box overlap) false-positive.
// Verified directly against Postgres before writing this: `&&` = true,
// `ST_Intersects` = false for this pair against the MIN/MAX box below.
const straddleWest = { lat: 25.0, lng: 79.0 }; // west of the box
const straddleEast = { lat: 25.0, lng: 81.0 }; // east of the box

type PlanNode = {
  'Node Type'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
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

// #394: no `filterable` requirement any more — any declared, non-private,
// >=2-value enum field is a valid facet field now.
function findFacetField(
  schema: Record<string, unknown>
): { field: string; values: [string, string] } {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    throw new Error('resolved binding schema has no properties');
  }
  const entry = Object.entries(properties).find(
    ([, def]) => def.private !== true && Array.isArray(def.enum) && def.enum.length >= 2
  );
  if (!entry) {
    throw new Error(
      'no non-private, >=2-value enum field found on the resolved binding — ' +
        'expected e.g. blue_dot seeker "gender" to be present'
    );
  }
  const [field, def] = entry;
  const enumValues = def.enum as string[];
  return { field, values: [enumValues[0], enumValues[1]] };
}

function findPrivateField(schema: Record<string, unknown>): string {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    throw new Error('resolved binding schema has no properties');
  }
  const entry = Object.entries(properties).find(([, def]) => def.private === true);
  if (!entry) {
    throw new Error('no private field found on the resolved binding');
  }
  return entry[0];
}

// #394: a SECOND declared, non-private, >=2-value enum field, distinct from
// the first — used to prove a field that previously had no `filterable: true`
// marker (e.g. blue_dot seeker "educationCategory") is now ALSO applied by
// the native facet filter, not silently dropped.
function findSecondFacetField(
  schema: Record<string, unknown>,
  excludeField: string
): { field: string; values: [string, string] } {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    throw new Error('resolved binding schema has no properties');
  }
  const entry = Object.entries(properties).find(
    ([field, def]) =>
      field !== excludeField &&
      def.private !== true &&
      Array.isArray(def.enum) &&
      def.enum.length >= 2
  );
  if (!entry) {
    throw new Error(
      'no second non-private, >=2-value enum field (distinct from the first) found on the resolved binding'
    );
  }
  const [field, def] = entry;
  const enumValues = def.enum as string[];
  return { field, values: [enumValues[0], enumValues[1]] };
}

describeIf(
  `fetchLocalMarkers bbox + facet filtering (#203 Task 3)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    let NET: string;
    let DOMAIN: string;
    const TYPE = `map_probe_${randomUUID().slice(0, 8)}`;
    const OWNER_ID = `map-probe-suite-user-${randomUUID().slice(0, 8)}`;

    let facetField: string;
    let facetValueA: string;
    let facetValueB: string;
    let privateField: string;
    // #394: the "second" field is a distinct declared, non-private enum
    // field that never carried a `filterable: true` marker (e.g. blue_dot
    // seeker "educationCategory") — every seeded item gets `secondValueA`
    // except `inB`, which gets `secondValueB`, mirroring the
    // facetField/facetValueA/facetValueB pattern above so a filter on this
    // field can be proven to narrow the bbox result exactly like the first.
    let secondFacetField: string;
    let secondValueA: string;
    let secondValueB: string;

    const ids: Record<string, string> = {};

    async function seedItem(
      key: string,
      locations: Array<{ lat: number; lng: number }>,
      gender: string,
      secondValue: string = secondValueA
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
          item_state: { [facetField]: gender, [secondFacetField]: secondValue },
          lifecycle_status: 'live',
        })
        .returning({ item_id: items.item_id });
      ids[key] = row.item_id;
      return row.item_id;
    }

    // Mirrors production's item_search (Signals search engine) shape for this
    // suite's purposes only — geo is a geography(MultiPoint,4326) built from
    // every location the item has, exactly like the real ingestion pipeline
    // would produce.
    async function seedItemSearch(
      itemId: string,
      locations: Array<{ lat: number; lng: number }>
    ): Promise<void> {
      const multipoint = `MULTIPOINT(${locations
        .map((loc) => `${loc.lng} ${loc.lat}`)
        .join(', ')})`;
      await db.execute(sql`
        INSERT INTO item_search (item_network, item_domain, item_type, item_id, geo, lifecycle_status)
        VALUES (
          ${NET}, ${DOMAIN}, ${TYPE}, ${itemId},
          ST_GeogFromText(${multipoint}),
          'live'
        )
      `);
    }

    // A handful of hand-seeded rows is too small a table for Postgres' cost
    // model to ever prefer an index over a plain scan (same lesson
    // facet_index.integration.test.ts documents for the item_state expression
    // index) — bulk-seed enough scattered noise rows that item_search is
    // large enough for the planner to actually choose item_search_geo_gist
    // for a narrow bbox. Noise rows use a dedicated item_type so they never
    // affect this suite's own result-correctness assertions.
    const NOISE_TYPE = `map_probe_noise_${randomUUID().slice(0, 8)}`;
    const NOISE_ROW_COUNT = 8000;

    beforeAll(async () => {
      const { primary } = await resolveBindings();
      NET = primary.network;
      DOMAIN = primary.domain;

      const found = findFacetField(primary.schema);
      facetField = found.field;
      [facetValueA, facetValueB] = found.values;
      privateField = findPrivateField(primary.schema);
      const foundSecond = findSecondFacetField(primary.schema, facetField);
      secondFacetField = foundSecond.field;
      [secondValueA, secondValueB] = foundSecond.values;

      await ensureItemPartition(db, NET, DOMAIN);
      await db.insert(user).values({ id: OWNER_ID, name: 'Map Probe Suite' });

      const inAId = await seedItem('inA', [inA], facetValueA);
      const inBId = await seedItem('inB', [inB], facetValueB, secondValueB);
      const outAId = await seedItem('outA', [outA], facetValueA);
      const multiOneInId = await seedItem('multiOneIn', [outA, inC], facetValueA);
      const multiBothOutId = await seedItem('multiBothOut', [outA, outB], facetValueA);
      const straddleId = await seedItem(
        'straddle',
        [straddleWest, straddleEast],
        facetValueA
      );
      // notIndexed: real in-box location, but deliberately NO item_search row
      // — characterizes Option B's coupling to search ingestion.
      await seedItem('notIndexed', [inA], facetValueA);

      await seedItemSearch(inAId, [inA]);
      await seedItemSearch(inBId, [inB]);
      await seedItemSearch(outAId, [outA]);
      await seedItemSearch(multiOneInId, [outA, inC]);
      await seedItemSearch(multiBothOutId, [outA, outB]);
      await seedItemSearch(straddleId, [straddleWest, straddleEast]);
      // (notIndexed intentionally gets no item_search row)

      await db.execute(sql`
        INSERT INTO item_search (item_network, item_domain, item_type, item_id, geo, lifecycle_status)
        SELECT
          ${NET}, ${DOMAIN}, ${NOISE_TYPE}, gen_random_uuid(),
          ST_Multi(ST_SetSRID(ST_MakePoint(-180 + random() * 360, -90 + random() * 180), 4326))::geography,
          'live'
        FROM generate_series(1, ${NOISE_ROW_COUNT}) n
      `);
      await db.execute(sql`ANALYZE item_search`);
    });

    afterAll(async () => {
      await db
        .delete(items)
        .where(and(eq(items.item_network, NET), eq(items.item_type, TYPE)));
      await db.execute(
        sql`DELETE FROM item_search WHERE item_network = ${NET} AND item_type = ${TYPE}`
      );
      await db.execute(
        sql`DELETE FROM item_search WHERE item_network = ${NET} AND item_type = ${NOISE_TYPE}`
      );
      await db.delete(user).where(eq(user.id, OWNER_ID));
    });

    // A function (not a plain object) deliberately: NET/DOMAIN are only
    // assigned inside beforeAll, which runs after this describe block's body
    // is evaluated — a plain object literal here would capture `undefined`.
    function baseFilters() {
      return {
        item_network: NET,
        item_domain: DOMAIN,
        item_type: TYPE,
        limit: 100,
        offset: 0,
        lifecycle_filter: 'live_only' as const,
      };
    }

    it('bbox: includes in-box items (incl. any-location-in-box multi-location), excludes out-of-box and un-indexed items', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inA)).toBe(true);
      expect(got.has(ids.inB)).toBe(true);
      expect(got.has(ids.multiOneIn)).toBe(true); // any-location-in-box
      expect(got.has(ids.outA)).toBe(false);
      expect(got.has(ids.multiBothOut)).toBe(false);
      expect(got.has(ids.notIndexed)).toBe(false); // no item_search row
      // straddle: aggregate envelope overlaps the box (`&&` true) but neither
      // individual point is inside — must be excluded (the ST_Intersects
      // recheck, not `&&` alone, is what makes this correct).
      expect(got.has(ids.straddle)).toBe(false);
      expect(res.markers.length).toBe(3);
      expect(res.meta.total).toBe(3);
    });

    it('multi-location false positive: aggregate envelope overlaps the viewport but no individual point is inside -> excluded, not counted', async () => {
      // #203 review fix: `&&` alone (bounding-box overlap) is true for the
      // straddle fixture (its aggregate envelope spans across the box), but
      // neither of its two actual points falls inside — asserting this in
      // isolation (rather than folded only into the broader bbox test above)
      // so the false-positive geometry this bug was about has one test whose
      // name states exactly what it guards against.
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.straddle)).toBe(false);
      expect(res.meta.total).toBe(3); // straddle must not inflate the total either

      // Positive control, same request: a genuine any-location-in-box
      // multi-location item is still returned exactly once.
      expect(res.markers.filter((m) => m.item_id === ids.multiOneIn).length).toBe(1);
    });

    it('meta.total reflects the full in-box count even when limit truncates the page', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        limit: 2,
      });

      expect(res.markers.length).toBe(2);
      expect(res.meta.total).toBe(3);
      expect(res.meta.limit).toBe(2);
    });

    it('facet filter (item_state array value) narrows the bbox result to matching values only', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        item_state: { [facetField]: [facetValueA] },
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inA)).toBe(true); // facetValueA
      expect(got.has(ids.multiOneIn)).toBe(true); // facetValueA
      expect(got.has(ids.inB)).toBe(false); // facetValueB — filtered out
      expect(res.markers.length).toBe(2);
      expect(res.meta.total).toBe(2);
    });

    it('a filter on a private field is IGNORED (security guard) — result is unaffected, not narrowed', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        item_state: { [privateField]: ['anything-at-all'] },
      });

      // Same as the unfiltered bbox result — the private-field filter must
      // have been dropped, not applied (and not have errored the request).
      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inA)).toBe(true);
      expect(got.has(ids.inB)).toBe(true);
      expect(got.has(ids.multiOneIn)).toBe(true);
      expect(res.markers.length).toBe(3);
      expect(res.meta.total).toBe(3);
    });

    it('#394 vuln repro: a SINGLE-VALUE (scalar) filter on a private field is IGNORED, not applied via @> containment', async () => {
      // Pre-fix this used the unguarded `item_state @> {...}::jsonb` branch —
      // ANY scalar value narrowed the result even for a `private: true`
      // field, since only the array-valued facet path checked
      // `resolveAllowedFacetFields`. Same expectation as the array-value
      // private-field test above: unfiltered bbox result (3 items), not
      // narrowed.
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        item_state: { [privateField]: 'anything-at-all' },
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inA)).toBe(true);
      expect(got.has(ids.inB)).toBe(true);
      expect(got.has(ids.multiOneIn)).toBe(true);
      expect(res.markers.length).toBe(3);
      expect(res.meta.total).toBe(3);
    });

    it('a SINGLE-VALUE (scalar) filter on an UNDECLARED field is IGNORED, not applied', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        item_state: { totally_undeclared_field_xyz: 'anything-at-all' },
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inA)).toBe(true);
      expect(got.has(ids.inB)).toBe(true);
      expect(got.has(ids.multiOneIn)).toBe(true);
      expect(res.markers.length).toBe(3);
      expect(res.meta.total).toBe(3);
    });

    it('a SINGLE-VALUE (scalar) filter on a declared, non-private field still narrows results (unified with the array `= ANY` path)', async () => {
      // Same narrowing as the array-value facet-filter test above
      // (`item_state: { [facetField]: [facetValueA] }`), but with a bare
      // scalar value — proves single- and multi-select now share one guarded
      // code path with identical semantics for an allowed field.
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        item_state: { [facetField]: facetValueA },
      });

      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inA)).toBe(true); // facetValueA
      expect(got.has(ids.multiOneIn)).toBe(true); // facetValueA
      expect(got.has(ids.inB)).toBe(false); // facetValueB — filtered out
      expect(res.markers.length).toBe(2);
      expect(res.meta.total).toBe(2);
    });

    it('#394: a filter on a SECOND declared, non-private field (no former filterable marker) is now APPLIED, not ignored', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        min_lat: MIN_LAT,
        min_lng: MIN_LNG,
        max_lat: MAX_LAT,
        max_lng: MAX_LNG,
        item_state: { [secondFacetField]: [secondValueB] },
      });

      // Only `inB` was seeded with `secondValueB` (every other in-box item got
      // `secondValueA`) — a dropped/ignored filter would return all 3 in-box
      // items, same as the unfiltered bbox result above. Narrowing to exactly
      // `inB` proves this field is genuinely applied by `buildWhereClause`'s
      // `= ANY(...)` facet path now that the `filterable: true` gate is gone.
      const got = new Set(res.markers.map((m) => m.item_id));
      expect(got.has(ids.inB)).toBe(true);
      expect(got.has(ids.inA)).toBe(false);
      expect(got.has(ids.multiOneIn)).toBe(false);
      expect(res.markers.length).toBe(1);
      expect(res.meta.total).toBe(1);
    });

    it('an inverted/degenerate bbox yields an empty result (not an error)', async () => {
      const res = await fetchLocalMarkers({
        ...baseFilters(),
        // swapped corners: min > max
        min_lat: MAX_LAT,
        min_lng: MAX_LNG,
        max_lat: MIN_LAT,
        max_lng: MIN_LNG,
      });

      expect(res.markers).toEqual([]);
      expect(res.meta.total).toBe(0);
    });

    it('EXPLAIN: the bbox `&&` predicate against item_search uses item_search_geo_gist, not a seq scan', async () => {
      const result = await db.execute(
        sql`
          EXPLAIN (FORMAT JSON)
          SELECT 1 FROM item_search s
          WHERE s.item_network = ${NET} AND s.item_type = ${TYPE}
            AND s.lifecycle_status = 'live'
            AND s.geo && ST_MakeEnvelope(${MIN_LNG}, ${MIN_LAT}, ${MAX_LNG}, ${MAX_LAT}, 4326)::geography
        `
      );
      const plan = extractRows<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(result)[0][
        'QUERY PLAN'
      ][0].Plan;
      const nodes = collectPlanNodes(plan);

      const seqScansOnItemSearch = nodes.filter(
        (n) => n['Node Type'] === 'Seq Scan'
      );
      expect(seqScansOnItemSearch).toEqual([]);

      const gistNodes = nodes.filter(
        (n) =>
          (n['Node Type'] === 'Index Scan' || n['Node Type'] === 'Bitmap Index Scan') &&
          [n['Index Cond'], n['Index Name']].some(
            (value) => typeof value === 'string' && value.includes('item_search_geo_gist')
          )
      );
      // Index Cond doesn't carry the index name — check either the node's own
      // Index Name, or (for a Bitmap Index Scan feeding a Bitmap Heap Scan)
      // that some node in the plan names the gist index directly.
      const namesGistIndex = nodes.some((n) => n['Index Name'] === 'item_search_geo_gist');
      expect(namesGistIndex || gistNodes.length > 0).toBe(true);
    });
  }
);

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
