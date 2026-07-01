/**
 * Phase 3 Task 1 — integration test for profile_creation consent recording
 * on POST /api/v1/item/create.
 *
 * Scenarios:
 *   1. Create item WITH consent: { category: 'profile_creation', version: 1 }
 *      → 201 AND a consent_record row (level:'item', consentCategory:'profile_creation',
 *        itemId = returned id, source:'profile').
 *   2. Create item WITHOUT consent
 *      → 201 AND no consent_record row for that item.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration create_item
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
import { generateMinimalItemState, resolveBindings } from '../../__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

describeIf(`profile_creation consent recorded on item create (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let consentRecordTable: typeof import('@api/db/postgres/schema').consent_record;
  let itemsTable: typeof import('@dpg/database').items;

  const listen_port = Number(process.env.API_PORT ?? 2742);

  const test_user_id = `usr_${randomUUID()}`;
  const apikey_id = `key_${randomUUID()}`;
  const raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const user_email = `create-item-consent-int-${Date.now()}@signals.local`;

  let served_network: string;
  let served_domain: string;
  let served_item_type: string;
  let item_state: Record<string, unknown>;

  const created_item_ids: string[] = [];

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const api_schema_mod = await import('@api/db/postgres/schema');
    const database_pkg = await import('@dpg/database');

    db = drizzle_mod.db;
    authSchema = auth_mod;
    consentRecordTable = api_schema_mod.consent_record;
    itemsTable = database_pkg.items;

    const bindings = await resolveBindings();
    served_network = bindings.primary.network;
    served_domain = bindings.primary.domain;
    served_item_type = bindings.primary.item_type;
    item_state = generateMinimalItemState(bindings.primary.schema);

    const item_routes_mod = await import('../../item/item_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(item_routes_mod.default, { prefix: '/api/v1/item' });

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
      name: `create-item-consent-int-${Date.now()}`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    const hashed_key = createHash('sha256').update(raw_key).digest('base64url');
    await db.insert(apikey).values({
      id: apikey_id,
      name: `create-item-consent-int-${Date.now()}`,
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
      if (created_item_ids.length > 0) {
        await db
          .delete(consentRecordTable)
          .where(eq(consentRecordTable.userId, test_user_id));
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.item_id, created_item_ids));
      }
      await db.delete(apikey).where(eq(apikey.id, apikey_id));
      await db.delete(user).where(eq(user.id, test_user_id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('create_item consent integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  it('create with consent → 201 and consent_record row exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/item/create',
      headers: {
        'x-api-key': raw_key,
        'content-type': 'application/json',
      },
      payload: {
        item_network: served_network,
        item_domain: served_domain,
        item_type: served_item_type,
        item_state,
        consent: { category: 'profile_creation', version: 1 },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { item_id: string; item_type: string };
    expect(typeof body.item_id).toBe('string');
    created_item_ids.push(body.item_id);

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.itemId, body.item_id));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.level).toBe('item');
    expect(row.consentCategory).toBe('profile_creation');
    expect(row.itemId).toBe(body.item_id);
    expect(row.source).toBe('profile');
    expect(row.userId).toBe(test_user_id);
    expect(row.documentVersion).toBe(1);
    expect(row.network).toBe(served_network);
  });

  it('create without consent → 201 and no consent_record row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/item/create',
      headers: {
        'x-api-key': raw_key,
        'content-type': 'application/json',
      },
      payload: {
        item_network: served_network,
        item_domain: served_domain,
        item_type: served_item_type,
        item_state,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { item_id: string; item_type: string };
    expect(typeof body.item_id).toBe('string');
    created_item_ids.push(body.item_id);

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.itemId, body.item_id));

    expect(rows).toHaveLength(0);
  });
});
