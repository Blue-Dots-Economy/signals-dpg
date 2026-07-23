/**
 * Plan C Task 4 — integration test for POST /api/v1/admin/participant
 * exercising the tier-aware upsert matrix against a real Postgres.
 *
 * Filename ends in .integration.test.ts so the default vitest config
 * excludes it from `pnpm --filter api test`. Runs via the sibling
 * integration config:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * The test fully self-contains the world it exercises:
 *
 *   - seeds two aggregator-type orgs + one network_service-type org, each
 *     pointing at one shared service user, each with its own apikey row
 *     (raw key hashed SHA-256 → base64url to match better-auth's
 *     defaultKeyHasher, the same pattern seed_service_users.ts uses);
 *   - drives 6 cases through the route via app.inject, asserting both the
 *     response body and the resulting DB state where each case is
 *     load-bearing (attribution, item count, item_state mutation, the
 *     read-isolation rule, and the cross-user item_id 403);
 *   - boots Fastify on API_PORT (default 2742) with an EADDRINUSE guard
 *     mirroring Plan A's integration suite.
 *
 * Cleanup: afterAll drops items created by every seeded user, deletes
 * the users (cascades member/apikey via FKs), then the three orgs.
 *
 * Skip conditions: if POSTGRES_URL / POSTGRES_USER are unset the suite
 * is described as `.skip` so CI without a DB stays green.
 *
 * Config-driven: served-domain bindings are resolved from apiConfig at
 * beforeAll. The test passes explicit network/domain/item_type in every
 * request so the route never falls back to hard-coded defaults. A minimal
 * valid item_state is generated from the JSON schema for the first
 * item_type declared in each binding's domain config.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  nonPrivateFields,
  resolveBindings,
  type ResolvedBinding,
} from '../../__tests__/integration_helpers';
import { apiConfig } from '@/config';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

const hash_key = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIf(`POST /api/v1/admin/participant (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;

  // Default to the network-config port so the route's downstream
  // partition-ensure / signUp paths see the same host they would in the
  // dev server. EADDRINUSE guarded below.
  const listen_port = Number(process.env.API_PORT ?? 2742);

  const ts = Date.now();

  // Aggregator A onboards the canonical user and reads it back.
  const agg_a = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-c-a-${ts}`,
  };

  // Aggregator B — used for the agg-b-cant-read-agg-a's-items case.
  const agg_b = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-c-b-${ts}`,
  };

  // Network service — drives update_item / insert_item / item-not-owned.
  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `ns-int-c-${ts}`,
  };

  // One shared service user owns all three apikeys / members — we don't
  // care about distinct service-user identities for this matrix (the
  // route only inspects acting_org.type and acting_org.org_id). Sharing
  // keeps cleanup trivial: one row to delete.
  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `signals-c-int-${ts}@signals.local`;

  // Track every onboarded participant so we can drop their items + user
  // rows in afterAll. The first push is the canonical user that drives
  // cases 1–5, the second is the secondary user seeded inside case 6.
  const onboarded_user_ids: string[] = [];

  // Resolved at beforeAll — schema-derived bindings consumed by each test.
  let primary: ResolvedBinding;
  let secondary: ResolvedBinding | null;

  beforeAll(async () => {
    // Lazy-import the DB / database-package surfaces so a CI box without
    // a live DB doesn't blow up on import (drizzle_config builds a Pool
    // eagerly).
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;

    // Resolve primary + secondary served-domain bindings from env config.
    const resolved = await resolveBindings();
    primary = resolved.primary;
    secondary = resolved.secondary;

    const { admin_routes } = await import('../admin_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // /admin/participant's update_item branch loops back through
    // /api/v1/network/schema/... over HTTP to fetch the json-schema for
    // item_state validation, so the network scope has to be reachable on
    // the same listening port (see apiConfig.served_domains → instance_url).
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });

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

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    // One shared service user backing every apikey / member row.
    await db.insert(user).values({
      id: svc_user_id,
      email: svc_user_email,
      name: 'plan-c integration svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // Three orgs spanning the tier matrix: two aggregator-type, one
    // network_service-type. Type column gates which verdict the helper
    // emits for each case.
    await db.insert(organization).values([
      {
        id: agg_a.org_id,
        slug: agg_a.slug,
        name: `${agg_a.slug} (integration aggregator A)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: agg_b.org_id,
        slug: agg_b.slug,
        name: `${agg_b.slug} (integration aggregator B)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: ns.org_id,
        slug: ns.slug,
        name: `${ns.slug} (integration network_service)`,
        type: 'network_service',
        createdAt: now,
      },
    ]);

    // Shared service user is a 'service' member of each org so the
    // acting_org middleware accepts the org_id for any of the three
    // apikeys.
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

    // Three apikeys, one per org — same userId / referenceId since the
    // route picks the acting org from the x-acting-org-id header, not
    // from the apikey row. The hashing matches better-auth's
    // defaultKeyHasher (SHA-256 → base64url, no padding).
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
      if (onboarded_user_ids.length > 0) {
        // items has no FK on user.id — delete by created_by explicitly.
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, onboarded_user_ids));
        await db.delete(user).where(inArray(user.id, onboarded_user_ids));
      }
      // Service apikeys + member rows cascade away with svc user delete,
      // but we drop apikeys explicitly to be defensive in case schema
      // changes loosen the FK in future.
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg_a.org_id, agg_b.org_id, ns.org_id]));
    } catch (err) {
      // Don't mask the actual test failure with a cleanup blow-up.
      // eslint-disable-next-line no-console
      console.error('integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  // Shared canonical user identifiers populated by case #1, consumed by
  // cases #2–#5. Case #6 seeds its own secondary user.
  let canonical_user_id: string;
  let canonical_user_email: string;
  let canonical_item_id: string;

  it('agg_A onboards a brand-new user; row exists with onboardedByOrgId = agg_A.org_id, items[0] present', async () => {
    canonical_user_email = `int_c_${randomUUID().slice(0, 6)}@a.test`;
    const initialFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'Int C A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: initialFixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].item_id).toBeTruthy();
    // POST response now surfaces item_locations (array; [] when no location set)
    expect(Array.isArray(body.items[0].item_locations)).toBe(true);

    canonical_user_id = body.user_id;
    canonical_item_id = body.items[0].item_id;
    onboarded_user_ids.push(canonical_user_id);

    const { user } = authSchema;
    const [row] = await db
      .select({
        id: user.id,
        onboardedByOrgId: user.onboardedByOrgId,
      })
      .from(user)
      .where(eq(user.id, canonical_user_id))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.onboardedByOrgId).toBe(agg_a.org_id);
  });

  it('agg_A hits the same user again with item_state — creates ANOTHER profile (#349 always-create)', async () => {
    const sameTriple = (rows: Array<Record<string, unknown>>) =>
      rows.filter(
        (r) =>
          r.item_network === primary.network &&
          r.item_domain === primary.domain &&
          r.item_type === primary.item_type,
      );
    const before = sameTriple(
      await db.select().from(itemsTable).where(eq(itemsTable.created_by, canonical_user_id)),
    );
    expect(before.length).toBeGreaterThan(0); // already has one from the create test

    // Same body, no item_id → a create is always an insert now (not a dedup-to-update).
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'doesnt matter',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.user_id).toBe(canonical_user_id);

    const after = sameTriple(
      await db.select().from(itemsTable).where(eq(itemsTable.created_by, canonical_user_id)),
    );
    // A brand-new same-type row was added.
    expect(after.length).toBe(before.length + 1);
    const returnedId = body.items[0].item_id as string;
    expect(before.map((r) => r.item_id as string)).not.toContain(returnedId);
  });

  it('per-user profile cap: creating past MAX_PROFILES_PER_USER returns 409 PROFILE_LIMIT_REACHED', async () => {
    // Fresh user so the count starts clean. Default cap = MAX_PROFILES_PER_USER (5).
    const limit = apiConfig.max_profiles_per_user;
    const capEmail = `cap-${randomUUID()}@test.local`;
    const capPhone = `+9199${Math.floor(randomBytes(4).readUInt32BE(0) % 1e8).toString().padStart(8, '0')}`;
    const mk = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/participant',
        headers: {
          'x-api-key': ns.raw_key,
          'x-acting-org-id': ns.org_id,
          'content-type': 'application/json',
        },
        payload: {
          email: capEmail,
          phone_number: capPhone,
          name: `Cap User ${n}`,
          terms_accepted: true,
          privacy_accepted: true,
          channel: 'bulk',
          network: primary.network,
          domain: primary.domain,
          item_type: primary.item_type,
          item_state: generateMinimalItemState(primary.schema),
        },
      });

    // First `limit` creates succeed.
    let capUserId: string | undefined;
    for (let i = 0; i < limit; i++) {
      const ok = await mk(i);
      expect(ok.statusCode).toBe(200);
      capUserId = ok.json().user_id;
    }
    // The next one is rejected by the cap.
    const over = await mk(limit);
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('PROFILE_LIMIT_REACHED');

    // cleanup — only this test user's rows.
    if (capUserId) {
      await db.delete(itemsTable).where(eq(itemsTable.created_by, capUserId));
    }
  });

  it('network_service updates an existing item via item_id; item_state in DB reflects the new payload', async () => {
    const updateFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'NS Update',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: updateFixture,
        item_id: canonical_item_id,
      },
    });
    expect(res.statusCode).toBe(200);

    const [refreshed] = await db
      .select({ item_state: itemsTable.item_state })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, canonical_item_id))
      .limit(1);
    expect(refreshed).toBeTruthy();
    // Private fields land in item_state as type-aware masks (PII encryption at
    // rest, see 2026-05-28-pii-encryption-at-rest design). The unmasked values
    // live in item_private_state. Round-trip assert on the public-only subset.
    const publicFromFixture = nonPrivateFields(primary.schema, updateFixture);
    const publicFromDb = nonPrivateFields(
      primary.schema,
      refreshed.item_state as Record<string, unknown>,
    );
    expect(publicFromDb).toEqual(publicFromFixture);
  });

  it('network_service inserts an additional item for the same user (secondary served-domain binding); item count goes up by 1', async (ctx) => {
    if (secondary === null) {
      ctx.skip();
      return;
    }

    const before = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));

    const secondaryFixture = generateMinimalItemState(secondary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'NS Insert',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: secondary.network,
        domain: secondary.domain,
        item_type: secondary.item_type,
        item_state: secondaryFixture,
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));
    expect(after.length).toBe(before.length + 1);
  });

  it("agg_B trying to read agg_A's user gets user_existed=true but items: []", async () => {
    const probeFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_b.raw_key,
        'x-acting-org-id': agg_b.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'agg_b probe',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: probeFixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.user_id).toBe(canonical_user_id);
    expect(body.items).toEqual([]);
  });

  it('network_service with item_id from a different user → 403 ITEM_NOT_OWNED_BY_USER, no writes', async () => {
    // Seed a second user via agg_A so we have an item owned by someone
    // other than the canonical user.
    const other_email = `int_c_${randomUUID().slice(0, 6)}@b.test`;
    const seedFixture = generateMinimalItemState(primary.schema);
    const seed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: other_email,
        name: 'Other Int C',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: seedFixture,
      },
    });
    expect(seed.statusCode).toBe(200);
    const seed_body = seed.json();
    const other_user_id: string = seed_body.user_id;
    const other_item_id: string = seed_body.items[0].item_id;
    onboarded_user_ids.push(other_user_id);

    // Snapshot the canonical user's items so we can assert "no writes"
    // happened against them.
    const before_canonical = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));
    const before_other = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, other_item_id))
      .limit(1);

    const badFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'NS bad update',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: badFixture,
        item_id: other_item_id, // belongs to the OTHER user
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ITEM_NOT_OWNED_BY_USER');

    // Canonical user untouched.
    const after_canonical = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));
    expect(after_canonical.length).toBe(before_canonical.length);

    // Other user's item likewise untouched (full state equality check).
    const [after_other] = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, other_item_id))
      .limit(1);
    expect(after_other).toBeTruthy();
    expect(after_other.item_state).toEqual(before_other[0].item_state);
  });
});
