/**
 * U18 Phase 5b Task 3 — integration test for the guardian action gate wired
 * into POST /api/v1/action/update-status (the accept hot path).
 *
 * Network: blue_dot   Action: apply   Interaction: seeker -> provider
 *   - blue_dot's `seeker` and `provider` domains are both
 *     `guardian_consent_required` (examples/schemas/blue_dot/network.json).
 *   - `apply`'s seeker->provider interaction has an empty requirement_schema
 *     and reveals_pii_on_status: ["accepted"] — the adult receiver-consent
 *     gate (unrelated to the guardian gate) still requires
 *     `consent: { acknowledged: true, version: 1 }` on every
 *     /action/update-status call that transitions to "accepted", so every
 *     accept payload below includes it (mirrors consent_flow.integration.test.ts).
 *
 * The party who must clear the guardian gate at accept is the ACCEPTING
 * party (the target-item owner — the provider here), per the handler
 * comment in update_action_status.ts. So this suite seeds a MINOR provider
 * (the ward accepting an application) and an ADULT provider, each accepting
 * a distinct `apply` action from the same adult seeker.
 *
 * Flow under test:
 *   1. Seed an adult seeker + a MINOR provider (via direct minor_guardian
 *      repo calls, mirroring production population by the real /u18/dob +
 *      /u18/guardian routes) + an ADULT provider (no minor_guardian row).
 *   2. Create two `apply` actions (seeker -> minor provider, seeker -> adult
 *      provider) via the real /action/perform endpoint (status: created).
 *   3. Minor provider calls /action/update-status to "accepted" with NO
 *      guardian_otp -> per-item GUARDIAN_OTP_REQUIRED in the bulk envelope
 *      (422, since this is a single-item batch that fails), and a 6-digit
 *      OTP nonce exists in Redis at the action scope. This is a per-item
 *      BulkItemFailure (mirrors perform_action.ts, commit bc87fd0), NOT an
 *      HTTP 428 — runBulk is sequential best-effort, so a real HTTP status
 *      here would apply to the whole batch while trailing items kept
 *      running underneath it (see the mixed-batch test below).
 *   4. Read that OTP from Redis, re-call with `guardian_otp` -> 200, status
 *      advances to "accepted", and a guardian-source `action` consent_record
 *      row exists (accept stage).
 *   5. Adult provider accepts the identical way (no guardian_otp) -> 200
 *      directly, no challenge — proves the gate is a no-op for adults (no
 *      regression on today's adult accept path).
 *   6. A mixed batch [minor-accept-no-otp, adult-accept] in a single call ->
 *      both items are reported per-item in the same envelope (207): the
 *      minor item is GUARDIAN_OTP_REQUIRED and does NOT commit, the adult
 *      item commits normally — proving a blocked guardian item can no
 *      longer hide a trailing item's PII-revealing commit behind a
 *      whole-batch HTTP status.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm --filter api test:integration src/routes/v1/action/__tests__/u18_update_action_status.integration.test.ts
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
const SEEKER_DOMAIN = 'seeker';
const SEEKER_ITEM_TYPE = 'profile_1.0';
const PROVIDER_DOMAIN = 'provider';
const PROVIDER_ITEM_TYPE = 'job_posting_1.0';
const ACTION_TYPE = 'apply';
const CONSENT_VERSION = 1; // apply.initiate/accept.current_version in blue_dot consent.json

describeIf(`U18 guardian action gate — POST /action/update-status (${NETWORK}/${ACTION_TYPE})${
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
  let upsertBirthMonth: typeof import('@/services/minor_guardian_repo').upsertBirthMonth;
  let upsertGuardianDetails: typeof import('@/services/minor_guardian_repo').upsertGuardianDetails;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  // Adult seeker — initiates both applications.
  const seeker_user_id = `usr_${randomUUID()}`;
  const seeker_apikey_id = `key_${randomUUID()}`;
  const seeker_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const seeker_email = `u18-accept-seeker-${Date.now()}@signals.local`;
  const seeker_item_id = randomUUID();

  // Provider (minor) — the accepting ward, has guardian details on file.
  const minor_provider_user_id = `usr_${randomUUID()}`;
  const minor_provider_apikey_id = `key_${randomUUID()}`;
  const minor_provider_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const minor_provider_email = `u18-accept-minor-${Date.now()}@signals.local`;
  const minor_provider_item_id = randomUUID();

  // Provider (adult) — no minor_guardian row at all.
  const adult_provider_user_id = `usr_${randomUUID()}`;
  const adult_provider_apikey_id = `key_${randomUUID()}`;
  const adult_provider_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const adult_provider_email = `u18-accept-adult-${Date.now()}@signals.local`;
  const adult_provider_item_id = randomUUID();

  const seeded_user_ids = [seeker_user_id, minor_provider_user_id, adult_provider_user_id];

  let minor_action_id: string;
  let adult_action_id: string;

  const guardianScope = (wardUserId: string, sourceItemId: string, targetItemId: string) =>
    `guardian_action:${wardUserId}:${ACTION_TYPE}:${sourceItemId}:${targetItemId}`;

  const performApply = async (apikey: string, sourceItemId: string, targetItemId: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: { 'x-api-key': apikey, 'content-type': 'application/json' },
      payload: [
        {
          action_type: ACTION_TYPE,
          source_item: {
            item_network: NETWORK,
            item_domain: SEEKER_DOMAIN,
            item_type: SEEKER_ITEM_TYPE,
            item_id: sourceItemId,
          },
          target_item: {
            item_network: NETWORK,
            item_domain: PROVIDER_DOMAIN,
            item_type: PROVIDER_ITEM_TYPE,
            item_id: targetItemId,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          consent: { acknowledged: true, version: CONSENT_VERSION },
        },
      ],
    });
    if (res.statusCode !== 201) {
      throw new Error(`seed perform failed: ${res.statusCode} ${res.body}`);
    }
    return res.json().results[0].action_id as string;
  };

  const acceptPayload = (actionId: string, guardian_otp?: string) => [
    {
      action_id: actionId,
      action_status: 'accepted',
      consent: { acknowledged: true, version: CONSENT_VERSION },
      ...(guardian_otp ? { guardian_otp } : {}),
    },
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
    upsertBirthMonth = minor_guardian_repo_mod.upsertBirthMonth;
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
          `u18_update_action_status integration test requires port ${listen_port} to be free ` +
            `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, apikey } = authSchema;
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

    await seedUser(seeker_user_id, seeker_email, seeker_apikey_id, seeker_raw_key);
    await seedUser(
      minor_provider_user_id,
      minor_provider_email,
      minor_provider_apikey_id,
      minor_provider_raw_key,
    );
    await seedUser(
      adult_provider_user_id,
      adult_provider_email,
      adult_provider_apikey_id,
      adult_provider_raw_key,
    );

    await database_pkg.ensureItemPartition(db, NETWORK, SEEKER_DOMAIN);
    await database_pkg.ensureItemPartition(db, NETWORK, PROVIDER_DOMAIN);
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

    await insertLiveItem(seeker_item_id, SEEKER_DOMAIN, SEEKER_ITEM_TYPE, seeker_user_id);
    await insertLiveItem(
      minor_provider_item_id,
      PROVIDER_DOMAIN,
      PROVIDER_ITEM_TYPE,
      minor_provider_user_id,
    );
    await insertLiveItem(
      adult_provider_item_id,
      PROVIDER_DOMAIN,
      PROVIDER_ITEM_TYPE,
      adult_provider_user_id,
    );

    // Minor provider: clear minor (born 2015) + guardian contact on file so
    // getGuardianContactPlaintext resolves and the OTP can be sent.
    await upsertBirthMonth(minor_provider_user_id, 2015, 6);
    await upsertGuardianDetails(minor_provider_user_id, {
      guardianName: 'Test Guardian',
      guardianEmail: 'guardian-accept@example.com',
    });

    // Adult provider: deliberately NO minor_guardian row at all.

    // Seed one `apply` action per provider (seeker -> provider), status "created".
    minor_action_id = await performApply(seeker_raw_key, seeker_item_id, minor_provider_item_id);
    adult_action_id = await performApply(seeker_raw_key, seeker_item_id, adult_provider_item_id);
  });

  afterAll(async () => {
    const { user, apikey } = authSchema;
    try {
      await db
        .delete(itemActionsTable)
        .where(
          inArray(itemActionsTable.target_item_owner, [
            minor_provider_user_id,
            adult_provider_user_id,
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
              seeker_item_id,
              minor_provider_item_id,
              adult_provider_item_id,
            ]),
          ),
        );
      await db
        .delete(minorGuardianTable)
        .where(eq(minorGuardianTable.userId, minor_provider_user_id));
      await db
        .delete(apikey)
        .where(
          inArray(apikey.id, [
            seeker_apikey_id,
            minor_provider_apikey_id,
            adult_provider_apikey_id,
          ]),
        );
      await db.delete(user).where(inArray(user.id, seeded_user_ids));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('u18_update_action_status integration test cleanup failed:', err);
    }

    const minorScope = guardianScope(
      minor_provider_user_id,
      minor_provider_item_id,
      seeker_item_id,
    );
    await redis.del(`guardian_otp:code:${minorScope}`);
    await redis.del(`guardian_otp:rl:${minorScope}`);
    await redis.del(`guardian_otp:vrl:${minorScope}`);

    if (app) await app.close();
  });

  it('minor provider accepting without guardian_otp -> per-item GUARDIAN_OTP_REQUIRED (not an HTTP 428), OTP nonce present in Redis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: { 'x-api-key': minor_provider_raw_key, 'content-type': 'application/json' },
      payload: acceptPayload(minor_action_id),
    });

    // A single-item batch that fails is reported as 422 with a per-item
    // error in `results[]` — the same bulk envelope every other error in
    // this handler uses — never a bare HTTP 428 (Fix 1: the guardian gate
    // now throws a per-item BulkItemFailure instead of calling
    // reply.code(428).send(...) mid-loop).
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 0, failed: 1 });
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'GUARDIAN_OTP_REQUIRED',
    });

    const scope = guardianScope(minor_provider_user_id, minor_provider_item_id, seeker_item_id);
    const otp = await redis.get(`guardian_otp:code:${scope}`);
    expect(otp).toMatch(/^\d{6}$/);

    // The action must not have advanced.
    const [row] = await db
      .select({ action_status: itemActionsTable.action_status, update_count: itemActionsTable.update_count })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, minor_action_id))
      .limit(1);
    expect(row).toMatchObject({ action_status: 'created', update_count: 0 });
  });

  it('minor provider re-calling with the issued guardian_otp -> 200, guardian accept consent row written, status advanced', async () => {
    const scope = guardianScope(minor_provider_user_id, minor_provider_item_id, seeker_item_id);
    const otp = await redis.get(`guardian_otp:code:${scope}`);
    expect(otp).toMatch(/^\d{6}$/);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: { 'x-api-key': minor_provider_raw_key, 'content-type': 'application/json' },
      payload: acceptPayload(minor_action_id, otp!),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({
      status: 'success',
      action_id: minor_action_id,
      action_status: 'accepted',
    });

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(
        and(
          eq(consentRecordTable.userId, minor_provider_user_id),
          eq(consentRecordTable.itemId, minor_provider_item_id),
          eq(consentRecordTable.level, 'item'),
          eq(consentRecordTable.consentCategory, 'action'),
          eq(consentRecordTable.source, 'guardian'),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe(ACTION_TYPE);
    expect(rows[0].actionStage).toBe('accept');
    expect(rows[0].actionId).toBe(minor_action_id);
    expect(rows[0].documentVersion).toBe(CONSENT_VERSION);
    expect(rows[0].metadata).toEqual({ variant: 'u18' });

    // The adult receiver-consent row (source: 'action') is written alongside it.
    const adultRows = await db
      .select()
      .from(consentRecordTable)
      .where(
        and(
          eq(consentRecordTable.actionId, minor_action_id),
          eq(consentRecordTable.source, 'action'),
          eq(consentRecordTable.actionStage, 'accept'),
        ),
      );
    expect(adultRows).toHaveLength(1);

    // The nonce is single-use — consumed by verifyGuardianOtp on success.
    const remaining = await redis.get(`guardian_otp:code:${scope}`);
    expect(remaining).toBeNull();
  });

  it('adult provider (no minor_guardian row) accepting -> 200 directly, no guardian challenge (no adult regression)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: { 'x-api-key': adult_provider_raw_key, 'content-type': 'application/json' },
      payload: acceptPayload(adult_action_id),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({
      status: 'success',
      action_id: adult_action_id,
      action_status: 'accepted',
    });

    // No guardian consent row should exist for the adult provider.
    const guardianRows = await db
      .select()
      .from(consentRecordTable)
      .where(
        and(
          eq(consentRecordTable.userId, adult_provider_user_id),
          eq(consentRecordTable.source, 'guardian'),
        ),
      );
    expect(guardianRows).toHaveLength(0);
  });

  it('mixed batch [guardian-blocked accept, non-gated reject] in ONE call -> each item reported per-item; the trailing item still commits and is not swallowed by a batch-wide HTTP status', async () => {
    // /action/update-status is self-acted only: one HTTP call has exactly
    // one caller identity (the apikey), so a literal mix of a minor's own
    // item and a DIFFERENT adult's own item cannot be constructed in one
    // call — each item's `target_item_owner` must equal that single
    // caller. This test instead reproduces the same hazard class the
    // Phase 5b review flagged, using two items owned by the same (minor)
    // caller: one item transitions to "accepted" (reveals_pii_on_status,
    // guardian-gated, no guardian_otp supplied -> blocked) and the other
    // transitions to "rejected" (not in reveals_pii_on_status, so neither
    // the adult consent gate nor the guardian gate apply -> commits
    // normally). Before Fix 1, a blocked item's mid-loop
    // reply.code(428).send(...) + `reply.sent` guard meant a LATER item in
    // the same runBulk loop could still run and commit while the whole
    // call answered with a blanket 428 that never surfaced that commit to
    // the caller. After the fix, both items are reported in the same
    // per-item results array and the aggregate status (207) reflects the
    // mix honestly.
    const gated_action_id = await performApply(
      seeker_raw_key,
      seeker_item_id,
      minor_provider_item_id,
    );
    const other_action_id = await performApply(
      seeker_raw_key,
      seeker_item_id,
      minor_provider_item_id,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: { 'x-api-key': minor_provider_raw_key, 'content-type': 'application/json' },
      payload: [
        {
          action_id: gated_action_id,
          action_status: 'accepted',
          consent: { acknowledged: true, version: CONSENT_VERSION },
          // no guardian_otp -> blocked
        },
        {
          action_id: other_action_id,
          action_status: 'rejected',
        },
      ],
    });

    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(body.results[0]).toMatchObject({
      index: 0,
      status: 'error',
      error: 'GUARDIAN_OTP_REQUIRED',
    });
    expect(body.results[1]).toMatchObject({
      index: 1,
      status: 'success',
      action_id: other_action_id,
      action_status: 'rejected',
    });

    // The blocked item must not have advanced.
    const [gatedRow] = await db
      .select({
        action_status: itemActionsTable.action_status,
        update_count: itemActionsTable.update_count,
      })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, gated_action_id))
      .limit(1);
    expect(gatedRow).toMatchObject({ action_status: 'created', update_count: 0 });

    // The other item DID commit — the trailing item is no longer hidden
    // behind a batch-wide HTTP status.
    const [otherRow] = await db
      .select({
        action_status: itemActionsTable.action_status,
        update_count: itemActionsTable.update_count,
      })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, other_action_id))
      .limit(1);
    expect(otherRow).toMatchObject({ action_status: 'rejected', update_count: 1 });
  });
});
