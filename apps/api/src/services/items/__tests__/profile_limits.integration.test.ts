/**
 * #927 — profile limits against a real Postgres: the total limit on create, the
 * `live_limit` gate on create / consent promotion / unpause, and that the owner
 * lock lets only one of those concurrent writes take the last live slot.
 *
 * Every domain gets `profile_limits: { live: 1, total: 3 }` by wrapping
 * `getNetworkConfigById`, so the suite runs on whatever network CI serves.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm --filter api test:integration src/services/items/__tests__/profile_limits.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateMinimalItemState,
  resolveBindings,
  type ResolvedBinding,
} from '../../../routes/v1/__tests__/integration_helpers';

vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => ({ notify: async () => {} }),
}));

vi.mock('@/network_configs', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/network_configs')>();
  return {
    ...real,
    getNetworkConfigById: async (id: string) => {
      const cfg = await real.getNetworkConfigById(id);
      return {
        ...cfg,
        domains: cfg.domains.map((d) => ({ ...d, profile_limits: { live: 1, total: 3 } })),
      };
    },
  };
});

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const describeIf = pg_url ? describe : describe.skip;

const hash_key = (raw: string) => createHash('sha256').update(raw).digest('base64url');

describeIf('profile limits (live 1, total 3) — integration', () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let consentRecordTable: typeof import('@api/db/postgres/schema').consent_record;
  let itemService: typeof import('../../item_service.js');
  let primary: ResolvedBinding;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const ts = Date.now();
  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `pl-int-ns-${ts}`,
  };
  const svc_user_id = `usr_${randomUUID()}`;
  const owner_ids: string[] = [];

  beforeAll(async () => {
    db = (await import('@api/db/postgres/drizzle_config')).db;
    authSchema = await import('../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    itemsTable = database_pkg.items;
    consentRecordTable = (await import('../../../../db/postgres/schema/index.js')).consent_record;
    itemService = await import('../../item_service.js');
    primary = (await resolveBindings()).primary;
    await database_pkg.ensureItemPartition(db, primary.network, primary.domain);

    const item_routes_mod = await import('../../../routes/v1/item/item_routes.js');
    const network_routes_mod = await import('../../../routes/v1/network/network_routes.js');
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(item_routes_mod.default, { prefix: '/api/v1/item' });
    await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });
    // Schemas resolve through the instance URL, which points at this port.
    await app.listen({ port: listen_port, host: '127.0.0.1' });

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();
    await db.insert(user).values({
      id: svc_user_id,
      email: `signals-pl-int-${ts}@signals.local`,
      name: 'profile limits integration svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organization).values({
      id: ns.org_id,
      slug: ns.slug,
      name: `${ns.slug} (network_service)`,
      type: 'network_service',
      createdAt: now,
    });
    await db.insert(member).values({
      id: ns.member_id,
      organizationId: ns.org_id,
      userId: svc_user_id,
      role: 'service',
      createdAt: now,
    });
    await db.insert(apikey).values({
      id: ns.apikey_id,
      name: ns.slug,
      key: hash_key(ns.raw_key),
      userId: svc_user_id,
      referenceId: svc_user_id,
      configId: 'default',
      start: ns.raw_key.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      if (owner_ids.length > 0) {
        await db.delete(consentRecordTable).where(inArray(consentRecordTable.userId, owner_ids));
        await db.delete(itemsTable).where(inArray(itemsTable.created_by, owner_ids));
        await db.delete(user).where(inArray(user.id, owner_ids));
      }
      await db.delete(apikey).where(eq(apikey.id, ns.apikey_id));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db.delete(organization).where(eq(organization.id, ns.org_id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('profile limits integration cleanup failed:', err);
    }
    if (app) await app.close();
  });

  /** An adult owner, so a guardian-gated domain does not block go-live. */
  async function newOwner(): Promise<string> {
    const id = `usr_${randomUUID()}`;
    const now = new Date();
    await db.insert(authSchema.user).values({
      id,
      email: `pl-int-${randomUUID().slice(0, 8)}@signals.local`,
      name: 'Limit Owner',
      emailVerified: true,
      age: 30,
      createdAt: now,
      updatedAt: now,
    });
    owner_ids.push(id);
    return id;
  }

  /** A complete profile; `consent` makes it eligible to go live on create. */
  const create = (owner: string, consent = true) =>
    db.transaction((tx) =>
      itemService.createItemInternal(tx, {
        item_network: primary.network,
        item_domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        created_by: owner,
        consent_accepted: consent,
      }),
    );

  /** Record profile consent, then run the promotion /consent/profile-accept runs. */
  const acceptConsent = async (owner: string, itemId: string) => {
    await db.insert(consentRecordTable).values({
      level: 'item',
      consentCategory: 'profile_creation',
      userId: owner,
      itemId,
      network: primary.network,
      documentVersion: 1,
      source: 'profile',
      acceptedAt: new Date(),
    });
    return db.transaction((tx) => itemService.promoteItemOnProfileConsent(tx, itemId));
  };

  const lifecycle = (itemId: string, action: 'pause' | 'unpause') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: { item_id: itemId, action },
    });

  const statuses = async (owner: string) =>
    (
      await db
        .select({ s: itemsTable.lifecycle_status })
        .from(itemsTable)
        .where(eq(itemsTable.created_by, owner))
    ).map((r) => r.s);

  const statusOf = async (itemId: string) =>
    (
      await db
        .select({ s: itemsTable.lifecycle_status })
        .from(itemsTable)
        .where(eq(itemsTable.item_id, itemId))
    )[0]?.s;

  it('holds a profile in draft at the live limit and refuses a create at the total limit', async () => {
    const owner = await newOwner();

    const first = await create(owner);
    expect(first).toMatchObject({ lifecycleStatus: 'live', blockedByLiveLimit: false });
    const second = await create(owner);
    expect(second).toMatchObject({ lifecycleStatus: 'draft', blockedByLiveLimit: true });
    await create(owner);

    await expect(create(owner)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PROFILE_LIMIT_REACHED',
      details: { limit_type: 'total' },
    });
    expect((await statuses(owner)).sort()).toEqual(['draft', 'draft', 'live']);
  });

  it('frees the slot on pause, then refuses to unpause while the slot is taken', async () => {
    const owner = await newOwner();
    const live = await create(owner);
    const held = await create(owner, false);
    expect(held.lifecycleStatus).toBe('draft');

    // Consent alone cannot publish while the one live slot is taken.
    await expect(acceptConsent(owner, held.itemId)).resolves.toEqual({
      promoted: false,
      blockedByLiveLimit: true,
    });

    expect((await lifecycle(live.itemId, 'pause')).statusCode).toBe(200);
    await expect(
      db.transaction((tx) => itemService.promoteItemOnProfileConsent(tx, held.itemId)),
    ).resolves.toEqual({ promoted: true, blockedByLiveLimit: false });

    const unpause = await lifecycle(live.itemId, 'unpause');
    expect(unpause.statusCode).toBe(409);
    expect(unpause.json()).toMatchObject({ error: 'PROFILE_LIMIT_REACHED', limit_type: 'live' });
    expect(await statusOf(live.itemId)).toBe('paused');
  });

  it('lets exactly one of a racing create, consent promotion and unpause take the last live slot', async () => {
    for (let round = 0; round < 5; round++) {
      const owner = await newOwner();
      // A paused profile and a consent-pending draft: the live slot is free.
      const paused = await create(owner);
      expect((await lifecycle(paused.itemId, 'pause')).statusCode).toBe(200);
      const draft = await create(owner, false);

      await Promise.allSettled([
        create(owner),
        acceptConsent(owner, draft.itemId),
        lifecycle(paused.itemId, 'unpause'),
      ]);

      const after = await statuses(owner);
      expect(after.filter((s) => s === 'live')).toHaveLength(1);
      expect(after).toHaveLength(3);
    }
  });
});
