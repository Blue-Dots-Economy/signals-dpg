/**
 * Plan A Task 7 — integration test for POST /api/v1/action/perform
 * on-behalf-of behaviour against a real Postgres.
 *
 * Filename ends in .integration.test.ts so the default vitest config
 * excludes it from `pnpm --filter api test`. Runs via the sibling
 * integration config:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm db:seed:services:api      # the seeded voice-dpg / aggregator-dpg
 *                                  # service users are NOT used by this
 *                                  # suite — we seed our own scoped
 *                                  # aggregator-type orgs directly.
 *   pnpm --filter api test:integration
 *
 * The test fully self-contains the world it exercises:
 *
 *   - seeds two aggregator-type orgs (each with its own service user +
 *     member + apikey row), inserted directly via drizzle. We can't reuse
 *     /admin/participant or the existing seed script for this
 *     because (a) the default seed only mints `network_service` orgs and
 *     (b) we need TWO distinct aggregator orgs to drive the 403
 *     NOT_AUTHORIZED_FOR_TARGET case;
 *   - resolves served-domain bindings from apiConfig so the suite works
 *     against any network configured via SERVED_DOMAINS (purple_dot,
 *     blue_dot, etc.) without hardcoding network/domain/item_type;
 *   - onboards a seeker user via /admin/participant as aggregator
 *     A so the source item exists and is attributed to A;
 *   - onboards a provider user via the same route so a target item exists
 *     in the same DB. The provider user is owned by aggregator A too —
 *     irrelevant for the action flow because the action checks source
 *     ownership, not target ownership;
 *   - boots Fastify on the env-configured API_PORT (default 2742) so the
 *     loopback fetch inside /action/perform → /network/action/perform
 *     lands back on this same instance.
 *
 * Cleanup: afterAll deletes the seeded users (cascades wipe member /
 * apikey / items / item_actions rows via FKs) and the two aggregator orgs.
 *
 * Skip conditions: if POSTGRES_URL/POSTGRES_USER are unset (e.g. CI box
 * without a DB) the suite is described as `.skip` so the run stays green.
 * If SERVED_DOMAINS only provides one binding (seeker OR provider but not
 * both), beforeAll throws a descriptive error.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  generateMinimalItemState,
  resolveBindings,
  resolveInteractionConsent,
  consentAck,
  type ResolvedBinding,
} from '../../__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

describeIf(`POST /action/perform on-behalf-of (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;

  // The Fastify instance must listen on the port the network config
  // declares for the served domain, otherwise INVALID_TARGET_INSTANCE
  // fires. The env defaults match this (API_DOMAIN=http://localhost,
  // API_PORT=2742).
  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  // Aggregator A — performs an on-behalf-of action successfully.
  const agg_a = {
    org_id: `org_${randomUUID()}`,
    user_id: `usr_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-a-${Date.now()}`,
    user_email: `agg-int-a-${Date.now()}@signals.local`,
  };

  // Aggregator B — used for the 403 NOT_AUTHORIZED_FOR_TARGET case.
  const agg_b = {
    org_id: `org_${randomUUID()}`,
    user_id: `usr_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-b-${Date.now()}`,
    user_email: `agg-int-b-${Date.now()}@signals.local`,
  };

  // Network-service org — used to prove the cross-aggregator scope on
  // /action/perform. Its on-behalf-of calls must succeed regardless of
  // which aggregator onboarded the target user.
  const ns = {
    org_id: `org_${randomUUID()}`,
    user_id: `usr_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `ns-int-${Date.now()}`,
    user_email: `ns-int-${Date.now()}@signals.local`,
  };

  // Seeded by /admin/participant — captured for assertions /
  // cleanup. Onboarded participant rows go in `seeded_participant_ids` so
  // we cascade-delete everything tied to them on teardown.
  const seeded_participant_ids: string[] = [];
  let seeker_user_id: string;
  let seeker_item_id: string;
  let provider_item_id: string;
  let provider_user_id: string;

  // Resolved at beforeAll from apiConfig — drives all network/domain/item_type
  // values so the suite works against any SERVED_DOMAINS configuration.
  let primary: ResolvedBinding;   // seeker binding
  let secondary: ResolvedBinding; // provider binding

  // Consent resolved from the interaction config (undefined when no
  // reveals_pii_on_status is declared, i.e. networks without consent requirements).
  let initiator_consent: { acknowledged: true; version: number } | undefined;

  beforeAll(async () => {
    // Lazy-imported so a CI box without a live DB doesn't blow up on
    // import (drizzle_config builds a Pool eagerly).
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;

    // Resolve primary (seeker) and secondary (provider) bindings from the
    // configured SERVED_DOMAINS. Throws loudly if fewer than two distinct
    // bindings are served — the suite needs both a source and a target item.
    const resolved = await resolveBindings();
    if (resolved.secondary === null) {
      throw new Error(
        'on_behalf_of integration suite requires two served-domain bindings ' +
        '(a source/seeker domain and a target/provider domain). ' +
        'Set SERVED_DOMAINS to include two distinct network/domain pairs, ' +
        `e.g. "purple_dot/seeker,purple_dot/provider". ` +
        `Currently only one binding is served: ${resolved.primary.network}/${resolved.primary.domain}.`,
      );
    }
    primary = resolved.primary;
    secondary = resolved.secondary;

    // Resolve the interaction between primary and secondary to determine
    // whether consent is required (reveals_pii_on_status.length > 0).
    // Include consent in requests only when the interaction requires it.
    const consentInfo = await resolveInteractionConsent({
      actionType: 'connect',
      fromNetwork: primary.network,
      fromDomain: primary.domain,
      fromItemType: primary.item_type,
      toNetwork: secondary.network,
      toDomain: secondary.domain,
      toItemType: secondary.item_type,
    });
    initiator_consent =
      (consentInfo?.reveals_pii_on_status.length ?? 0) > 0
        ? consentAck()
        : undefined;

    const { admin_routes } = await import('../../admin/admin_routes.js');
    const action_routes_mod = await import('../action_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Mount the same scopes the production server does, with the same
    // preHandler chain. /action/perform internally proxies to
    // /network/action/perform via HTTP fetch — both must be reachable
    // on the listening port that matches the network config's
    // instance_url for the served network.
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(action_routes_mod.default, { prefix: '/api/v1/action' });
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

    // Seed aggregator + network_service orgs directly. The on-behalf-of
    // code path needs both tiers exercised end-to-end; the default seed
    // script only mints network_service orgs, so we bypass it here.
    const seed_orgs: Array<[typeof agg_a, 'aggregator' | 'network_service']> = [
      [agg_a, 'aggregator'],
      [agg_b, 'aggregator'],
      [ns, 'network_service'],
    ];
    for (const [v, org_type] of seed_orgs) {
      await db.insert(organization).values({
        id: v.org_id,
        slug: v.slug,
        name: `${v.slug} (integration ${org_type})`,
        type: org_type,
        createdAt: now,
      });
      await db.insert(user).values({
        id: v.user_id,
        email: v.user_email,
        name: v.slug,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(member).values({
        id: v.member_id,
        organizationId: v.org_id,
        userId: v.user_id,
        role: 'service',
        createdAt: now,
      });
      // better-auth verifyApiKey hashes the incoming raw key with
      // SHA-256 → base64url (no padding) and looks it up by hash. We
      // mirror that here exactly the way seed_service_users.ts does.
      const hashed_key = createHash('sha256').update(v.raw_key).digest('base64url');
      await db.insert(apikey).values({
        id: v.apikey_id,
        name: v.slug,
        key: hashed_key,
        userId: v.user_id,
        referenceId: v.user_id,
        configId: 'default',
        start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Onboard the seeker participant as aggregator A using the primary
    // binding resolved from SERVED_DOMAINS. generateMinimalItemState
    // builds a valid fixture from the JSON schema so no hardcoded
    // network-specific fields are needed.
    const seekerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        phone_number:
          '+919920' +
          Math.floor(100000 + Math.random() * 900000).toString(),
        name: 'Integration Seeker',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id: `integration_obo_${Date.now()}`,
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
      },
    });
    if (seekerRes.statusCode !== 200) {
      throw new Error(
        `seed seeker onboard failed: ${seekerRes.statusCode} ${seekerRes.body}`,
      );
    }
    const seekerBody = seekerRes.json();
    seeker_user_id = seekerBody.user_id;
    seeker_item_id = seekerBody.items[0].item_id;
    expect(seekerBody.user_existed).toBe(false);
    seeded_participant_ids.push(seeker_user_id);

    // Onboard a provider participant the same way to get a target item.
    // The action flow only checks source ownership, so the provider's
    // attribution org is irrelevant — we reuse agg_a so cleanup is trivial.
    const providerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        phone_number:
          '+919921' +
          Math.floor(100000 + Math.random() * 900000).toString(),
        name: 'Integration Provider',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id: `integration_obo_provider_${Date.now()}`,
        network: secondary.network,
        domain: secondary.domain,
        item_type: secondary.item_type,
        item_state: generateMinimalItemState(secondary.schema),
      },
    });
    if (providerRes.statusCode !== 200) {
      throw new Error(
        `seed provider onboard failed: ${providerRes.statusCode} ${providerRes.body}`,
      );
    }
    const providerBody = providerRes.json();
    provider_user_id = providerBody.user_id;
    provider_item_id = providerBody.items[0].item_id;
    expect(providerBody.user_existed).toBe(false);
    seeded_participant_ids.push(provider_user_id);
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      // item_actions has FK ON DELETE CASCADE on the target item via
      // (target_item_network, ..., target_item_id), so dropping the
      // target item kills the action rows we created. items has no
      // FK on user — we delete items by created_by explicitly.
      if (seeded_participant_ids.length > 0) {
        // First wipe item_actions rows where the source item belonged
        // to the seeded users (no FK cascades from items.created_by →
        // item_actions.source_item_*, so we have to do this by hand).
        // We scope by source_item_owner which is the participant's
        // user_id — the audit column populated by the on-behalf-of
        // flow.
        await db
          .delete(itemActionsTable)
          .where(inArray(itemActionsTable.source_item_owner, seeded_participant_ids));
        // Delete items the seeded users authored — this cascades to
        // item_actions via the target_item FK if any actions referenced
        // them as target.
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, seeded_participant_ids));
        // Finally the users themselves — cascades take care of account
        // / member rows.
        await db.delete(user).where(inArray(user.id, seeded_participant_ids));
      }
      // Aggregator service users + apikey rows cascade away with the user
      // delete; orgs need an explicit drop (member rows cascade).
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db
        .delete(user)
        .where(inArray(user.id, [agg_a.user_id, agg_b.user_id, ns.user_id]));
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

  it('aggregator A files an action on behalf of the user it onboarded; audit columns populated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: primary.network,
            item_domain: primary.domain,
            item_type: primary.item_type,
            item_id: seeker_item_id,
          },
          target_item: {
            item_network: secondary.network,
            item_domain: secondary.domain,
            item_type: secondary.item_type,
            item_id: provider_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          acting_as_user_id: seeker_user_id,
          ...(initiator_consent !== undefined ? { consent: initiator_consent } : {}),
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0].action_id).toBeTruthy();
    expect(body.results[0].action_status).toBe('created');
    expect(body.results[0].source_item_id).toBe(seeker_item_id);
    expect(body.results[0].target_item_id).toBe(provider_item_id);

    // Cross-check the DB — the strongest signal that source_item_owner
    // and the new audit columns were actually persisted by the
    // network handler.
    const rows = await db
      .select({
        source_item_owner: itemActionsTable.source_item_owner,
        performed_by_org_id: itemActionsTable.performed_by_org_id,
        performed_by_service_user_id:
          itemActionsTable.performed_by_service_user_id,
      })
      .from(itemActionsTable)
      .where(
        and(
          eq(itemActionsTable.partition_network, primary.network),
          eq(itemActionsTable.action_type, 'connect'),
          eq(itemActionsTable.action_id, body.results[0].action_id),
        ),
      )
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_item_owner).toBe(seeker_user_id);
    expect(rows[0].performed_by_org_id).toBe(agg_a.org_id);
    expect(rows[0].performed_by_service_user_id).toBe(agg_a.user_id);
  });

  it('aggregator B is rejected (422 NOT_AUTHORIZED_FOR_TARGET) when acting for a user onboarded by aggregator A', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': agg_b.raw_key,
        'x-acting-org-id': agg_b.org_id,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: primary.network,
            item_domain: primary.domain,
            item_type: primary.item_type,
            item_id: seeker_item_id,
          },
          target_item: {
            item_network: secondary.network,
            item_domain: secondary.domain,
            item_type: secondary.item_type,
            item_id: provider_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          acting_as_user_id: seeker_user_id,
          ...(initiator_consent !== undefined ? { consent: initiator_consent } : {}),
        },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('network_service acts for a user onboarded by aggregator A — succeeds (cross-aggregator scope)', async () => {
    // The seeker user was onboarded by agg_a; aggregator B would be
    // rejected (test above). network_service must succeed and stamp the
    // audit columns with the network_service org_id.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: primary.network,
            item_domain: primary.domain,
            item_type: primary.item_type,
            item_id: seeker_item_id,
          },
          target_item: {
            item_network: secondary.network,
            item_domain: secondary.domain,
            item_type: secondary.item_type,
            item_id: provider_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          acting_as_user_id: seeker_user_id,
          ...(initiator_consent !== undefined ? { consent: initiator_consent } : {}),
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const action_id = res.json().results[0].action_id;

    const rows = await db
      .select({
        source_item_owner: itemActionsTable.source_item_owner,
        performed_by_org_id: itemActionsTable.performed_by_org_id,
        performed_by_service_user_id:
          itemActionsTable.performed_by_service_user_id,
      })
      .from(itemActionsTable)
      .where(
        and(
          eq(itemActionsTable.partition_network, primary.network),
          eq(itemActionsTable.action_type, 'connect'),
          eq(itemActionsTable.action_id, action_id),
        ),
      )
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_item_owner).toBe(seeker_user_id);
    expect(rows[0].performed_by_org_id).toBe(ns.org_id);
    expect(rows[0].performed_by_service_user_id).toBe(ns.user_id);
  });

  it('network_service points at non-existent user_id — returns 422 USER_NOT_FOUND', async () => {
    const fakeUserId = `usr_does_not_exist_${randomUUID().slice(0, 8)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: primary.network,
            item_domain: primary.domain,
            item_type: primary.item_type,
            item_id: seeker_item_id,
          },
          target_item: {
            item_network: secondary.network,
            item_domain: secondary.domain,
            item_type: secondary.item_type,
            item_id: provider_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          acting_as_user_id: fakeUserId,
          ...(initiator_consent !== undefined ? { consent: initiator_consent } : {}),
        },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'USER_NOT_FOUND' });
  });
});
