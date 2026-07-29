/**
 * Epic #203 §4.3 (P4 Task 2) — integration test for the markers cross-instance
 * aggregate + its two routes: GET /network/item/markers (aggregate) and
 * POST /network/item/markers_local (peer, guarded).
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * Drives the real route through `app.inject` (only the `markers` plugin is
 * registered, mounted at the canonical `/api/v1/network` prefix — the other
 * network sub-routes are not needed for this suite). Because the served
 * network's single configured instance for this domain resolves to
 * `getCurrentApiBaseUrl()`, `fetchMarkersAcrossInstances` takes the local path
 * (`fetchLocalMarkers` in-process) — no real peer HTTP call is made, and the
 * aggregate is naturally single-instance (`meta.partial === false`).
 *
 * Seeds real rows into the served network/domain's partition (via
 * `resolveBindings()`, matching this deployment's `SERVED_DOMAINS`), scoped to
 * a dedicated `item_type` probe string + a dedicated owner user so the suite
 * never collides with other data in the same partition, and cleans up in
 * afterAll. Skips when POSTGRES_URL / POSTGRES_USER is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyQs from 'fastify-qs';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { resolveBindings } from '../../../__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

// Reference point + offsets, same construction as the geosearch radius suite:
// 1° latitude ≈ 111.32 km, so a pure-latitude offset gives a predictable
// distance independent of longitude scaling.
const LAT = 21.0;
const LNG = 78.0;
const atCenter = { lat: LAT, lng: LNG }; // 0 m
const near = { lat: 21.005, lng: 78.0 }; // ~556 m
const nearer = { lat: 21.003, lng: 78.0 }; // ~334 m
const far = { lat: 21.05, lng: 78.0 }; // ~5566 m

describeIf(
  `markers integration (§4.3)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    let app: FastifyInstance;
    let db: typeof import('@api/db/postgres/drizzle_config').db;
    let itemsTable: typeof import('@dpg/database').items;
    let ensureItemPartition: typeof import('@dpg/database').ensureItemPartition;
    let userTable: typeof import('@api/db/postgres/schema/auth').user;

    let NET: string;
    let DOMAIN: string;
    const TYPE = `markers_probe_${randomUUID().slice(0, 8)}`;
    const OWNER_ID = `markers-suite-user-${randomUUID().slice(0, 8)}`;

    const ids: Record<string, string> = {};

    async function seed(
      key: string,
      locations: Array<{ lat: number; lng: number }>,
    ): Promise<void> {
      const [row] = await db
        .insert(itemsTable)
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
        .returning({ item_id: itemsTable.item_id });
      ids[key] = row.item_id;
    }

    beforeAll(async () => {
      const drizzle_mod = await import('@api/db/postgres/drizzle_config');
      const database_pkg = await import('@dpg/database');
      const auth_mod = await import('@api/db/postgres/schema/auth');
      db = drizzle_mod.db;
      itemsTable = database_pkg.items;
      ensureItemPartition = database_pkg.ensureItemPartition;
      userTable = auth_mod.user;

      const { primary } = await resolveBindings();
      NET = primary.network;
      DOMAIN = primary.domain;

      const { markers } = await import('../markers.js');

      app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(markers, { prefix: '/api/v1/network' });

      await ensureItemPartition(db, NET, DOMAIN);
      await db.insert(userTable).values({ id: OWNER_ID, name: 'Markers Suite' });

      await seed('atCenter', [atCenter]); // 0 m
      await seed('near', [near]); // ~556 m
      await seed('multiOneIn', [far, nearer]); // any-in-range via nearer (~334 m)
      await seed('far', [far]); // ~5566 m
      await seed('noLocations', []); // excluded from radius queries
    });

    afterAll(async () => {
      if (app) await app.close();
      await db
        .delete(itemsTable)
        .where(
          and(eq(itemsTable.item_network, NET), eq(itemsTable.item_type, TYPE)),
        );
      await db.delete(userTable).where(eq(userTable.id, OWNER_ID));
    });

    function query(extra: Record<string, string | number> = {}) {
      const params = new URLSearchParams({
        item_network: NET,
        item_domain: DOMAIN,
        item_type: TYPE,
        item_latitude: String(LAT),
        item_longitude: String(LNG),
        limit: '100',
        offset: '0',
        ...Object.fromEntries(
          Object.entries(extra).map(([k, v]) => [k, String(v)]),
        ),
      });
      return `/api/v1/network/item/markers?${params.toString()}`;
    }

    it('slim payload: only item_id/item_domain/item_instance_url/item_locations, no item_state', async () => {
      const res = await app.inject({ method: 'GET', url: query({ radius_meters: 1000 }) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { markers: Array<Record<string, unknown>> };
      expect(body.markers.length).toBeGreaterThan(0);
      for (const marker of body.markers) {
        expect(Object.keys(marker).sort()).toEqual(
          ['item_domain', 'item_id', 'item_instance_url', 'item_locations'].sort(),
        );
        expect(marker).not.toHaveProperty('item_state');
      }
    });

    it('radius filter: 1000 m includes in-radius items (incl. any-in-range multi-location), excludes far + no-location', async () => {
      const res = await app.inject({ method: 'GET', url: query({ radius_meters: 1000 }) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta: { total: number; limit: number; offset: number; partial: boolean; unavailable_instances: string[] };
        markers: Array<{ item_id: string }>;
      };

      const got = new Set(body.markers.map((m) => m.item_id));
      expect(got.has(ids.atCenter)).toBe(true);
      expect(got.has(ids.near)).toBe(true);
      expect(got.has(ids.multiOneIn)).toBe(true);
      expect(got.has(ids.far)).toBe(false);
      expect(got.has(ids.noLocations)).toBe(false);
      expect(body.markers.length).toBe(3);

      expect(body.meta.total).toBe(3);
      expect(body.meta.limit).toBe(100);
      expect(body.meta.offset).toBe(0);
      expect(body.meta.partial).toBe(false);
      expect(body.meta.unavailable_instances).toEqual([]);
      expect(res.headers['x-network-partial']).toBe('false');
    });

    it('nearest-first ordering within the radius result', async () => {
      const res = await app.inject({ method: 'GET', url: query({ radius_meters: 1000 }) });
      const body = res.json() as { markers: Array<{ item_id: string }> };
      const order = body.markers.map((m) => m.item_id);
      // atCenter (0 m) nearest, then multiOneIn (~334 m via `nearer`), then near (~556 m)
      expect(order.indexOf(ids.atCenter)).toBeLessThan(order.indexOf(ids.multiOneIn));
      expect(order.indexOf(ids.multiOneIn)).toBeLessThan(order.indexOf(ids.near));
    });

    it('10 km radius pulls in the far item too, still excludes no-location', async () => {
      const res = await app.inject({ method: 'GET', url: query({ radius_meters: 10000 }) });
      const body = res.json() as { meta: { total: number }; markers: Array<{ item_id: string }> };
      const got = new Set(body.markers.map((m) => m.item_id));
      expect(got.has(ids.far)).toBe(true);
      expect(got.has(ids.noLocations)).toBe(false);
      expect(body.markers.length).toBe(4);
      expect(body.meta.total).toBe(4);
    });

    it('offset/limit paginate the total result set', async () => {
      const page1 = await app.inject({ method: 'GET', url: query({ radius_meters: 10000, limit: 2, offset: 0 }) });
      const page2 = await app.inject({ method: 'GET', url: query({ radius_meters: 10000, limit: 2, offset: 2 }) });
      const body1 = page1.json() as { meta: { total: number; limit: number; offset: number }; markers: Array<{ item_id: string }> };
      const body2 = page2.json() as { meta: { total: number; limit: number; offset: number }; markers: Array<{ item_id: string }> };

      expect(body1.markers.length).toBe(2);
      expect(body1.meta).toMatchObject({ total: 4, limit: 2, offset: 0 });
      expect(body2.markers.length).toBe(2);
      expect(body2.meta).toMatchObject({ total: 4, limit: 2, offset: 2 });

      const combined = new Set([
        ...body1.markers.map((m) => m.item_id),
        ...body2.markers.map((m) => m.item_id),
      ]);
      expect(combined.size).toBe(4);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────
// #203 map-serverside-search Task 7 — end-to-end multi-select FACET filter,
// through the REAL HTTP querystring layer (not `fetchLocalMarkers` called
// directly, which is what item_fetch_runtime.integration.test.ts's Task 3
// suite already covers). This suite registers `fastify-qs` on its own
// Fastify instance (mirrors `apps/api/src/app.ts`'s real registration,
// which the OTHER describeIf block above does NOT do) so bracket-notation
// repeated query keys — exactly what `apps/ui/src/lib/network-api.ts`'s
// `fetchNetworkMarkers` now emits for a multi-select facet
// (`item_state[field]=A&item_state[field]=B`, `URLSearchParams.append`, not
// `.set`) — are parsed by the real `qs`-backed parser into
// `item_state: { field: string[] }`, validated by `MarkersQuerySchema`, and
// applied by `buildWhereClause`'s `item_state ->> field = ANY(...)` (Task 3).
// Proves the full UI-serialize → server-`= ANY` chain, not just one half of
// it in isolation.
// ─────────────────────────────────────────────────────────────────────────
const FACET_MIN_LAT = 12.9;
const FACET_MIN_LNG = 77.5;
const FACET_MAX_LAT = 13.1;
const FACET_MAX_LNG = 77.7;
const facetIn = { lat: 13.0, lng: 77.6 }; // in box
const facetOut = { lat: 15.0, lng: 79.0 }; // out of box

function findFacetField(schema: Record<string, unknown>): string {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) throw new Error('resolved binding schema has no properties');
  const entry = Object.entries(properties).find(
    ([, def]) => def.filterable === true && def.private !== true,
  );
  if (!entry) {
    throw new Error(
      'no filterable, non-private field found on the resolved binding — expected a Task 1 (#203) marker',
    );
  }
  return entry[0];
}

function findNonFacetField(schema: Record<string, unknown>): string {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) throw new Error('resolved binding schema has no properties');
  const entry = Object.entries(properties).find(
    ([, def]) => def.filterable !== true && def.private !== true,
  );
  if (!entry) throw new Error('no non-filterable, non-private field found on the resolved binding');
  return entry[0];
}

describeIf(
  `markers multi-select facet integration, real querystring (#203 Task 7)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    let app: FastifyInstance;
    let db: typeof import('@api/db/postgres/drizzle_config').db;
    let itemsTable: typeof import('@dpg/database').items;
    let ensureItemPartition: typeof import('@dpg/database').ensureItemPartition;
    let userTable: typeof import('@api/db/postgres/schema/auth').user;

    let NET: string;
    let DOMAIN: string;
    let facetField: string;
    let nonFacetField: string;
    const TYPE = `markers_facet_probe_${randomUUID().slice(0, 8)}`;
    const OWNER_ID = `markers-facet-suite-user-${randomUUID().slice(0, 8)}`;
    const ids: Record<string, string> = {};

    async function seedItem(key: string, loc: { lat: number; lng: number }, facetValue: string): Promise<string> {
      const [row] = await db
        .insert(itemsTable)
        .values({
          item_network: NET,
          item_domain: DOMAIN,
          item_type: TYPE,
          item_instance_url: 'http://localhost:2742',
          item_schema_url: 'http://localhost:2742/schema',
          created_by: OWNER_ID,
          item_locations: [loc],
          item_state: { [facetField]: facetValue },
          lifecycle_status: 'live',
        })
        .returning({ item_id: itemsTable.item_id });
      ids[key] = row.item_id;
      return row.item_id;
    }

    async function seedItemSearch(itemId: string, loc: { lat: number; lng: number }): Promise<void> {
      await db.execute(sql`
        INSERT INTO item_search (item_network, item_domain, item_type, item_id, geo, lifecycle_status)
        VALUES (
          ${NET}, ${DOMAIN}, ${TYPE}, ${itemId},
          ST_GeogFromText(${`MULTIPOINT(${loc.lng} ${loc.lat})`}),
          'live'
        )
      `);
    }

    beforeAll(async () => {
      const drizzle_mod = await import('@api/db/postgres/drizzle_config');
      const database_pkg = await import('@dpg/database');
      const auth_mod = await import('@api/db/postgres/schema/auth');
      db = drizzle_mod.db;
      itemsTable = database_pkg.items;
      ensureItemPartition = database_pkg.ensureItemPartition;
      userTable = auth_mod.user;

      const { primary } = await resolveBindings();
      NET = primary.network;
      DOMAIN = primary.domain;
      facetField = findFacetField(primary.schema);
      nonFacetField = findNonFacetField(primary.schema);

      const { markers } = await import('../markers.js');

      app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      // Mirrors apps/api/src/app.ts's real registration — the production
      // querystring parser that turns repeated bracket keys into arrays.
      await app.register(fastifyQs, {});
      await app.register(markers, { prefix: '/api/v1/network' });

      await ensureItemPartition(db, NET, DOMAIN);
      await db.insert(userTable).values({ id: OWNER_ID, name: 'Markers Facet Suite' });

      const idA = await seedItem('valueA_inBox', facetIn, 'facet-value-a');
      const idB = await seedItem('valueB_inBox', facetIn, 'facet-value-b');
      const idOther = await seedItem('otherValue_inBox', facetIn, 'facet-value-unselected');
      const idOut = await seedItem('valueA_outOfBox', facetOut, 'facet-value-a');

      await seedItemSearch(idA, facetIn);
      await seedItemSearch(idB, facetIn);
      await seedItemSearch(idOther, facetIn);
      await seedItemSearch(idOut, facetOut);
    });

    afterAll(async () => {
      if (app) await app.close();
      await db.delete(itemsTable).where(and(eq(itemsTable.item_network, NET), eq(itemsTable.item_type, TYPE)));
      await db.execute(sql`DELETE FROM item_search WHERE item_network = ${NET} AND item_type = ${TYPE}`);
      await db.delete(userTable).where(eq(userTable.id, OWNER_ID));
    });

    // Builds the query string exactly the way `fetchNetworkMarkers`
    // (`apps/ui/src/lib/network-api.ts`, #203 Task 7) now does for a
    // multi-select facet: `URLSearchParams.append` the SAME bracket key once
    // per selected value, never a single comma-joined `.set(...)`.
    function bboxFacetQuery(field: string, values: string[]): string {
      const params = new URLSearchParams({
        item_network: NET,
        item_domain: DOMAIN,
        item_type: TYPE,
        min_lat: String(FACET_MIN_LAT),
        min_lng: String(FACET_MIN_LNG),
        max_lat: String(FACET_MAX_LAT),
        max_lng: String(FACET_MAX_LNG),
        limit: '100',
        offset: '0',
      });
      for (const v of values) params.append(`item_state[${field}]`, v);
      return `/api/v1/network/item/markers?${params.toString()}`;
    }

    it('a 2-value multi-select facet + bbox returns ONLY items matching ANY of the 2 values, in-box', async () => {
      const res = await app.inject({
        method: 'GET',
        url: bboxFacetQuery(facetField, ['facet-value-a', 'facet-value-b']),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { meta: { total: number }; markers: Array<{ item_id: string }> };

      const got = new Set(body.markers.map((m) => m.item_id));
      expect(got.has(ids.valueA_inBox)).toBe(true);
      expect(got.has(ids.valueB_inBox)).toBe(true);
      expect(got.has(ids.otherValue_inBox)).toBe(false); // in-box but NOT one of the 2 selected values
      expect(got.has(ids.valueA_outOfBox)).toBe(false); // matching value but out of box
      expect(body.markers.length).toBe(2);
      expect(body.meta.total).toBe(2);
    });

    it('a filter on a non-filterable field is silently ignored — bbox result is unnarrowed', async () => {
      // Two values (not one) so this exercises the ARRAY-facet code path —
      // buildWhereClause's security guard only gates the `= ANY(...)` array
      // branch (Task 3); a single scalar item_state value instead takes the
      // pre-#203 `@> jsonb` containment branch, which isn't guarded at all
      // and would (correctly, but irrelevantly to this assertion) exclude
      // every seeded item since none of them set `nonFacetField`.
      const res = await app.inject({
        method: 'GET',
        url: bboxFacetQuery(nonFacetField, ['anything-at-all', 'something-else']),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { meta: { total: number }; markers: Array<{ item_id: string }> };

      const got = new Set(body.markers.map((m) => m.item_id));
      expect(got.has(ids.valueA_inBox)).toBe(true);
      expect(got.has(ids.valueB_inBox)).toBe(true);
      expect(got.has(ids.otherValue_inBox)).toBe(true);
      expect(body.markers.length).toBe(3);
      expect(body.meta.total).toBe(3);
    });
  },
);
