/**
 * #370/#422 — integration test that the per-pair action cap is race-safe.
 *
 * The cap (services/action_pair_cap.ts) allows at most `max_actions_per_pair`
 * (blue_dot: unset -> default 1) OPEN actions between a pair, enforced inside
 * the /network/action/perform insert transaction under a pair-scoped
 * `pg_advisory_xact_lock`. A mocked-tx unit test can't prove the lock actually
 * serializes concurrent submits — this fires MORE parallel performs than free
 * slots against a live Postgres and asserts exactly the free slots commit, the
 * rest 409 (ACTION_LIMIT_REACHED, surfaced per-item as HTTP 422 by the proxy),
 * and the DB never exceeds the cap. (Mirrors the concurrent-create test PR #353
 * required for the admin per-user cap.)
 *
 * Adult seeker (no guardian gate), consent included, so the ONLY thing that can
 * reject a parallel submit is the pair cap.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm --filter api test:integration src/routes/v1/action/__tests__/action_pair_cap.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { and, eq, inArray, or } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => ({ notify: async () => {} }),
}));

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

const NETWORK = 'blue_dot';
const SOURCE_DOMAIN = 'seeker';
const SOURCE_ITEM_TYPE = 'profile_1.0';
const TARGET_DOMAIN = 'provider';
const TARGET_ITEM_TYPE = 'job_posting_1.0';
const ACTION_TYPE = 'apply';
const CONSENT_VERSION = 1;
const PARALLEL = 6; // > cap (1)

describeIf(`Action pair cap is race-safe — POST /action/perform (${NETWORK}/${ACTION_TYPE})`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  const seeker_user_id = `usr_${randomUUID()}`;
  const seeker_apikey_id = `key_${randomUUID()}`;
  const seeker_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const seeker_email = `pair-cap-seeker-${Date.now()}@signals.local`;
  const seeker_item_id = randomUUID();

  const provider_owner_id = `usr_${randomUUID()}`;
  const provider_item_id = randomUUID();

  const seeded_user_ids = [seeker_user_id, provider_owner_id];

  // Single /action/perform takes one object (not an array — that's /perform/bulk).
  const performPayload = () => ({
    action_type: ACTION_TYPE,
    source_item: {
      item_network: NETWORK,
      item_domain: SOURCE_DOMAIN,
      item_type: SOURCE_ITEM_TYPE,
      item_id: seeker_item_id,
    },
    target_item: {
      item_network: NETWORK,
      item_domain: TARGET_DOMAIN,
      item_type: TARGET_ITEM_TYPE,
      item_id: provider_item_id,
      item_instance_url: base_url,
    },
    requirements_snapshot: {},
    consent: { acknowledged: true, version: CONSENT_VERSION },
  });

  const openCount = async () => {
    const rows = await db
      .select({ id: itemActionsTable.action_id })
      .from(itemActionsTable)
      .where(
        and(
          eq(itemActionsTable.partition_network, NETWORK),
          or(
            and(
              eq(itemActionsTable.source_item_id, seeker_item_id),
              eq(itemActionsTable.target_item_id, provider_item_id),
            ),
            and(
              eq(itemActionsTable.source_item_id, provider_item_id),
              eq(itemActionsTable.target_item_id, seeker_item_id),
            ),
          ),
          inArray(itemActionsTable.action_status, ['created']),
        ),
      );
    return rows.length;
  };

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');

    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;

    const action_routes_mod = await import('../action_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(action_routes_mod.default, { prefix: '/api/v1/action' });
    await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });
    try {
      await app.listen({ port: listen_port, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `action_pair_cap integration test requires port ${listen_port} to be free (set API_PORT).`,
        );
      }
      throw err;
    }

    const { user, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: seeker_user_id,
      email: seeker_email,
      name: seeker_email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const hashed = createHash('sha256').update(seeker_raw_key).digest('base64url');
    await db.insert(apikey).values({
      id: seeker_apikey_id,
      name: seeker_apikey_id,
      key: hashed,
      userId: seeker_user_id,
      referenceId: seeker_user_id,
      configId: 'default',
      start: seeker_raw_key.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(user).values({
      id: provider_owner_id,
      email: `pair-cap-provider-${Date.now()}@signals.local`,
      name: 'provider-owner',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    await database_pkg.ensureItemPartition(db, NETWORK, SOURCE_DOMAIN);
    await database_pkg.ensureItemPartition(db, NETWORK, TARGET_DOMAIN);
    await database_pkg.ensureActionPartition(db, NETWORK, ACTION_TYPE);
    await database_pkg.ensureActionEventPartition(db, NETWORK, ACTION_TYPE);

    const insertLiveItem = async (itemId: string, domain: string, itemType: string, createdBy: string) => {
      await db.insert(itemsTable).values({
        item_network: NETWORK,
        item_domain: domain,
        item_type: itemType,
        item_id: itemId,
        item_instance_url: base_url,
        item_schema_url: `${base_url}/api/v1/network/schema/${NETWORK}/${domain}/${itemType}`,
        item_state: {},
        item_locations: [],
        created_by: createdBy,
        lifecycle_status: 'live',
      });
    };
    await insertLiveItem(seeker_item_id, SOURCE_DOMAIN, SOURCE_ITEM_TYPE, seeker_user_id);
    await insertLiveItem(provider_item_id, TARGET_DOMAIN, TARGET_ITEM_TYPE, provider_owner_id);
  });

  afterAll(async () => {
    const { user, apikey } = authSchema;
    try {
      await db
        .delete(itemActionsTable)
        .where(inArray(itemActionsTable.source_item_owner, seeded_user_ids));
      await db
        .delete(itemsTable)
        .where(
          and(eq(itemsTable.item_network, NETWORK), inArray(itemsTable.item_id, [seeker_item_id, provider_item_id])),
        );
      await db.delete(apikey).where(eq(apikey.id, seeker_apikey_id));
      await db.delete(user).where(inArray(user.id, seeded_user_ids));
    } catch {
      // best-effort cleanup
    }
    if (app) await app.close();
  });

  it(`${PARALLEL} concurrent performs on the same pair -> exactly 1 succeeds, the rest ACTION_LIMIT_REACHED, DB has 1 open`, async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/action/perform',
          headers: { 'x-api-key': seeker_raw_key, 'content-type': 'application/json' },
          payload: performPayload(),
        }),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const blocked = results.filter(
      (r) => r.statusCode === 422 && r.json().results?.[0]?.error === 'ACTION_LIMIT_REACHED',
    );

    // The cap is 1, so exactly one create commits and every other parallel
    // submit is blocked by the advisory-lock recount — none slip through.
    expect(created).toHaveLength(1);
    expect(blocked).toHaveLength(PARALLEL - 1);
    // The DB itself never exceeds the cap.
    expect(await openCount()).toBe(1);
  });
});
