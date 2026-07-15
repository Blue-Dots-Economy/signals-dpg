/**
 * §4.0 (epic #203) — prerequisite: VERIFY the existing geosearch radius filter.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * This is a characterization test of the CURRENT `buildWhereClause` geo filter
 * in `item_fetch_runtime.ts` (earth_box @> ll_to_earth AND earth_distance <=
 * radius, EXISTS over jsonb item_locations). It must PASS against today's code
 * before §4.1 (distance ordering) / §4.2 (relaxed refinement) build on it.
 *
 * Asserts (spec §4.0):
 *   1. radius filter correctness — in-radius included, out-of-radius excluded;
 *   2. multi-location items included iff ANY location is within range;
 *   3. items with no locations are excluded from a radius query.
 *
 * (Distance-ordering correctness — §4.0 point 2 — is added with §4.1's TDD,
 * since ordering is not implemented yet; this suite verifies the filter only.)
 *
 * Self-contained: seeds a dedicated `geo_verify_net` partition + probe rows and
 * deletes them in afterAll. Skips when POSTGRES_URL / POSTGRES_USER is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items, ensureItemPartition } from '@dpg/database';
import { user } from '@api/db/postgres/schema';
import { fetchLocalItems, countLocalItems } from '../item_fetch_runtime';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

// Dedicated, isolated partition so we never touch real network data.
const NET = 'geo_verify_net';
const DOMAIN = 'geo';
const TYPE = 'geo_probe';
// created_by has an FK to "user"; seed a dedicated owner row and clean it up.
const OWNER_ID = 'geo-verify-suite-user';

// Reference point + offsets. 1° latitude ≈ 111.32 km, so a pure-latitude
// offset gives a predictable distance independent of longitude scaling:
//   0.005° ≈ 556 m   (inside a 1000 m radius)
//   0.05°  ≈ 5566 m  (outside 1000 m, inside 10 km)
const LAT = 19.0;
const LNG = 72.0;
const near = { lat: 19.005, lng: 72.0 }; // ~556 m
const nearer = { lat: 19.003, lng: 72.0 }; // ~334 m
const far = { lat: 19.05, lng: 72.0 }; // ~5566 m
const far2 = { lat: 19.06, lng: 72.0 }; // ~6679 m

// item_id is uuid defaultRandom; capture the generated ids to assert on.
const ids: Record<string, string> = {};

async function seed(
  key: string,
  locations: Array<{ lat: number; lng: number }>,
): Promise<void> {
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
      lifecycle_status: 'live',
    })
    .returning({ item_id: items.item_id });
  ids[key] = row.item_id;
}

describeIf(
  `geosearch radius filter (§4.0)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    beforeAll(async () => {
      await ensureItemPartition(db, NET, DOMAIN);
      await db.delete(items).where(eq(items.item_network, NET));
      await db
        .insert(user)
        .values({ id: OWNER_ID, name: 'Geo Verify Suite' })
        .onConflictDoNothing();
      await seed('atCenter', [{ lat: LAT, lng: LNG }]); // 0 m
      await seed('near', [near]); // ~556 m
      await seed('far', [far]); // ~5566 m
      await seed('multiOneIn', [far, nearer]); // far + ~334 m → any-in-range
      await seed('multiBothOut', [far, far2]); // both far
      await seed('noLocations', []); // empty locations
    });

    afterAll(async () => {
      await db.delete(items).where(eq(items.item_network, NET));
      await db.delete(user).where(eq(user.id, OWNER_ID));
    });

    const baseFilters = {
      item_network: NET,
      item_domain: DOMAIN,
      item_type: TYPE,
      item_latitude: LAT,
      item_longitude: LNG,
      limit: 100,
      offset: 0,
    };

    it('1000 m radius: includes in-radius (incl. multi-location any-in), excludes out-of-radius and no-location', async () => {
      const res = await fetchLocalItems({ ...baseFilters, radius_meters: 1000 });
      const got = new Set(res.items.map((i) => i.item_id));
      // included
      expect(got.has(ids.atCenter)).toBe(true);
      expect(got.has(ids.near)).toBe(true);
      expect(got.has(ids.multiOneIn)).toBe(true); // §4.0(2): any location in range
      // excluded
      expect(got.has(ids.far)).toBe(false);
      expect(got.has(ids.multiBothOut)).toBe(false);
      expect(got.has(ids.noLocations)).toBe(false);
      expect(res.items.length).toBe(3);
    });

    it('count matches the filtered set (meta.total is truthful)', async () => {
      const count = await countLocalItems({ ...baseFilters, radius_meters: 1000 });
      expect(count).toBe(3);
    });

    it('10 km radius: pulls the ~5.6 km items in too, still excludes no-location', async () => {
      const res = await fetchLocalItems({ ...baseFilters, radius_meters: 10000 });
      const got = new Set(res.items.map((i) => i.item_id));
      expect(got.has(ids.far)).toBe(true);
      expect(got.has(ids.multiBothOut)).toBe(true);
      expect(got.has(ids.noLocations)).toBe(false); // empty locations never match a radius query
      expect(res.items.length).toBe(5);
    });

    it('tight 100 m radius: only the exact-center item matches', async () => {
      const res = await fetchLocalItems({ ...baseFilters, radius_meters: 100 });
      const got = res.items.map((i) => i.item_id);
      expect(got).toEqual([ids.atCenter]);
    });
  },
);
