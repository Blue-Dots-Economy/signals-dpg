/**
 * Plan 3 Task 11 — integration tests for the aggregator dashboard +
 * export endpoints against a real Postgres.
 *
 * File name ends in .integration.test.ts so the default vitest.config.ts
 * excludes it from `pnpm test`. Run via the sibling integration config:
 *
 *   docker compose up -d db redis
 *   pnpm db:push:api && pnpm db:init:api && pnpm db:seed:services:api
 *   # Mirror an aggregator org first (use the network_service apikey + org_id
 *   # from the seed):
 *   curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
 *     -H 'x-api-key: <seeded sk_signals_...>' \
 *     -H 'x-acting-org-id: <seeded network_service org_id>' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"external_id":"agg_test_001","name":"Test Aggregator","slug":"test-agg"}'
 *   # Capture the returned org_id — that's the TEST_AGGREGATOR_ORG_ID below.
 *
 *   TEST_AGGREGATOR_APIKEY=sk_signals_... \
 *   TEST_AGGREGATOR_ORG_ID=org_... \
 *     pnpm --filter api test:integration
 *
 * If any of POSTGRES_URL / TEST_AGGREGATOR_APIKEY / TEST_AGGREGATOR_ORG_ID
 * is missing, the suite is described as `.skip` so CI without the local
 * stack stays green.
 *
 * ## Cleanup
 *
 * Each run onboards 3 participants tagged with
 * `source_id: integration_metrics_<timestamp>`. The afterAll hook deletes
 * those user rows (cascades to participant_metrics via FK), so the
 * aggregator's row count returns to whatever it was before this run.
 * If the suite is interrupted mid-flight, leftover rows are acceptable
 * (low-concurrency local dev) — re-running the suite is the cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, sql, inArray } from 'drizzle-orm';

const apikey = process.env.TEST_AGGREGATOR_APIKEY;
const acting_org_id = process.env.TEST_AGGREGATOR_ORG_ID;
const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;

// A second key/org is needed for the 403 test — the seed prints the
// aggregator-dpg network_service apikey + org_id which is the natural
// negative case. If they're not supplied the 403 test is individually
// skipped (it.skip) — the rest of the suite still runs.
const network_service_apikey = process.env.TEST_NETWORK_SERVICE_APIKEY;
const network_service_org_id = process.env.TEST_NETWORK_SERVICE_ORG_ID;

const can_run = Boolean(apikey && acting_org_id && pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : !apikey
    ? 'TEST_AGGREGATOR_APIKEY not set — skipping integration suite'
    : !acting_org_id
      ? 'TEST_AGGREGATOR_ORG_ID not set — skipping integration suite'
      : '';

const describeIf = can_run ? describe : describe.skip;

describeIf(`GET /aggregator/dashboard (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let user: typeof import('../../../../../db/postgres/schema/auth.js').user;

  const run_tag = `integration_metrics_${Date.now()}`;
  const seeded_user_ids: string[] = [];

  beforeAll(async () => {
    // Lazy-imported so the bare `import` doesn't fire `drizzle_config` (and
    // thus Pool construction) on machines without a DB — `can_run` is
    // already false and the suite is skipped above, but these imports
    // would still execute at module load.
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    db = drizzle_mod.db;
    user = auth_mod.user;

    const { admin_routes } = await import('../../admin/admin_routes.js');
    const { aggregator_routes } = await import('../aggregator_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Mount admin + aggregator scopes exactly like the production server
    // — same auth_middleware + acting_org preHandler chain, no stubbing.
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(aggregator_routes, { prefix: '/api/v1/aggregator' });
    await app.ready();

    // Seed 3 participants via the real onboard route so the recompute has
    // something to compute. The participants will land with profile_status
    // 'new' (no applications yet), which gives test 5 something to filter on.
    for (let i = 0; i < 3; i++) {
      const phone =
        '+919910' +
        Math.floor(100000 + Math.random() * 900000).toString();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/participant',
        headers: {
          'x-api-key': apikey!,
          'x-acting-org-id': acting_org_id!,
          'content-type': 'application/json',
        },
        payload: {
          phone_number: phone,
          name: `Metrics Test ${i}`,
          terms_accepted: true,
          privacy_accepted: true,
          channel: 'bulk',
          source_id: run_tag,
          item_state: {
            whoIAm: { name: `Metrics Test ${i}` },
            whatIWant: { roles: ['tutor'] },
          },
        },
      });
      if (res.statusCode !== 200) {
        throw new Error(
          `seed onboard failed: ${res.statusCode} ${res.body}`,
        );
      }
      seeded_user_ids.push(res.json().user_id);
    }
  });

  afterAll(async () => {
    if (seeded_user_ids.length > 0 && user && db) {
      // FK cascade on participant_metrics.user_id removes the metrics rows.
      // We delete users tagged by this run's source_id to avoid touching
      // unrelated rows.
      await db.delete(user).where(inArray(user.id, seeded_user_ids));
    }
    if (app) await app.close();
  });

  const headers = () => ({
    'x-api-key': apikey!,
    'x-acting-org-id': acting_org_id!,
    'content-type': 'application/json',
  });

  // Tests run sequentially because they share cache state. Vitest runs
  // `it` blocks in declared order by default within a file.

  let first_last_computed_at: string | null = null;

  it('first call recomputes — refreshed=true, ISO last_computed_at', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rollup.participants_total).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(body.participants)).toBe(true);
    expect(body.metadata.refreshed).toBe(true);
    expect(body.metadata.last_computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    first_last_computed_at = body.metadata.last_computed_at;
  });

  it('second call serves the warm cache — refreshed=false, same last_computed_at', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metadata.refreshed).toBe(false);
    expect(body.metadata.last_computed_at).toBe(first_last_computed_at);
  });

  it('force-stale via SQL bump → next call recomputes again', async () => {
    // Push every row for this aggregator 2 hours into the past so the
    // TTL check (default 3600s) treats them as stale.
    await db.execute(
      sql`UPDATE participant_metrics
            SET last_computed_at = NOW() - INTERVAL '2 hours'
          WHERE onboarded_by_org_id = ${acting_org_id}`,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metadata.refreshed).toBe(true);
    // The freshly-recomputed timestamp must be strictly newer than what
    // we saw on the first call.
    expect(
      new Date(body.metadata.last_computed_at).getTime(),
    ).toBeGreaterThan(new Date(first_last_computed_at!).getTime());
  });

  it('?status=new scopes the participants list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard?status=new',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.participants)).toBe(true);
    for (const p of body.participants) {
      expect(p.profile_status).toBe('new');
    }
  });

  it('pagination ?page=1&limit=1 → ?page=2&limit=1 returns different rows', async () => {
    const r1 = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard?page=1&limit=1',
      headers: headers(),
    });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.participants).toHaveLength(1);
    // next_cursor reflects offset pagination: full page → '2'.
    expect(b1.next_cursor).toBe('2');

    const r2 = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard?page=2&limit=1',
      headers: headers(),
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.participants).toHaveLength(1);
    expect(b2.participants[0].user_id).not.toBe(
      b1.participants[0].user_id,
    );
    // next_cursor on page 2 is '3' if there's a 3rd row this aggregator
    // has, or null if the aggregator only has 2 rows total. With 3
    // seeded rows it should be '3', but other test data may exist.
    expect(b2.next_cursor === '3' || b2.next_cursor === null).toBe(true);
  });

  const network_service_can_run = Boolean(
    network_service_apikey && network_service_org_id,
  );
  const itNetSvc = network_service_can_run ? it : it.skip;
  itNetSvc(
    `403 NOT_AGGREGATOR when caller acts as network_service${
      network_service_can_run
        ? ''
        : ' — set TEST_NETWORK_SERVICE_APIKEY + TEST_NETWORK_SERVICE_ORG_ID to run'
    }`,
    async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/aggregator/dashboard',
        headers: {
          'x-api-key': network_service_apikey!,
          'x-acting-org-id': network_service_org_id!,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('NOT_AGGREGATOR');
    },
  );

  it('CSV export returns text/csv with header + matching status row count', async () => {
    // Read total matching first so we know how many CSV body rows to expect.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard?status=new&limit=500',
      headers: headers(),
    });
    expect(listRes.statusCode).toBe(200);
    const total = listRes.json().total_matching as number;

    const csvRes = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard/export?status=new',
      headers: headers(),
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toMatch(/^text\/csv/);
    const body = csvRes.body;
    const lines = body.split('\n').filter((l) => l.length > 0);
    // First line is the column header.
    expect(lines[0]).toMatch(/^user_id,profile_status,/);
    // Remaining lines are data rows — one per matching participant.
    expect(lines.length - 1).toBe(total);
  });

});
