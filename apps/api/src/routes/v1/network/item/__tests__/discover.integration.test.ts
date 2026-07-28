/**
 * Epic #203 List PR (P-follow-3, Task 2) — integration test for the public
 * `POST /network/item/discover` BFF.
 *
 * signals-search cannot be run locally, so `searchSignals` is mocked to
 * return a controlled ranked id list (+ score/distanceMeters/meta); the DB
 * side (item hydration, ordering, lifecycle filtering) and the network-config
 * side (private/undeclared facet guard) are real — this proves the rank-then-
 * hydrate wiring against a real Postgres partition, not just the pure-function
 * unit tests in `facet_guard.test.ts` / `signals_search_client.test.ts`.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * Skips when POSTGRES_URL / POSTGRES_USER is unset, matching the sibling
 * markers.integration.test.ts convention.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const { searchSignalsMock } = vi.hoisted(() => ({
  searchSignalsMock: vi.fn(),
}));

vi.mock('@/services/signals_search_client', () => ({
  searchSignals: searchSignalsMock,
}));

// The real network config (NOT mocked) drives the facet guard here — the
// guard's field resolution runs against `getDomainItemSchema`, the same
// module `resolveBindings` itself uses to find a served network/domain/
// item_type, so mocking it would create a chicken-and-egg problem. Instead
// we resolve real field names to exercise: one private scalar, one public
// array, one public scalar — whatever the served network's schema declares.
let NET: string;
let DOMAIN: string;
let REAL_ITEM_TYPE: string;
let PRIVATE_FIELD: string;
let ARRAY_FIELD: string;
let SCALAR_FIELD: string;
// Random probe item_type for the *seeded rows only* (not for facet-guard
// resolution) — fetchLocalItemsByIds never filters on item_type, only on
// item_network/item_domain/item_ids, so this is purely to give afterAll's
// cleanup delete a safe, collision-free scope (mirrors markers.integration's
// convention) without needing the seeded rows' item_type to match the real
// schema used for facet resolution.
const PROBE_TYPE = `discover_probe_${randomUUID().slice(0, 8)}`;

function pickFacetFields(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const entries = Object.entries(properties);
  const privateField = entries.find(([, p]) => p.private === true)?.[0];
  const arrayField = entries.find(
    ([, p]) => p.type === 'array' && p.private !== true,
  )?.[0];
  const scalarField = entries.find(
    ([, p]) => p.type !== 'array' && p.private !== true,
  )?.[0];

  if (!privateField || !arrayField || !scalarField) {
    throw new Error(
      'discover.integration.test: served network schema lacks the field shapes ' +
        'this suite needs (a private field, a public array field, a public scalar field).',
    );
  }

  return { privateField, arrayField, scalarField };
}

describeIf(
  `discover integration (#203 List PR)${can_run ? '' : ' — SKIPPED (no POSTGRES_URL)'}`,
  () => {
    let app: FastifyInstance;
    let db: typeof import('@api/db/postgres/drizzle_config').db;
    let itemsTable: typeof import('@dpg/database').items;
    let ensureItemPartition: typeof import('@dpg/database').ensureItemPartition;
    let userTable: typeof import('@api/db/postgres/schema/auth').user;

    const OWNER_ID = `discover-suite-user-${randomUUID().slice(0, 8)}`;
    const ids: Record<string, string> = {};

    async function seed(key: string, lifecycle_status: string): Promise<void> {
      const [row] = await db
        .insert(itemsTable)
        .values({
          item_network: NET,
          item_domain: DOMAIN,
          item_type: PROBE_TYPE,
          item_instance_url: 'http://localhost:2742',
          item_schema_url: 'http://localhost:2742/schema',
          created_by: OWNER_ID,
          item_state: { [SCALAR_FIELD]: 'discover-suite-value' },
          lifecycle_status,
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
      REAL_ITEM_TYPE = primary.item_type;
      ({
        privateField: PRIVATE_FIELD,
        arrayField: ARRAY_FIELD,
        scalarField: SCALAR_FIELD,
      } = pickFacetFields(primary.schema));

      const { discover } = await import('../discover.js');

      app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(discover, { prefix: '/api/v1/network' });

      await ensureItemPartition(db, NET, DOMAIN);
      await db.insert(userTable).values({ id: OWNER_ID, name: 'Discover Suite' });

      await seed('first', 'live');
      await seed('second', 'live');
      await seed('paused', 'paused'); // ranked by search, but not live — dropped on hydrate
    });

    afterAll(async () => {
      if (app) await app.close();
      await db
        .delete(itemsTable)
        .where(
          and(eq(itemsTable.item_network, NET), eq(itemsTable.item_type, PROBE_TYPE)),
        );
      await db.delete(userTable).where(eq(userTable.id, OWNER_ID));
    });

    beforeEach(() => {
      searchSignalsMock.mockReset();
    });

    function baseBody(extra: Record<string, unknown> = {}) {
      return {
        item_network: NET,
        item_domain: DOMAIN,
        item_type: REAL_ITEM_TYPE,
        limit: 20,
        offset: 0,
        ...extra,
      };
    }

    it('hydrates full item rows from the local DB in signals-search ranked order, with score/distanceMeters attached', async () => {
      // Ranked order: second (highest score) then first — reverse of insert
      // order, so a pass-through would be caught by this assertion.
      searchSignalsMock.mockResolvedValueOnce({
        items: [
          { item_id: ids.second, score: 0.9, distanceMeters: 100 },
          { item_id: ids.first, score: 0.5, distanceMeters: 200 },
        ],
        meta: { total: 2, limit: 20, offset: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/network/item/discover',
        payload: baseBody(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        meta: { total: number; limit: number; offset: number };
        items: Array<{
          item_id: string;
          item_instance_url: string | null;
          item_state: Record<string, unknown>;
          score?: number;
          distanceMeters?: number;
        }>;
      };

      expect(body.items.map((i) => i.item_id)).toEqual([ids.second, ids.first]);
      expect(body.items[0].score).toBe(0.9);
      expect(body.items[0].distanceMeters).toBe(100);
      expect(body.items[1].score).toBe(0.5);
      expect(body.items[1].distanceMeters).toBe(200);
      // Full native item shape, not a slim projection.
      expect(body.items[0].item_instance_url).toBe('http://localhost:2742');
      expect(body.items[0].item_state).toEqual({
        [SCALAR_FIELD]: 'discover-suite-value',
      });
      expect(body.meta).toEqual({ total: 2, limit: 20, offset: 0 });
    });

    it('drops a ranked id whose local row is not live (retired/paused since being indexed)', async () => {
      searchSignalsMock.mockResolvedValueOnce({
        items: [
          { item_id: ids.paused, score: 0.95 },
          { item_id: ids.first, score: 0.4 },
        ],
        meta: { total: 2, limit: 20, offset: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/network/item/discover',
        payload: baseBody(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ item_id: string }> };
      expect(body.items.map((i) => i.item_id)).toEqual([ids.first]);
    });

    it('drops a ranked id with no matching local row at all', async () => {
      searchSignalsMock.mockResolvedValueOnce({
        items: [
          { item_id: randomUUID(), score: 0.99 },
          { item_id: ids.first, score: 0.4 },
        ],
        meta: { total: 2, limit: 20, offset: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/network/item/discover',
        payload: baseBody(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ item_id: string }> };
      expect(body.items.map((i) => i.item_id)).toEqual([ids.first]);
    });

    it('drops filters on private/undeclared fields before calling signals-search, keeping allowed ones', async () => {
      searchSignalsMock.mockResolvedValueOnce({
        items: [],
        meta: { total: 0, limit: 20, offset: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/network/item/discover',
        payload: baseBody({
          filters: [
            { field: SCALAR_FIELD, values: ['pune'] },
            { field: ARRAY_FIELD, values: ['plumbing', 'wiring'] },
            { field: PRIVATE_FIELD, values: ['555-0000'] }, // private — must be dropped
            { field: 'not_a_declared_field', values: ['x'] }, // undeclared — must be dropped
          ],
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(searchSignalsMock).toHaveBeenCalledTimes(1);
      const callArgs = searchSignalsMock.mock.calls[0][0] as { filters: unknown };
      expect(callArgs.filters).toEqual([
        { field: SCALAR_FIELD, values: ['pune'], arrayValued: false },
        { field: ARRAY_FIELD, values: ['plumbing', 'wiring'], arrayValued: true },
      ]);
    });

    it('passes q, geo, and pagination through to searchSignals', async () => {
      searchSignalsMock.mockResolvedValueOnce({
        items: [],
        meta: { total: 0, limit: 10, offset: 5 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/network/item/discover',
        payload: baseBody({
          q: 'plumber',
          item_latitude: 12.9716,
          item_longitude: 77.5946,
          distance_meters: 3000,
          limit: 10,
          offset: 5,
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(searchSignalsMock).toHaveBeenCalledTimes(1);
      const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).toMatchObject({
        network: NET,
        domain: DOMAIN,
        itemType: REAL_ITEM_TYPE,
        q: 'plumber',
        lat: 12.9716,
        lng: 77.5946,
        distanceMeters: 3000,
        limit: 10,
        offset: 5,
      });
    });

    it('returns a clean 500 (never throws) when signals-search fails', async () => {
      searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/network/item/discover',
        payload: baseBody(),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    });
  },
);
