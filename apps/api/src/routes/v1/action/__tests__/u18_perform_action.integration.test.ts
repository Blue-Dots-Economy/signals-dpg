/**
 * U18 Phase 5b Task 2 — integration test for the guardian action gate wired
 * into POST /api/v1/action/perform (the bulk initiate hot path).
 *
 * Network: blue_dot   Action: apply   Interaction: seeker -> provider
 *   - blue_dot's `seeker` and `provider` domains are both
 *     `guardian_consent_required` (examples/schemas/blue_dot/network.json).
 *   - `apply`'s seeker->provider interaction has an empty requirement_schema
 *     ({ type: "object", properties: {} }) and reveals_pii_on_status:
 *     ["accepted"] — the initiator-consent gate (unrelated to the guardian
 *     gate) still requires `consent: { acknowledged: true, version: 1 }` on
 *     every /action/perform call for this interaction, so every payload below
 *     includes it.
 *
 * Flow under test:
 *   1. A MINOR ward (seeded via direct `minor_guardian` repo calls, mirroring
 *      production population by the real /u18/dob + /u18/guardian routes)
 *      with a live seeker profile calls /action/perform with NO guardian_otp
 *      -> per-item `GUARDIAN_OTP_REQUIRED`, and a 6-digit OTP nonce exists in
 *      Redis at `guardian_otp:code:guardian_action:<wardUserId>:apply:<srcItemId>:<tgtItemId>`.
 *   2. Read that OTP from Redis, re-call with `guardian_otp` -> 201, and a
 *      guardian-source `action` consent_record row exists (initiate stage).
 *   3. An ADULT ward (no `minor_guardian` row) performing the identical call
 *      with no guardian_otp -> 201 directly, no challenge — proves the gate
 *      is a no-op for adults (no regression on today's adult path).
 *
 * Items are seeded directly via `db.insert(items)...` with
 * `lifecycle_status: 'live'` (mirroring consent.integration.test.ts) rather
 * than through participant onboarding, since a freshly created item always
 * starts `draft` until its own profile-creation consent is separately
 * accepted (see item_service.ts createItemInternal) — orthogonal to the
 * action gate under test here.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm --filter api test:integration src/routes/v1/action/__tests__/u18_perform_action.integration.test.ts
 *
 * Skip condition: if POSTGRES_URL/POSTGRES_USER is unset the suite is
 * describe.skip'd so CI without a live DB stays green.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

// Guardian OTP send -> no-op (no real notifier). Mocked before app import.
vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => ({ notify: async () => {} }),
}));

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

const NETWORK = 'blue_dot';
const SOURCE_DOMAIN = 'seeker';
const SOURCE_ITEM_TYPE = 'profile_1.0';
const TARGET_DOMAIN = 'provider';
const TARGET_ITEM_TYPE = 'job_posting_1.0';
const ACTION_TYPE = 'apply';
const CONSENT_VERSION = 1; // apply.initiate.current_version in blue_dot consent.json

describeIf(`U18 guardian action gate — POST /action/perform (${NETWORK}/${ACTION_TYPE})${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;
  let consentRecordTable: typeof import('@api/db/postgres/schema').consent_record;
  let minorGuardianTable: typeof import('@api/db/postgres/schema').minor_guardian;
  let redis: typeof import('@api/db/secondary/redis').redis;
  let setWardAge: typeof import('@/services/minor_guardian_repo').setWardAge;
  let upsertGuardianDetails: typeof import('@/services/minor_guardian_repo').upsertGuardianDetails;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  // Ward (minor) — has a live seeker profile + guardian details.
  const minor_user_id = `usr_${randomUUID()}`;
  const minor_apikey_id = `key_${randomUUID()}`;
  const minor_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const minor_email = `u18-perform-minor-${Date.now()}@signals.local`;
  const minor_item_id = randomUUID();

  // Ward (adult) — no minor_guardian row at all.
  const adult_user_id = `usr_${randomUUID()}`;
  const adult_apikey_id = `key_${randomUUID()}`;
  const adult_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const adult_email = `u18-perform-adult-${Date.now()}@signals.local`;
  const adult_item_id = randomUUID();

  // Ward (adult with a RECORDED adult age) — proves an adult is unaffected on
  // the EXTERNAL channel. Distinct from `adult_user_id` (which has no
  // minor_guardian row at all): on the external channel an age-unknown ward is
  // fail-closed BLOCKED (decision 3), so an adult that must succeed on-behalf
  // needs a recorded age >= 18.
  const adult_ext_user_id = `usr_${randomUUID()}`;
  const adult_ext_email = `u18-perform-adult-ext-${Date.now()}@signals.local`;
  const adult_ext_item_id = randomUUID();

  // Target — a plain provider (job posting), shared by all cases.
  const target_owner_user_id = `usr_${randomUUID()}`;
  const target_item_id = randomUUID();

  // Network-service acting org — drives the EXTERNAL / on-behalf channel
  // (any request carrying an `acting_org`). network_service has network-wide
  // scope (see _resolve_acting_actor), so it can act for the u18-seeded wards
  // even though they have no `onboarded_by_org_id`. Seeded directly (org +
  // service user + member + apikey) exactly like on_behalf_of.integration.test.ts.
  const ns_org = {
    org_id: `org_${randomUUID()}`,
    user_id: `usr_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `u18-ns-${Date.now()}`,
    user_email: `u18-ns-${Date.now()}@signals.local`,
  };

  const seeded_user_ids = [
    minor_user_id,
    adult_user_id,
    adult_ext_user_id,
    target_owner_user_id,
  ];

  const guardianScope = (wardUserId: string, sourceItemId: string) =>
    `guardian_action:${wardUserId}:${ACTION_TYPE}:${sourceItemId}:${target_item_id}`;

  // How many item_actions rows this ward owns as the source. Used to prove the
  // external block short-circuits BEFORE the loopback relay to
  // /network/action/perform (which is a real HTTP hop here, not a mockable
  // fetch spy) — a blocked call must leave the count unchanged.
  const countActionsForOwner = async (owner: string) => {
    const rows = await db
      .select({ action_id: itemActionsTable.action_id })
      .from(itemActionsTable)
      .where(
        and(
          eq(itemActionsTable.partition_network, NETWORK),
          eq(itemActionsTable.source_item_owner, owner),
        ),
      );
    return rows.length;
  };

  const buildPayload = (sourceItemId: string, guardian_otp?: string) => [
    {
      action_type: ACTION_TYPE,
      source_item: {
        item_network: NETWORK,
        item_domain: SOURCE_DOMAIN,
        item_type: SOURCE_ITEM_TYPE,
        item_id: sourceItemId,
      },
      target_item: {
        item_network: NETWORK,
        item_domain: TARGET_DOMAIN,
        item_type: TARGET_ITEM_TYPE,
        item_id: target_item_id,
        item_instance_url: base_url,
      },
      requirements_snapshot: {},
      consent: { acknowledged: true, version: CONSENT_VERSION },
      ...(guardian_otp ? { guardian_otp } : {}),
    },
  ];

  // Same body as buildPayload but carrying `acting_as_user_id` — the on-behalf
  // (EXTERNAL) shape. Combined with the network_service api-key + x-acting-org-id
  // headers below, this drives `channel: 'external'` in the gate (#395).
  const onBehalfPayload = (sourceItemId: string, actingAsUserId: string) => [
    { ...buildPayload(sourceItemId)[0], acting_as_user_id: actingAsUserId },
  ];

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    const api_schema_mod = await import('@api/db/postgres/schema');
    const redis_mod = await import('@api/db/secondary/redis');
    const minor_guardian_repo_mod = await import('@/services/minor_guardian_repo');

    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;
    consentRecordTable = api_schema_mod.consent_record;
    minorGuardianTable = api_schema_mod.minor_guardian;
    redis = redis_mod.redis;
    setWardAge = minor_guardian_repo_mod.setWardAge;
    upsertGuardianDetails = minor_guardian_repo_mod.upsertGuardianDetails;

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
          `u18_perform_action integration test requires port ${listen_port} to be free ` +
            `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    const seedUser = async (userId: string, email: string, apikeyId: string, rawKey: string) => {
      await db.insert(user).values({
        id: userId,
        email,
        name: email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const hashed = createHash('sha256').update(rawKey).digest('base64url');
      await db.insert(apikey).values({
        id: apikeyId,
        name: apikeyId,
        key: hashed,
        userId,
        referenceId: userId,
        configId: 'default',
        start: rawKey.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    };

    await seedUser(minor_user_id, minor_email, minor_apikey_id, minor_raw_key);
    await seedUser(adult_user_id, adult_email, adult_apikey_id, adult_raw_key);
    // Target owner + the external-channel adult ward need no apikey — the
    // on-behalf caller authenticates with the network_service api-key below.
    await db.insert(user).values({
      id: target_owner_user_id,
      email: `u18-perform-target-${Date.now()}@signals.local`,
      name: 'target-owner',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(user).values({
      id: adult_ext_user_id,
      email: adult_ext_email,
      name: adult_ext_email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // Network-service acting org (org + service user + service member + apikey),
    // mirroring seed_service_users.ts / on_behalf_of.integration.test.ts.
    await db.insert(organization).values({
      id: ns_org.org_id,
      slug: ns_org.slug,
      name: `${ns_org.slug} (integration network_service)`,
      type: 'network_service',
      createdAt: now,
    });
    await db.insert(user).values({
      id: ns_org.user_id,
      email: ns_org.user_email,
      name: ns_org.slug,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(member).values({
      id: ns_org.member_id,
      organizationId: ns_org.org_id,
      userId: ns_org.user_id,
      role: 'service',
      createdAt: now,
    });
    {
      const hashed = createHash('sha256').update(ns_org.raw_key).digest('base64url');
      await db.insert(apikey).values({
        id: ns_org.apikey_id,
        name: ns_org.slug,
        key: hashed,
        userId: ns_org.user_id,
        referenceId: ns_org.user_id,
        configId: 'default',
        start: ns_org.raw_key.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    await database_pkg.ensureItemPartition(db, NETWORK, SOURCE_DOMAIN);
    await database_pkg.ensureItemPartition(db, NETWORK, TARGET_DOMAIN);
    await database_pkg.ensureActionPartition(db, NETWORK, ACTION_TYPE);
    await database_pkg.ensureActionEventPartition(db, NETWORK, ACTION_TYPE);

    const insertLiveItem = async (
      itemId: string,
      domain: string,
      itemType: string,
      createdBy: string,
    ) => {
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

    await insertLiveItem(minor_item_id, SOURCE_DOMAIN, SOURCE_ITEM_TYPE, minor_user_id);
    await insertLiveItem(adult_item_id, SOURCE_DOMAIN, SOURCE_ITEM_TYPE, adult_user_id);
    await insertLiveItem(adult_ext_item_id, SOURCE_DOMAIN, SOURCE_ITEM_TYPE, adult_ext_user_id);
    await insertLiveItem(target_item_id, TARGET_DOMAIN, TARGET_ITEM_TYPE, target_owner_user_id);

    // Minor ward: clear minor (born 2015) + guardian contact on file so
    // getGuardianContactPlaintext resolves and the OTP can be sent.
    await setWardAge(minor_user_id, 11);
    await upsertGuardianDetails(minor_user_id, {
      guardianName: 'Test Guardian',
      guardianEmail: 'guardian@example.com',
    });

    // External-channel adult ward: a RECORDED adult age (>= 18) so the gate
    // resolves not_required on the external channel (age known, not a minor).
    await setWardAge(adult_ext_user_id, 30);

    // Adult ward: deliberately NO minor_guardian row at all.
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      await db.delete(itemActionsTable).where(
        inArray(itemActionsTable.source_item_owner, [
          minor_user_id,
          adult_user_id,
          adult_ext_user_id,
        ]),
      );
      await db
        .delete(consentRecordTable)
        .where(inArray(consentRecordTable.userId, seeded_user_ids));
      await db
        .delete(itemsTable)
        .where(
          and(
            eq(itemsTable.item_network, NETWORK),
            inArray(itemsTable.item_id, [
              minor_item_id,
              adult_item_id,
              adult_ext_item_id,
              target_item_id,
            ]),
          ),
        );
      await db
        .delete(minorGuardianTable)
        .where(inArray(minorGuardianTable.userId, [minor_user_id, adult_ext_user_id]));
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [minor_apikey_id, adult_apikey_id, ns_org.apikey_id]));
      // Service user + member cascade with the user delete; the org row needs an
      // explicit drop.
      await db.delete(user).where(inArray(user.id, [...seeded_user_ids, ns_org.user_id]));
      await db.delete(organization).where(eq(organization.id, ns_org.org_id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('u18_perform_action integration test cleanup failed:', err);
    }

    const minorScope = guardianScope(minor_user_id, minor_item_id);
    await redis.del(`guardian_otp:code:${minorScope}`);
    await redis.del(`guardian_otp:rl:${minorScope}`);
    await redis.del(`guardian_otp:vrl:${minorScope}`);

    if (app) await app.close();
  });

  it('minor ward without guardian_otp -> per-item GUARDIAN_OTP_REQUIRED, OTP nonce present in Redis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: { 'x-api-key': minor_raw_key, 'content-type': 'application/json' },
      payload: buildPayload(minor_item_id),
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'GUARDIAN_OTP_REQUIRED',
    });

    const scope = guardianScope(minor_user_id, minor_item_id);
    const otp = await redis.get(`guardian_otp:code:${scope}`);
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('minor ward re-calling with the issued guardian_otp -> 201, guardian action consent row written', async () => {
    const scope = guardianScope(minor_user_id, minor_item_id);
    const otp = await redis.get(`guardian_otp:code:${scope}`);
    expect(otp).toMatch(/^\d{6}$/);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: { 'x-api-key': minor_raw_key, 'content-type': 'application/json' },
      payload: buildPayload(minor_item_id, otp!),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({ status: 'success', action_type: ACTION_TYPE });

    const action_id: string = body.results[0].action_id;

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(
        and(
          eq(consentRecordTable.userId, minor_user_id),
          eq(consentRecordTable.itemId, minor_item_id),
          eq(consentRecordTable.level, 'item'),
          eq(consentRecordTable.consentCategory, 'action'),
          eq(consentRecordTable.source, 'guardian'),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe(ACTION_TYPE);
    expect(rows[0].actionStage).toBe('initiate');
    expect(rows[0].actionId).toBe(action_id);
    expect(rows[0].documentVersion).toBe(CONSENT_VERSION);
    expect(rows[0].metadata).toEqual({ variant: 'u18' });

    // The nonce is single-use — consumed by verifyGuardianOtp on success.
    const remaining = await redis.get(`guardian_otp:code:${scope}`);
    expect(remaining).toBeNull();
  });

  it('adult ward (no minor_guardian row) -> 201 directly, no guardian challenge (no adult regression)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: { 'x-api-key': adult_raw_key, 'content-type': 'application/json' },
      payload: buildPayload(adult_item_id),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({ status: 'success', action_type: ACTION_TYPE });

    // No guardian consent row should exist for the adult ward.
    const guardianRows = await db
      .select()
      .from(consentRecordTable)
      .where(
        and(
          eq(consentRecordTable.userId, adult_user_id),
          eq(consentRecordTable.source, 'guardian'),
        ),
      );
    expect(guardianRows).toHaveLength(0);
  });

  // ── #395: EXTERNAL / on-behalf channel (network_service acting org) ──────────

  it('minor ward via EXTERNAL on-behalf -> per-item MINOR_ACTION_CHANNEL_BLOCKED, no action created (#395)', async () => {
    const before = await countActionsForOwner(minor_user_id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': ns_org.raw_key,
        'x-acting-org-id': ns_org.org_id,
        'content-type': 'application/json',
      },
      payload: onBehalfPayload(minor_item_id, minor_user_id),
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'MINOR_ACTION_CHANNEL_BLOCKED',
    });

    // Blocked in the proxy BEFORE the loopback relay to /network/action/perform,
    // so no item_actions row is written for the minor.
    const after = await countActionsForOwner(minor_user_id);
    expect(after).toBe(before);
  });

  it('adult ward via EXTERNAL on-behalf -> 201 (adults unaffected on external channels) (#395)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': ns_org.raw_key,
        'x-acting-org-id': ns_org.org_id,
        'content-type': 'application/json',
      },
      payload: onBehalfPayload(adult_ext_item_id, adult_ext_user_id),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({ status: 'success', action_type: ACTION_TYPE });
  });
});
