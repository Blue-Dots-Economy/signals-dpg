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
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
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
