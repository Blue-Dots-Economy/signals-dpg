/**
 * Epic #203 List PR (P-follow-3, Task 2 — REVISED) — integration test for the
 * public `POST /network/item/discover` BFF's private/undeclared-facet guard.
 *
 * signals-search is still mocked (it cannot be run locally). Since
 * signals-search PR #87, `/v1/search` returns the full item row per result,
 * so this BFF direct-maps ranked results (see `discover.ts`) — a local DB is
 * no longer needed for the happy path, which is why the hydrate-order /
 * dropped-on-hydrate cases that used to live here (seeded Postgres rows) have
 * moved to the plain unit test `discover.test.ts`. What still earns its
 * keep as an "integration" suite is the facet guard exercised against a
 * REAL network config's schema (private/array/scalar field resolution via
 * `getDomainItemSchema`) rather than a hand-built fixture — that's the one
 * thing a unit test with a mocked network config can't prove.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * Skips when POSTGRES_URL / POSTGRES_USER is unset, matching the sibling
 * markers.integration.test.ts convention (network config loading in this repo
 * is exercised alongside the rest of the DB-backed integration suites, even
 * though this particular suite no longer performs any DB reads/writes of its
 * own).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
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

    beforeAll(async () => {
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
