/**
 * Phase 2 Task 1 — integration test for GET /api/v1/consent/status and
 * POST /api/v1/consent/accept against a real Postgres + Redis.
 *
 * The suite seeds a minimal user + apikey so the auth middleware can
 * resolve request.user.id. It then exercises the four scenarios defined
 * in the task brief:
 *   1. POST /accept with two items → recorded: 2; two rows in consent_record.
 *   2. GET /status?network=<net> → correct version arrays per category.
 *   3. POST /accept with an unknown network → 400 UNKNOWN_NETWORK.
 *   4. Second accept of terms v2 → GET /status returns both versions.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration consent
 *
 * Skip condition: if POSTGRES_URL/POSTGRES_USER is unset the suite is
 * describe.skip'd so CI without a live DB stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

describeIf(`consent status + accept endpoints (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let consentRecordTable: typeof import('@api/db/postgres/schema').consent_record;

  const listen_port = Number(process.env.API_PORT ?? 2742);

  // Test user + apikey (seeded directly via drizzle — no participant
  // onboarding needed because consent_record has no FK to items).
  const test_user_id = `usr_${randomUUID()}`;
  const apikey_id = `key_${randomUUID()}`;
  const raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const user_email = `consent-int-${Date.now()}@signals.local`;

  // The network used in happy-path tests — resolved from the first
  // served_domains entry at runtime so the suite isn't hardcoded.
  let served_network: string;

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const api_schema_mod = await import('@api/db/postgres/schema');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    consentRecordTable = api_schema_mod.consent_record;

    const { apiConfig } = await import('@/config');
    if (apiConfig.served_domains.length === 0) {
      throw new Error(
        'consent integration suite requires SERVED_DOMAINS to have at least one entry',
      );
    }
    served_network = apiConfig.served_domains[0].network;

    const consent_routes_mod = await import('../consent_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(consent_routes_mod.default, {
      prefix: '/api/v1/consent',
    });
    try {
      await app.listen({ port: listen_port, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `integration test requires port ${listen_port} to be free ` +
            `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: test_user_id,
      email: user_email,
      name: `consent-int-user-${Date.now()}`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    const hashed_key = createHash('sha256').update(raw_key).digest('base64url');
    await db.insert(apikey).values({
      id: apikey_id,
      name: `consent-int-key-${Date.now()}`,
      key: hashed_key,
      userId: test_user_id,
      referenceId: test_user_id,
      configId: 'default',
      start: raw_key.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    const { user, apikey } = authSchema;
    try {
      await db
        .delete(consentRecordTable)
        .where(eq(consentRecordTable.userId, test_user_id));
      await db.delete(apikey).where(eq(apikey.id, apikey_id));
      await db.delete(user).where(eq(user.id, test_user_id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('consent integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  it('POST /accept with two items returns recorded: 2 and writes two rows', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consent/accept',
      headers: {
        'x-api-key': raw_key,
        'content-type': 'application/json',
      },
      payload: {
        network: served_network,
        source: 'signup',
        items: [
          { category: 'terms', version: 1 },
          { category: 'privacy', version: 1 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recorded: 2 });

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, test_user_id));

    expect(rows).toHaveLength(2);
    const categories = rows.map((r) => r.consentCategory).sort();
    expect(categories).toEqual(['privacy', 'terms']);
  });

  it('GET /status?network=<net> returns correct version arrays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/consent/status?network=${served_network}`,
      headers: { 'x-api-key': raw_key },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      statuses: {
        terms: [1],
        privacy: [1],
      },
    });
  });

  it('POST /accept with an unknown network returns 400 UNKNOWN_NETWORK', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consent/accept',
      headers: {
        'x-api-key': raw_key,
        'content-type': 'application/json',
      },
      payload: {
        network: 'definitely_not_a_real_network',
        source: 'signup',
        items: [{ category: 'terms', version: 1 }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_NETWORK' });
  });

  it('second accept of terms v2 → GET /status returns terms: [1, 2]', async () => {
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/consent/accept',
      headers: {
        'x-api-key': raw_key,
        'content-type': 'application/json',
      },
      payload: {
        network: served_network,
        source: 'login',
        items: [{ category: 'terms', version: 2 }],
      },
    });

    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json()).toEqual({ recorded: 1 });

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/consent/status?network=${served_network}`,
      headers: { 'x-api-key': raw_key },
    });

    expect(statusRes.statusCode).toBe(200);
    const body = statusRes.json() as {
      statuses: { terms: number[]; privacy: number[] };
    };
    expect(body.statuses.terms).toEqual([1, 2]);
    expect(body.statuses.privacy).toEqual([1]);

    // Verify the DB directly: three rows total for this user on this
    // network (terms v1, privacy v1, terms v2).
    const rows = await db
      .select({
        consentCategory: consentRecordTable.consentCategory,
        documentVersion: consentRecordTable.documentVersion,
      })
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, test_user_id));

    expect(rows).toHaveLength(3);
    const termRows = rows
      .filter((r) => r.consentCategory === 'terms')
      .map((r) => r.documentVersion)
      .sort((a, b) => a - b);
    expect(termRows).toEqual([1, 2]);
  });

  it('GET /status without auth returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/consent/status?network=${served_network}`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('POST /accept without auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consent/accept',
      headers: { 'content-type': 'application/json' },
      payload: {
        network: served_network,
        source: 'signup',
        items: [{ category: 'terms', version: 1 }],
      },
    });

    expect(res.statusCode).toBe(401);
  });

  // status-by-identifier (public, pre-login)

  it('GET /status-by-identifier with known email returns accepted versions', async () => {
    // The test user accepted terms v1, privacy v1, and terms v2 in prior tests.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/consent/status-by-identifier?network=${served_network}&email=${encodeURIComponent(user_email)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { statuses: { terms: number[]; privacy: number[] } };
    expect(body.statuses.terms).toEqual([1, 2]);
    expect(body.statuses.privacy).toEqual([1]);
  });

  it('GET /status-by-identifier with unknown identifier returns empty statuses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/consent/status-by-identifier?network=${served_network}&email=nobody-unknown-${Date.now()}%40signals.local`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statuses: { terms: [], privacy: [] } });
  });

  it('GET /status-by-identifier requires no auth (no x-api-key)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/consent/status-by-identifier?network=${served_network}&email=${encodeURIComponent(user_email)}`,
      // Deliberately no x-api-key header
    });

    expect(res.statusCode).toBe(200);
  });
});
