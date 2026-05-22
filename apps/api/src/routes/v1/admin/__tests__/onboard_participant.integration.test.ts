/**
 * Plan 2 Task 6 — integration test for POST /api/v1/admin/onboard_participant.
 *
 * Unlike the unit suite (onboard_participant.test.ts), this file talks to a
 * real Postgres instance and runs the production auth + acting_org
 * preHandlers. The filename ends with `.integration.test.ts` so vitest's
 * default include glob (configured in apps/api/vitest.config.ts per Plan 1
 * Task 1) excludes it from `pnpm test` — you have to opt in by name:
 *
 *   pnpm --filter api exec vitest run \
 *     src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts
 *
 * ## Prerequisites (operator-supplied — these are NOT in .env.example)
 *
 * 1. Local Postgres + Redis up:
 *      docker compose up -d db redis
 *      pnpm db:push:api && pnpm db:init:api && pnpm db:seed:services:api
 *
 *    The seed prints the aggregator-dpg apikey on its first run — capture it.
 *
 * 2. Mirror an aggregator org. The seed creates a `network_service`-type org
 *    for aggregator-dpg itself, but participant onboarding is rejected
 *    (403 INVALID_ACTING_ORG) when the acting_org is `network_service`. You
 *    must first call /api/v1/admin/aggregator/upsert with the seeded apikey
 *    and `x-acting-org-id` set to the aggregator-dpg network_service org id
 *    to create a real aggregator org, e.g. BBMP. The response carries the
 *    new aggregator's `org_id` — that's what you pass below as
 *    TEST_AGGREGATOR_ORG_ID.
 *
 * 3. Run with the two env vars set:
 *      TEST_AGGREGATOR_APIKEY=sk_signals_...   # raw seeded key
 *      TEST_AGGREGATOR_ORG_ID=org_...          # mirrored aggregator org_id
 *
 * If either env var is missing, the suite is skipped with a clear message
 * (no CI breakage on machines without the local stack). If POSTGRES_URL /
 * POSTGRES_USER aren't set the suite is also skipped — drizzle_config would
 * otherwise throw on import.
 *
 * ## Caveats
 *
 * - Test data is NOT cleaned up: each run leaves a few +91990X... users in
 *   the user table. Acceptable for a manual smoke test, not for CI.
 * - If TEST_AGGREGATOR_ORG_ID points at the aggregator-dpg network_service
 *   org (instead of a mirrored aggregator org), the route returns 403
 *   INVALID_ACTING_ORG and the happy-path tests will fail.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';

const apikey = process.env.TEST_AGGREGATOR_APIKEY;
const acting_org_id = process.env.TEST_AGGREGATOR_ORG_ID;
const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;

const can_run = Boolean(apikey && acting_org_id && pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : !apikey
    ? 'TEST_AGGREGATOR_APIKEY not set — skipping integration suite'
    : !acting_org_id
      ? 'TEST_AGGREGATOR_ORG_ID not set — skipping integration suite'
      : '';

const describeIf = can_run ? describe : describe.skip;

describeIf(`POST /admin/onboard_participant (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let user: typeof import('../../../../../db/postgres/schema/auth.js').user;

  beforeAll(async () => {
    // Lazy-imported so the bare `import` doesn't fire `drizzle_config` (and
    // thus Pool construction) on CI machines without a DB — `can_run` is
    // already false and the suite skipped above, but these imports would
    // still execute at module load.
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    db = drizzle_mod.db;
    user = auth_mod.user;

    const { admin_routes } = await import('../admin_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Mount the admin scope EXACTLY like the production server does — same
    // auth_middleware + acting_org preHandler chain, no stubbing.
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.ready();
  });

  const headers = () => ({
    'x-api-key': apikey!,
    'x-acting-org-id': acting_org_id!,
    'content-type': 'application/json',
  });

  it('creates a participant on first call', async () => {
    const phone =
      '+919900' +
      Math.floor(100000 + Math.random() * 900000).toString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: headers(),
      payload: {
        phone_number: phone,
        name: 'Integration Anita',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        source_id: `integration_${Date.now()}`,
        profile: {
          whoIAm: { name: 'Anita' },
          whatIWant: { roles: ['tutor'] },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBeTruthy();
    expect(body.profile_item_id).toBeTruthy();
    expect(body.onboarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns 409 USER_ALREADY_EXISTS on the second call with the same phone', async () => {
    const phone =
      '+919901' +
      Math.floor(100000 + Math.random() * 900000).toString();
    const payload = {
      phone_number: phone,
      name: 'Integration Dup',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      profile: {},
    };
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: headers(),
      payload,
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: headers(),
      payload,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('USER_ALREADY_EXISTS');
  });

  it('persists attribution columns on the new user row', async () => {
    const phone =
      '+919902' +
      Math.floor(100000 + Math.random() * 900000).toString();
    const source_id = `integration_voice_${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: headers(),
      payload: {
        phone_number: phone,
        name: 'Integration Attribution',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id,
        profile: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const { user_id } = res.json();

    // Cross-check the actual DB state — the strongest signal that
    // attribution actually persisted through the route's transaction.
    const rows = await db
      .select({
        org: user.onboardedByOrgId,
        via: user.onboardedVia,
        src: user.onboardedSourceId,
        at: user.onboardedAt,
      })
      .from(user)
      .where(eq(user.id, user_id))
      .limit(1);

    expect(rows).toHaveLength(1);
    expect(rows[0].org).toBe(acting_org_id);
    expect(rows[0].via).toBe('voice');
    expect(rows[0].src).toBe(source_id);
    expect(rows[0].at).toBeTruthy();
  });
});
