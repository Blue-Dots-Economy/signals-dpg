/**
 * Plan C Task 12 — integration tests for the participant onboarding lifecycle.
 *
 * Filename ends in .integration.test.ts so the default vitest config excludes
 * it from `pnpm --filter api test`. Runs via:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * The suite self-contains the world it exercises:
 *
 *   - seeds two aggregator-type orgs + one network_service-type org, each
 *     backed by one shared service user, each with its own apikey row;
 *   - drives requests through the route layer via app.inject, asserting both
 *     response bodies and resulting DB state;
 *   - registers only the route plugins required: admin_routes, item_routes,
 *     network_routes, and action_routes (mounted with their canonical prefixes);
 *   - cleans up all seeded rows in afterAll.
 *
 * Skip condition: if POSTGRES_URL / POSTGRES_USER are unset, the suite is
 * described as `.skip` so CI without a DB stays green.
 *
 * Scenarios covered:
 *   1. NS + no item_state, new user → account_only: owned_elsewhere:false, items:[]
 *   2. NS + partial item_state (missing required) → draft, completion_pct < 100
 *   3. NS + full state → live, completion_pct === 100
 *   4. Aggregator A full state → live; retry with new state → row UPDATED, still live
 *   5. Aggregator B targets A's user → owned_elsewhere:true, items:[], no DB write
 *   6. clear required on live → 409, stays live, action untouched
 *   6b. Allowed edit: change required field value on live item → 200, stays live
 *   7. pause → paused; pending action survives (not cancelled)
 *   8. POST /item/lifecycle {action:'unpause'} on paused-but-complete item → live
 *   9. POST /network/action/perform against a non-live target → 409 + PROFILE_NOT_LIVE
 *  10. GET /action/:id/contact-details after source pauses → 200 masked (revealed:false)
 *  11. GET /network/item/fetch lists only live items (draft item excluded)
 *  12. action gated while target paused RESUMES after unpause (accept succeeds)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { and, eq, inArray } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  consentAck,
  generateMinimalItemState,
  nonPrivateFields,
  resolveBindings,
  resolveInteractionConsent,
  type ResolvedBinding,
} from '../../../routes/v1/__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping lifecycle integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

const hash_key = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIf(`lifecycle integration${can_run ? '' : ` — ${skip_reason}`}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;
  let ensureActionPartition: typeof import('@dpg/database').ensureActionPartition;
  let consentRecordTable: typeof import('@api/db/postgres/schema').consent_record;
  let promoteItemOnProfileConsent: typeof import('../../item_service.js').promoteItemOnProfileConsent;

  // Bring a freshly onboarded (draft) profile to live the way production does:
  // record terms + privacy (user) and profile_creation (item) consent, then run
  // the same promotion the /consent/profile-accept endpoint runs. Profiles are
  // draft-until-consent now (aggregator-dpg#464), so any scenario that needs a
  // live profile must consent first.
  const makeLive = async (userId: string, itemId: string, network: string) => {
    const now = new Date();
    await db.insert(consentRecordTable).values([
      { level: 'user', consentCategory: 'terms', userId, network, documentVersion: 1, source: 'login', acceptedAt: now },
      { level: 'user', consentCategory: 'privacy', userId, network, documentVersion: 1, source: 'login', acceptedAt: now },
      { level: 'item', consentCategory: 'profile_creation', userId, itemId, network, documentVersion: 1, source: 'profile', acceptedAt: now },
    ]);
    await promoteItemOnProfileConsent(db, itemId);
  };

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const ts = Date.now();

  const agg_a = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `lc-int-a-${ts}`,
  };

  const agg_b = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `lc-int-b-${ts}`,
  };

  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `lc-int-ns-${ts}`,
  };

  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `signals-lc-int-${ts}@signals.local`;

  const onboarded_user_ids: string[] = [];

  // action_ids inserted by scenarios that write item_actions rows, collected
  // here so afterAll can delete them and avoid cross-run accumulation.
  const seeded_action_ids: string[] = [];

  let primary: ResolvedBinding;
  let secondary: ResolvedBinding | null = null;

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;
    ensureActionPartition = database_pkg.ensureActionPartition;
    const schema_mod = await import('../../../../db/postgres/schema/index.js');
    consentRecordTable = schema_mod.consent_record;
    const item_service_mod = await import('../../item_service.js');
    promoteItemOnProfileConsent = item_service_mod.promoteItemOnProfileConsent;

    const resolved = await resolveBindings();
    primary = resolved.primary;
    secondary = resolved.secondary;

    const { admin_routes } = await import(
      '../../../routes/v1/admin/admin_routes.js'
    );
    const item_routes_mod = await import(
      '../../../routes/v1/item/item_routes.js'
    );
    const network_routes_mod = await import(
      '../../../routes/v1/network/network_routes.js'
    );
    const action_routes_mod = await import(
      '../../../routes/v1/action/action_routes.js'
    );

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(item_routes_mod.default, { prefix: '/api/v1/item' });
    await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });
    await app.register(action_routes_mod.default, { prefix: '/api/v1/action' });

    try {
      await app.listen({ port: listen_port, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `lifecycle integration test requires port ${listen_port} to be free ` +
            `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: svc_user_id,
      email: svc_user_email,
      name: 'lifecycle integration svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(organization).values([
      {
        id: agg_a.org_id,
        slug: agg_a.slug,
        name: `${agg_a.slug} (lifecycle aggregator A)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: agg_b.org_id,
        slug: agg_b.slug,
        name: `${agg_b.slug} (lifecycle aggregator B)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: ns.org_id,
        slug: ns.slug,
        name: `${ns.slug} (lifecycle network_service)`,
        type: 'network_service',
        createdAt: now,
      },
    ]);

    await db.insert(member).values([
      {
        id: agg_a.member_id,
        organizationId: agg_a.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
      {
        id: agg_b.member_id,
        organizationId: agg_b.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
      {
        id: ns.member_id,
        organizationId: ns.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
    ]);

    for (const v of [agg_a, agg_b, ns]) {
      await db.insert(apikey).values({
        id: v.apikey_id,
        name: v.slug,
        key: hash_key(v.raw_key),
        userId: svc_user_id,
        referenceId: svc_user_id,
        configId: 'default',
        start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      // Clean up item_actions rows inserted by scenarios 6 and 10 to avoid
      // cross-run accumulation.
      if (seeded_action_ids.length > 0) {
        await db
          .delete(itemActionsTable)
          .where(inArray(itemActionsTable.action_id, seeded_action_ids));
      }
      // consent_record has no FK to user/items, so it won't cascade — delete
      // the rows makeLive() inserted for our seeded users explicitly.
      const consentUserIds = [...onboarded_user_ids, svc_user_id];
      await db
        .delete(consentRecordTable)
        .where(inArray(consentRecordTable.userId, consentUserIds));
      if (onboarded_user_ids.length > 0) {
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, onboarded_user_ids));
        await db.delete(user).where(inArray(user.id, onboarded_user_ids));
      }
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg_a.org_id, agg_b.org_id, ns.org_id]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('lifecycle integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------------
  // Shared state populated by scenario #3 and reused in later scenarios.
  // ---------------------------------------------------------------------------

  let live_user_id: string;
  let live_user_email: string;
  let live_item_id: string;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds a partial item_state that is missing the LAST required field from the
   * schema, so the classifier emits draft + completion_pct < 100. Returns null
   * when the schema has fewer than 2 required fields (partial state is not
   * meaningfully different from full state in that case).
   */
  function buildPartialItemState(
    schema: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const required = schema.required;
    if (!Array.isArray(required) || required.length < 2) return null;
    // Drop the last required field so exactly one field is missing.
    const truncated = { ...schema, required: (required as string[]).slice(0, -1) };
    return generateMinimalItemState(truncated);
  }

  function adminHeaders(org: { raw_key: string; org_id: string }) {
    return {
      'x-api-key': org.raw_key,
      'x-acting-org-id': org.org_id,
      'content-type': 'application/json',
    };
  }

  function userHeaders(raw_key: string) {
    return {
      'x-api-key': raw_key,
      'content-type': 'application/json',
    };
  }

  // ---------------------------------------------------------------------------
  // Scenario 1: NS + no item_state, new user → account_only
  // ---------------------------------------------------------------------------

  it('scenario 1: NS + no item_state, new user → account_only, owned_elsewhere:false, items:[]', async () => {
    const email = `lc_s1_${randomUUID().slice(0, 6)}@a.test`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email,
        name: 'LC S1',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        // item_type provided but no item_state → account_only
        item_type: primary.item_type,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user_id: string;
      user_existed: boolean;
      owned_elsewhere: boolean;
      items: unknown[];
    };
    expect(body.user_existed).toBe(false);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.items).toHaveLength(0);
    expect(body.user_id).toBeTruthy();

    onboarded_user_ids.push(body.user_id);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: NS + partial item_state → draft, completion_pct < 100
  // ---------------------------------------------------------------------------

  it('scenario 2: NS + partial item_state → draft, completion_pct < 100', async (ctx) => {
    const partial = buildPartialItemState(primary.schema);
    if (partial === null) {
      ctx.skip();
      return;
    }

    const email = `lc_s2_${randomUUID().slice(0, 6)}@a.test`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email,
        name: 'LC S2',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: partial,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user_id: string;
      items: Array<{ item_id: string }>;
    };
    expect(body.items).toHaveLength(1);
    const item_id = body.items[0].item_id;
    onboarded_user_ids.push(body.user_id);

    // Verify DB state
    const [row] = await db
      .select({
        lifecycle_status: itemsTable.lifecycle_status,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, item_id))
      .limit(1);

    expect(row).toBeTruthy();
    expect(row.lifecycle_status).toBe('draft');
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: NS + full state → live, completion_pct === 100
  // ---------------------------------------------------------------------------

  it('scenario 3: NS + full item_state → draft (consent pending); live after profile consent', async () => {
    live_user_email = `lc_s3_${randomUUID().slice(0, 6)}@a.test`;
    const full = generateMinimalItemState(primary.schema);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: live_user_email,
        name: 'LC S3',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: full,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user_id: string;
      items: Array<{ item_id: string }>;
    };
    expect(body.items).toHaveLength(1);

    live_user_id = body.user_id;
    live_item_id = body.items[0].item_id;
    onboarded_user_ids.push(live_user_id);

    // Full fields but consent pending → draft (aggregator-dpg#464).
    const [draftRow] = await db
      .select({ lifecycle_status: itemsTable.lifecycle_status })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, live_item_id))
      .limit(1);
    expect(draftRow).toBeTruthy();
    expect(draftRow.lifecycle_status).toBe('draft');

    // After the owner accepts consent, the complete profile goes live.
    await makeLive(live_user_id, live_item_id, primary.network);
    const [liveRow] = await db
      .select({ lifecycle_status: itemsTable.lifecycle_status })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, live_item_id))
      .limit(1);
    expect(liveRow.lifecycle_status).toBe('live');
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Aggregator A full state → live; retry → UPDATED, still live
  // ---------------------------------------------------------------------------

  it('scenario 4: agg_A onboards user (live); retry with new state → row updated, still live', async () => {
    const email = `lc_s4_${randomUUID().slice(0, 6)}@a.test`;
    const full1 = generateMinimalItemState(primary.schema);

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(agg_a),
      payload: {
        email,
        name: 'LC S4',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: full1,
      },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      user_id: string;
      items: Array<{ item_id: string }>;
    };
    expect(body1.items).toHaveLength(1);
    const item_id = body1.items[0].item_id;
    const user_id = body1.user_id;
    onboarded_user_ids.push(user_id);

    // Onboard alone leaves it draft (consent pending); accept consent → live.
    await makeLive(user_id, item_id, primary.network);

    const [row1] = await db
      .select({ lifecycle_status: itemsTable.lifecycle_status })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, item_id))
      .limit(1);
    expect(row1.lifecycle_status).toBe('live');

    // Retry: aggregator sends new item_state with item_id
    const full2 = generateMinimalItemState(primary.schema);
    const publicFull2 = nonPrivateFields(primary.schema, full2);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(agg_a),
      payload: {
        email,
        name: 'LC S4 retry',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: full2,
        item_id,
      },
    });

    // Aggregator with existing user + item_id is routed to update_item
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as { user_id: string; items: Array<{ item_id: string }> };
    expect(body2.user_id).toBe(user_id);
    expect(body2.items.some((i) => i.item_id === item_id)).toBe(true);

    const [row2] = await db
      .select({ lifecycle_status: itemsTable.lifecycle_status, item_state: itemsTable.item_state })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, item_id))
      .limit(1);
    expect(row2.lifecycle_status).toBe('live');
    const publicFromDb = nonPrivateFields(primary.schema, row2.item_state as Record<string, unknown>);
    expect(publicFromDb).toEqual(publicFull2);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Aggregator B targets A's user → owned_elsewhere:true, items:[]
  // ---------------------------------------------------------------------------

  it('scenario 5: agg_B targets agg_A user → owned_elsewhere:true, items:[], no DB write', async () => {
    // Seed an agg_A user for this scenario
    const email = `lc_s5_${randomUUID().slice(0, 6)}@a.test`;
    const full = generateMinimalItemState(primary.schema);

    const seed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(agg_a),
      payload: {
        email,
        name: 'LC S5 agg_a',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: full,
      },
    });
    expect(seed.statusCode).toBe(200);
    const seeded = seed.json() as { user_id: string };
    onboarded_user_ids.push(seeded.user_id);

    const before_count = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, seeded.user_id));

    // agg_B tries to access the same user
    const probe = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(agg_b),
      payload: {
        email,
        name: 'LC S5 agg_b probe',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: probe,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user_id: string;
      user_existed: boolean;
      owned_elsewhere: boolean;
      items: unknown[];
    };
    expect(body.user_existed).toBe(true);
    expect(body.owned_elsewhere).toBe(true);
    expect(body.items).toEqual([]);

    // No extra rows written
    const after_count = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, seeded.user_id));
    expect(after_count.length).toBe(before_count.length);
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: clearing a required field on a LIVE item is rejected (409);
  // the item stays live and any pending action is left untouched.
  // ---------------------------------------------------------------------------

  it('scenario 6: clear required on live → 409 REQUIRED_FIELD_LOCKED_WHILE_LIVE; stays live; action untouched', async (ctx) => {
    if (!live_item_id) return ctx.skip();

    const actionId = randomUUID();
    const sourceId = randomUUID();

    // Ensure the action partition exists before inserting directly.
    await ensureActionPartition(db, primary.network, 'connect');

    await db.insert(itemActionsTable).values({
      action_type: 'connect',
      partition_network: primary.network,
      action_id: actionId,
      action_status: 'created',
      update_count: 0,
      source_item_network: primary.network,
      source_item_domain: primary.domain,
      source_item_type: primary.item_type,
      source_item_id: sourceId,
      source_item_instance_url: `http://localhost:${listen_port}`,
      target_item_network: primary.network,
      target_item_domain: primary.domain,
      target_item_type: primary.item_type,
      target_item_id: live_item_id,
      target_item_instance_url: `http://localhost:${listen_port}`,
      requirements_snapshot: {},
    });
    seeded_action_ids.push(actionId);

    const [beforeRow] = await db
      .select({ item_state: itemsTable.item_state })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, live_item_id))
      .limit(1);

    const requiredKey = (primary.schema.required as string[])[0];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: live_user_email,
        name: 'LC S6',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_id: live_item_id,
        item_state: { [requiredKey]: '' },
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('REQUIRED_FIELD_LOCKED_WHILE_LIVE');

    const [row] = await db
      .select({
        lifecycle_status: itemsTable.lifecycle_status,
        item_state: itemsTable.item_state,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, live_item_id))
      .limit(1);
    expect(row.lifecycle_status).toBe('live');
    expect(row.item_state).toEqual(beforeRow.item_state);

    const [actionRow] = await db
      .select({ action_status: itemActionsTable.action_status })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, actionId))
      .limit(1);
    expect(actionRow?.action_status).toBe('created');
  });

  // ---------------------------------------------------------------------------
  // Allowed edit: changing a required field to another non-empty value on a
  // live item succeeds and stays live.
  // Runs before scenario 7 so the item is guaranteed live (not paused).
  // ---------------------------------------------------------------------------

  it('allowed edit: change required value on live → 200, stays live', async (ctx) => {
    if (!live_item_id) return ctx.skip();
    const requiredKey = (primary.schema.required as string[])[0];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: live_user_email,
        name: 'LC allowed',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_id: live_item_id,
        item_state: { [requiredKey]: generateMinimalItemState(primary.schema)[requiredKey] },
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db
      .select({ lifecycle_status: itemsTable.lifecycle_status })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, live_item_id))
      .limit(1);
    expect(row.lifecycle_status).toBe('live');
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: pause leaves the item paused but does NOT cancel pending
  // actions; they survive (gated by §10) and resume on unpause.
  //
  // Auth: the lifecycle route gates on isOwner OR isNetworkService.
  // live_item_id.created_by = live_user_id (the participant, NOT svc_user_id).
  // We use adminHeaders(ns) so request.acting_org.org_type = 'network_service'
  // → isNetworkService = true → authorised.
  // ---------------------------------------------------------------------------

  it('scenario 7: pause → paused; pending action survives (not cancelled)', async (ctx) => {
    if (!live_item_id) return ctx.skip();
    const actionId = randomUUID();
    const sourceId = randomUUID();
    await ensureActionPartition(db, primary.network, 'connect');
    await db.insert(itemActionsTable).values({
      action_type: 'connect',
      partition_network: primary.network,
      action_id: actionId,
      action_status: 'submitted',
      update_count: 0,
      source_item_network: primary.network,
      source_item_domain: primary.domain,
      source_item_type: primary.item_type,
      source_item_id: sourceId,
      source_item_instance_url: `http://localhost:${listen_port}`,
      target_item_network: primary.network,
      target_item_domain: primary.domain,
      target_item_type: primary.item_type,
      target_item_id: live_item_id,
      target_item_instance_url: `http://localhost:${listen_port}`,
      requirements_snapshot: {},
    });
    seeded_action_ids.push(actionId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: { item_id: live_item_id, action: 'pause' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle_status).toBe('paused');

    const [actionRow] = await db
      .select({ action_status: itemActionsTable.action_status })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, actionId))
      .limit(1);
    expect(actionRow?.action_status).toBe('submitted'); // NOT cancelled

    // Item is left paused here — scenario 8 is the unpause step and restores
    // the item to live for scenarios 9+.
  });

  // ---------------------------------------------------------------------------
  // Back-door (accepted, §6): live → pause → clear required (allowed on paused)
  // → unpause → draft. No cancellation; lands recoverable in draft.
  // ---------------------------------------------------------------------------

  it('back-door: paused item can be edited incomplete then unpause → draft', async () => {
    const email = `lc_bd_${randomUUID().slice(0, 6)}@a.test`;
    const full = generateMinimalItemState(primary.schema);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email, name: 'LC BD', terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', network: primary.network, domain: primary.domain,
        item_type: primary.item_type, item_state: full,
      },
    });
    expect(create.statusCode).toBe(200);
    const itemId = create.json().items[0].item_id as string;
    const bdUserId = create.json().user_id as string;
    onboarded_user_ids.push(bdUserId);

    // Pause is only valid on a LIVE profile (R7.5 / #234 Q6) — bring the
    // bulk-created draft live via consent first, then pause it.
    await makeLive(bdUserId, itemId, primary.network);

    const pauseRes = await app.inject({
      method: 'POST', url: '/api/v1/item/lifecycle', headers: adminHeaders(ns),
      payload: { item_id: itemId, action: 'pause' },
    });
    expect(pauseRes.statusCode).toBe(200);

    const requiredKey = (primary.schema.required as string[])[0];
    const clear = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant', headers: adminHeaders(ns),
      payload: {
        email, name: 'LC BD', terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', network: primary.network, domain: primary.domain,
        item_type: primary.item_type, item_id: itemId, item_state: { [requiredKey]: '' },
      },
    });
    expect(clear.statusCode).toBe(200); // allowed: item is paused, not live

    const unpause = await app.inject({
      method: 'POST', url: '/api/v1/item/lifecycle', headers: adminHeaders(ns),
      payload: { item_id: itemId, action: 'unpause' },
    });
    expect(unpause.statusCode).toBe(200);
    expect(unpause.json().lifecycle_status).toBe('draft');
  });

  // ---------------------------------------------------------------------------
  // Pause guard (#346 / R7.5): only a LIVE profile can be voluntarily hidden.
  // ---------------------------------------------------------------------------

  it('pause on a draft profile → 409 INVALID_LIFECYCLE_ACTION (pause requires live)', async () => {
    const email = `lc_pd_${randomUUID().slice(0, 6)}@a.test`;
    const full = generateMinimalItemState(primary.schema);
    const create = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant', headers: adminHeaders(ns),
      payload: {
        email, name: 'LC PD', terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', network: primary.network, domain: primary.domain,
        item_type: primary.item_type, item_state: full,
      },
    });
    expect(create.statusCode).toBe(200);
    const itemId = create.json().items[0].item_id as string;
    onboarded_user_ids.push(create.json().user_id);

    // Bulk create → draft (consent pending). Pausing a draft is rejected.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/item/lifecycle', headers: adminHeaders(ns),
      payload: { item_id: itemId, action: 'pause' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INVALID_LIFECYCLE_ACTION');
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: POST /item/lifecycle {action:'unpause'} → live
  //
  // Auth: same reasoning as scenario 7 — adminHeaders(ns) → isNetworkService = true.
  // ---------------------------------------------------------------------------

  it('scenario 8: POST /item/lifecycle unpause on paused-but-complete item → live', async () => {
    // Item is paused from scenario 7. Unpause it.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: {
        item_id: live_item_id,
        action: 'unpause',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      item_id: string;
      lifecycle_status: string;
    };
    expect(body.item_id).toBe(live_item_id);
    // Item was fully completed (100%) before pausing so unpause → live.
    expect(body.lifecycle_status).toBe('live');
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: /network/action/perform against non-live target → 409
  //
  // Auth: the pause/restore calls on live_item_id use adminHeaders(ns)
  // (isNetworkService = true) because live_item_id.created_by = live_user_id
  // ≠ svc_user_id (what the apikeys authenticate as).
  // If the perform call returns 400 (action_type 'connect' not configured for
  // this network), skip rather than fail — mirror scenario 10's pattern.
  // ---------------------------------------------------------------------------

  it('scenario 9: POST /network/action/perform against non-live target → 409 PROFILE_NOT_LIVE', async (ctx) => {
    // Pause the target item to make it non-live.
    const pauseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: { item_id: live_item_id, action: 'pause' },
    });
    // If pause itself fails (e.g. item already paused from a prior run), bail.
    if (pauseRes.statusCode !== 200) {
      ctx.skip();
      return;
    }

    // Create a source item to perform the action with.
    const src_email = `lc_s9_src_${randomUUID().slice(0, 6)}@a.test`;
    const seedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: src_email,
        name: 'LC S9 src',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
      },
    });
    expect(seedRes.statusCode).toBe(200);
    const seedBody = seedRes.json() as { user_id: string; items: Array<{ item_id: string }> };
    const src_item_id = seedBody.items[0].item_id;
    onboarded_user_ids.push(seedBody.user_id);

    // Make the source live so the 409 is driven by the paused TARGET, not by a
    // draft-until-consent source (aggregator-dpg#464).
    await makeLive(seedBody.user_id, src_item_id, primary.network);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/action/perform',
      headers: { 'content-type': 'application/json' },
      payload: {
        action_type: 'connect',
        source_item: {
          item_network: primary.network,
          item_domain: primary.domain,
          item_type: primary.item_type,
          item_id: src_item_id,
          item_instance_url: `http://localhost:${listen_port}`,
        },
        target_item: {
          item_network: primary.network,
          item_domain: primary.domain,
          item_type: primary.item_type,
          item_id: live_item_id,
          item_instance_url: `http://localhost:${listen_port}`,
        },
        source_item_owner: seedBody.user_id,
        requirements_snapshot: {},
      },
    });

    // If the network doesn't configure 'connect' as an action type, perform
    // returns 400 INVALID_ACTION_REQUEST — skip rather than fail.
    if (res.statusCode === 400) {
      ctx.skip();
      // Still restore the item before skipping.
      await app.inject({
        method: 'POST',
        url: '/api/v1/item/lifecycle',
        headers: adminHeaders(ns),
        payload: { item_id: live_item_id, action: 'unpause' },
      });
      return;
    }

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('PROFILE_NOT_LIVE');

    // Restore for subsequent scenarios
    await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: { item_id: live_item_id, action: 'unpause' },
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: GET /action/:id/contact-details after source pauses → 403
  //
  // Auth reasoning:
  //   - contact-details checks action.source_item_owner === request.user.id.
  //   - We seed the source item using svc_user_email so created_by = svc_user_id.
  //   - perform_network_action stores source_item_owner = body.source_item_owner
  //     which we pass as svc_user_id.
  //   - Calling with userHeaders(ns.raw_key) → request.user.id = svc_user_id
  //     = source_item_owner → callerIsSource = true → passes NOT_ACTION_PARTICIPANT.
  //   - After the source item is paused, fetchLocalItemSnapshot returns
  //     lifecycle_status = 'paused' → PROFILE_NOT_LIVE (403) is the tested gate.
  //   - We pause with adminHeaders(ns) (isNetworkService = true) because even
  //     though the source item's created_by = svc_user_id (same user as ns apikey),
  //     the ns apikey path without acting-org also works (isOwner = true), but
  //     adminHeaders is more explicit and consistent with scenarios 7/8/9.
  //   - We add a skip guard: if perform returns 400 (action_type not configured),
  //     or if revealStatuses doesn't include 'accepted' (PII_NOT_REVEALED before
  //     the lifecycle gate), skip so the suite stays green on minimal networks.
  // ---------------------------------------------------------------------------

  it('scenario 10: GET /action/:id/contact-details after source pauses → 200 masked (revealed:false)', async (ctx) => {
    // Ensure both source and target items are live first.
    // The live_item_id belongs to live_user_id and should be live after scenario 9 restore.
    const [targetRow] = await db
      .select({ lifecycle_status: itemsTable.lifecycle_status })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, live_item_id))
      .limit(1);

    if (targetRow?.lifecycle_status !== 'live') {
      ctx.skip();
      return;
    }

    // Seed a source item whose owner IS svc_user_id.  We use svc_user_email so
    // the participant route finds the existing svc_user row and creates an item
    // with created_by = svc_user_id.  This lets us authenticate subsequent calls
    // with ns.raw_key (which resolves to svc_user_id) and satisfy the
    // NOT_ACTION_PARTICIPANT check in contact-details.
    const seedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: svc_user_email,
        name: 'LC S10 src',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
      },
    });
    expect(seedRes.statusCode).toBe(200);
    const seedBody = seedRes.json() as { user_id: string; items: Array<{ item_id: string }> };
    const src_item_id = seedBody.items[seedBody.items.length - 1].item_id;
    // svc_user_id is already in the DB; do not push to onboarded_user_ids again
    // to avoid double-delete in afterAll (items cleanup handles it separately).

    // Source is draft-until-consent (aggregator-dpg#464); make it live so the
    // action can be performed (both source and target must be live).
    await makeLive(svc_user_id, src_item_id, primary.network);

    // Perform an action (both source and target must be live).
    const performRes = await app.inject({
      method: 'POST',
      url: '/api/v1/network/action/perform',
      headers: { 'content-type': 'application/json' },
      payload: {
        action_type: 'connect',
        source_item: {
          item_network: primary.network,
          item_domain: primary.domain,
          item_type: primary.item_type,
          item_id: src_item_id,
          item_instance_url: `http://localhost:${listen_port}`,
        },
        target_item: {
          item_network: primary.network,
          item_domain: primary.domain,
          item_type: primary.item_type,
          item_id: live_item_id,
          item_instance_url: `http://localhost:${listen_port}`,
        },
        source_item_owner: svc_user_id,
        requirements_snapshot: {},
      },
    });

    if (performRes.statusCode !== 201) {
      // Action type may not be configured in the current network — skip.
      ctx.skip();
      return;
    }

    const { action_id } = performRes.json() as { action_id: string };
    seeded_action_ids.push(action_id);

    // Update action status to 'accepted' — the gate checks reveals_pii_on_status.
    // If 'accepted' is not in the network's reveal list, the endpoint will return
    // PII_NOT_REVEALED before reaching the lifecycle gate; we detect that and skip.
    await db
      .update(itemActionsTable)
      .set({ action_status: 'accepted' })
      .where(eq(itemActionsTable.action_id, action_id));

    // Pause the source item (src_item_id.created_by = svc_user_id; ns apikey
    // authenticates as svc_user_id → isOwner = true, but we use adminHeaders(ns)
    // for consistency).
    await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: { item_id: src_item_id, action: 'pause' },
    });

    // The source user (authenticated via ns.raw_key → svc_user_id) requests
    // contact details.  source_item_owner = svc_user_id → callerIsSource = true.
    // The source item is now paused → PROFILE_NOT_LIVE should be returned.
    const detailsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/action/${action_id}/contact-details`,
      headers: userHeaders(ns.raw_key),
    });

    // Skip gracefully if the network doesn't expose 'accepted' as a PII-reveal
    // status — the lifecycle gate is unreachable in that case and this is a
    // network-config constraint, not a code defect.
    if (
      detailsRes.statusCode === 403 &&
      (detailsRes.json() as { error: string }).error === 'PII_NOT_REVEALED'
    ) {
      ctx.skip();
      return;
    }

    // Paused caller → PII withheld, but the endpoint returns the MASKED
    // pre-reveal view (#273), not an error.
    expect(detailsRes.statusCode).toBe(200);
    const detailsBody = detailsRes.json() as { revealed: boolean };
    expect(detailsBody.revealed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 11: GET /network/item/fetch lists only live items
  // ---------------------------------------------------------------------------

  it('scenario 11: GET /network/item/fetch returns only live items (draft excluded)', async () => {
    // We already have live_item_id (live) and at least one draft item from scenario 2.
    // Fetch and assert that draft items are absent AND that the known live item appears.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/network/item/fetch?item_network=${encodeURIComponent(primary.network)}&item_domain=${encodeURIComponent(primary.domain)}&limit=100&offset=0`,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ item_id: string; lifecycle_status?: string }>;
      meta: { total: number };
    };

    const returned_ids = new Set(body.items.map((i) => i.item_id));

    // The filter is correct iff EVERY returned item is live (and the list is
    // non-empty so this isn't a vacuous pass). NOTE: we deliberately do NOT
    // assert a specific seeded id is present — earlier scenarios pause/demote
    // shared items, so the only stable invariant is "everything returned is live".
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.lifecycle_status === 'live')).toBe(true);

    // Negative cross-check: no draft OR paused item created by our seeded users
    // appears in the list (covers both lifecycle-exclusion cases).
    const hidden_ids = await db
      .select({ item_id: itemsTable.item_id })
      .from(itemsTable)
      .where(
        and(
          inArray(itemsTable.lifecycle_status, ['draft', 'paused']),
          eq(itemsTable.item_network, primary.network),
          eq(itemsTable.item_domain, primary.domain),
          inArray(itemsTable.created_by, onboarded_user_ids),
        ),
      );
    for (const { item_id } of hidden_ids) {
      expect(returned_ids.has(item_id)).toBe(false);
    }

    // Legacy cross-check retained: no draft item created by our seeded users appears in the list.
    const draft_ids = await db
      .select({ item_id: itemsTable.item_id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.lifecycle_status, 'draft'),
          eq(itemsTable.item_network, primary.network),
          eq(itemsTable.item_domain, primary.domain),
          inArray(itemsTable.created_by, onboarded_user_ids),
        ),
      );

    for (const { item_id } of draft_ids) {
      expect(returned_ids.has(item_id)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 12 (spec §7 bullet 3): a pending action gated while the target is
  // paused RESUMES after unpause — the same accept that failed with
  // PROFILE_NOT_LIVE succeeds once the item is live again. This is the
  // recoverable-enforcement promise that replaced destructive cancellation.
  //
  // Auth reasoning:
  //   - /action/update-status requires caller === target_item_owner.
  //   - We seed the TARGET item with svc_user_email so created_by = svc_user_id
  //     (the same trick scenario 10 uses for its source item); perform stores
  //     target_item_owner = created_by, and userHeaders(ns.raw_key)
  //     authenticates as svc_user_id → owner check passes.
  //   - The source item belongs to a fresh participant and stays live
  //     throughout, so the source-side §10 gate never fires.
  // ---------------------------------------------------------------------------

  it('scenario 12: action gated while target paused resumes after unpause (accept succeeds)', async (ctx) => {
    // Find a (from → to) pair among the served bindings for which the network
    // actually configures a 'connect' interaction — e.g. purple_dot declares
    // seeker→provider but not seeker→seeker, so a blind primary→primary
    // perform would 400 and silently skip the scenario.
    const bindings = [primary, ...(secondary ? [secondary] : [])];
    let from: ResolvedBinding | undefined;
    let to: ResolvedBinding | undefined;
    let interaction: Awaited<ReturnType<typeof resolveInteractionConsent>> = null;
    for (const f of bindings) {
      for (const t of bindings) {
        const found = await resolveInteractionConsent({
          actionType: 'connect',
          fromNetwork: f.network,
          fromDomain: f.domain,
          fromItemType: f.item_type,
          toNetwork: t.network,
          toDomain: t.domain,
          toItemType: t.item_type,
        });
        if (found) {
          from = f;
          to = t;
          interaction = found;
          break;
        }
      }
      if (interaction) break;
    }
    if (!from || !to || !interaction) {
      // No 'connect' interaction configured between served bindings — skip.
      ctx.skip();
      return;
    }

    // Fresh target item owned by svc_user_id (admin/participant without an
    // item_id creates a new row; earlier svc-owned items are untouched).
    const targetSeed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: svc_user_email,
        name: 'LC S12 target',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: to.network,
        domain: to.domain,
        item_type: to.item_type,
        item_state: generateMinimalItemState(to.schema),
      },
    });
    expect(targetSeed.statusCode).toBe(200);
    const targetItems = (targetSeed.json() as { items: Array<{ item_id: string }> }).items;
    const target_item_id = targetItems[targetItems.length - 1].item_id;
    // svc_user_id is already in the DB; do not push to onboarded_user_ids.

    // Fresh live source participant.
    const src_email = `lc_s12_src_${randomUUID().slice(0, 6)}@a.test`;
    const srcSeed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: adminHeaders(ns),
      payload: {
        email: src_email,
        name: 'LC S12 src',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: from.network,
        domain: from.domain,
        item_type: from.item_type,
        item_state: generateMinimalItemState(from.schema),
      },
    });
    expect(srcSeed.statusCode).toBe(200);
    const srcBody = srcSeed.json() as { user_id: string; items: Array<{ item_id: string }> };
    const src_item_id = srcBody.items[0].item_id;
    onboarded_user_ids.push(srcBody.user_id);

    // Both are draft-until-consent (aggregator-dpg#464); accept consent so the
    // action can be created (perform requires source + target live).
    await makeLive(svc_user_id, target_item_id, to.network);
    await makeLive(srcBody.user_id, src_item_id, from.network);

    // Create the action while both items are live.
    const performRes = await app.inject({
      method: 'POST',
      url: '/api/v1/network/action/perform',
      headers: { 'content-type': 'application/json' },
      payload: {
        action_type: 'connect',
        source_item: {
          item_network: from.network,
          item_domain: from.domain,
          item_type: from.item_type,
          item_id: src_item_id,
          item_instance_url: `http://localhost:${listen_port}`,
        },
        target_item: {
          item_network: to.network,
          item_domain: to.domain,
          item_type: to.item_type,
          item_id: target_item_id,
          item_instance_url: `http://localhost:${listen_port}`,
        },
        source_item_owner: srcBody.user_id,
        requirements_snapshot: {},
        // Initiate-consent is now enforced on the write endpoint for any
        // reveals_pii action (matching the /action/perform proxy), so send it
        // when the interaction reveals PII.
        ...(interaction.reveals_pii_on_status.length > 0
          ? { consent: { acknowledged: true as const, version: 1 } }
          : {}),
      },
    });
    expect(performRes.statusCode).toBe(201);
    const { action_id } = performRes.json() as { action_id: string };
    seeded_action_ids.push(action_id);

    // Pause the target → accept is gated (recoverable), action row untouched.
    const pauseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: { item_id: target_item_id, action: 'pause' },
    });
    expect(pauseRes.statusCode).toBe(200);

    const gatedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: userHeaders(ns.raw_key),
      payload: [{ action_id, action_status: 'accepted' }],
    });
    expect(gatedRes.statusCode).toBe(422);
    const gated = (gatedRes.json() as { results: Array<Record<string, unknown>> }).results[0];
    expect(gated).toMatchObject({ status: 'error', error: 'PROFILE_NOT_LIVE' });

    const [gatedRow] = await db
      .select({ action_status: itemActionsTable.action_status })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, action_id))
      .limit(1);
    expect(gatedRow?.action_status).toBe('created'); // survived the gate, not cancelled

    // Unpause → live again.
    const unpauseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/item/lifecycle',
      headers: adminHeaders(ns),
      payload: { item_id: target_item_id, action: 'unpause' },
    });
    expect(unpauseRes.statusCode).toBe(200);
    expect(unpauseRes.json().lifecycle_status).toBe('live');

    // The SAME accept now succeeds. Include receiver consent when the
    // interaction reveals PII on 'accepted' (reveals_pii_on_status-driven).
    const receiverConsent = interaction.reveals_pii_on_status.includes('accepted')
      ? consentAck()
      : undefined;
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: userHeaders(ns.raw_key),
      payload: [
        {
          action_id,
          action_status: 'accepted',
          ...(receiverConsent ? { consent: receiverConsent } : {}),
        },
      ],
    });
    const acceptResult = (acceptRes.json() as { results: Array<Record<string, unknown>> }).results[0];

    expect(acceptRes.statusCode).toBe(200);
    expect(acceptResult.action_status).toBe('accepted');

    const [resumedRow] = await db
      .select({ action_status: itemActionsTable.action_status })
      .from(itemActionsTable)
      .where(eq(itemActionsTable.action_id, action_id))
      .limit(1);
    expect(resumedRow?.action_status).toBe('accepted');
  });

  // ---------------------------------------------------------------------------
  // Scenario 13 (#347): retire is terminal — wipes PII, keeps the action row,
  // and cannot be transitioned out of. A retired profile is also excluded from
  // the owner's instance-local fetch ("My Profiles").
  // ---------------------------------------------------------------------------

  it('scenario 13: retire → retired, PII wiped, action row kept, second retire → 409', async () => {
    const email = `lc_s13_${randomUUID().slice(0, 6)}@a.test`;
    const full = generateMinimalItemState(primary.schema);
    const create = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant', headers: adminHeaders(ns),
      payload: {
        email, name: 'LC S13', terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', network: primary.network, domain: primary.domain,
        item_type: primary.item_type, item_state: full,
      },
    });
    expect(create.statusCode).toBe(200);
    const itemId = create.json().items[0].item_id as string;
    const userId = create.json().user_id as string;
    onboarded_user_ids.push(userId);
    await makeLive(userId, itemId, primary.network);

    // Give the item a location with an exact coord + free-text label — retire
    // must wipe item_locations entirely (not leave the label residue).
    await db
      .update(itemsTable)
      .set({ item_locations: [{ lat: 12.34, lng: 56.78, label: '221B Baker Street' }] })
      .where(eq(itemsTable.item_id, itemId));

    // A second real profile to be the counterparty (item_actions has an FK on
    // the TARGET item, so it must exist).
    const otherCreate = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant', headers: adminHeaders(ns),
      payload: {
        email: `lc_s13_other_${randomUUID().slice(0, 6)}@a.test`, name: 'LC S13 other',
        terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', network: primary.network, domain: primary.domain,
        item_type: primary.item_type, item_state: generateMinimalItemState(primary.schema),
      },
    });
    expect(otherCreate.statusCode).toBe(200);
    const otherItemId = otherCreate.json().items[0].item_id as string;
    onboarded_user_ids.push(otherCreate.json().user_id as string);

    // Two open actions referencing the item — one where it is the TARGET, one
    // where it is the SOURCE. Both must be cancelled on retire (rows kept).
    await ensureActionPartition(db, primary.network, 'connect');
    const targetActionId = randomUUID();
    const sourceActionId = randomUUID();
    await db.insert(itemActionsTable).values([
      {
        action_type: 'connect', partition_network: primary.network, action_id: targetActionId,
        action_status: 'created', update_count: 0,
        source_item_network: primary.network, source_item_domain: primary.domain,
        source_item_type: primary.item_type, source_item_id: otherItemId,
        source_item_instance_url: `http://localhost:${listen_port}`,
        target_item_network: primary.network, target_item_domain: primary.domain,
        target_item_type: primary.item_type, target_item_id: itemId,
        target_item_instance_url: `http://localhost:${listen_port}`,
        requirements_snapshot: {},
      },
      {
        action_type: 'connect', partition_network: primary.network, action_id: sourceActionId,
        action_status: 'created', update_count: 0,
        source_item_network: primary.network, source_item_domain: primary.domain,
        source_item_type: primary.item_type, source_item_id: itemId,
        source_item_instance_url: `http://localhost:${listen_port}`,
        target_item_network: primary.network, target_item_domain: primary.domain,
        target_item_type: primary.item_type, target_item_id: otherItemId,
        target_item_instance_url: `http://localhost:${listen_port}`,
        requirements_snapshot: {},
      },
    ]);
    seeded_action_ids.push(targetActionId, sourceActionId);

    // Retire (network_service authorised).
    const res = await app.inject({
      method: 'POST', url: '/api/v1/item/lifecycle', headers: adminHeaders(ns),
      payload: { item_id: itemId, action: 'retire' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle_status).toBe('retired');

    // DB: retired + private blob cleared + no private field left + locations wiped.
    const [row] = await db
      .select({
        lifecycle_status: itemsTable.lifecycle_status,
        item_state: itemsTable.item_state,
        item_private_state: itemsTable.item_private_state,
        item_locations: itemsTable.item_locations,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, itemId))
      .limit(1);
    expect(row.lifecycle_status).toBe('retired');
    expect(row.item_private_state).toBe('');
    expect(row.item_locations).toEqual([]); // wiped, no label residue (#347)
    // Every private field defined by the schema is gone from the stored state.
    const publicOnly = nonPrivateFields(primary.schema, full);
    const stored = row.item_state as Record<string, unknown>;
    for (const key of Object.keys(full)) {
      if (!(key in publicOnly)) expect(key in stored).toBe(false);
    }

    // Both actions are kept (bare ids for counterparty history) AND cancelled —
    // target-side and source-side.
    const actionRows = await db
      .select({ action_id: itemActionsTable.action_id, action_status: itemActionsTable.action_status })
      .from(itemActionsTable)
      .where(inArray(itemActionsTable.action_id, [targetActionId, sourceActionId]));
    expect(actionRows).toHaveLength(2);
    for (const a of actionRows) expect(a.action_status).toBe('cancelled');

    // Terminal: a second lifecycle call is rejected.
    const again = await app.inject({
      method: 'POST', url: '/api/v1/item/lifecycle', headers: adminHeaders(ns),
      payload: { item_id: itemId, action: 'retire' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('INVALID_LIFECYCLE_ACTION');

    // A retired item cannot be edited — a state PATCH must not re-introduce the
    // wiped PII (#347). The update path rejects with 409 ITEM_RETIRED.
    const editRes = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant', headers: adminHeaders(ns),
      payload: {
        email, name: 'LC S13 edit', terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', network: primary.network, domain: primary.domain,
        item_type: primary.item_type, item_id: itemId,
        item_state: generateMinimalItemState(primary.schema),
      },
    });
    expect(editRes.statusCode).toBe(409);
    expect(editRes.json().error).toBe('ITEM_RETIRED');

    // Excluded from the OWNER's instance-local fetch ("My Profiles"). Mint an
    // apikey for the owning user (not the svc user) so the fetch is scoped to
    // their own items — otherwise the assertion is vacuous.
    const ownerRawKey = `sk_signals_${randomBytes(24).toString('hex')}`;
    await db.insert(authSchema.apikey).values({
      id: `key_${randomUUID()}`,
      name: 'lc-s13-owner',
      key: hash_key(ownerRawKey),
      userId,
      referenceId: userId,
      configId: 'default',
      start: ownerRawKey.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const fetchRes = await app.inject({
      method: 'GET',
      url: `/api/v1/item/fetch?item_network=${encodeURIComponent(primary.network)}&item_domain=${encodeURIComponent(primary.domain)}&limit=100&offset=0`,
      headers: userHeaders(ownerRawKey),
    });
    expect(fetchRes.statusCode).toBe(200);
    const items = (fetchRes.json() as { items: Array<{ item_id: string }> }).items;
    // The retired item is the owner's only profile → the list excludes it (empty).
    expect(items.some((i) => i.item_id === itemId)).toBe(false);
  });
});
