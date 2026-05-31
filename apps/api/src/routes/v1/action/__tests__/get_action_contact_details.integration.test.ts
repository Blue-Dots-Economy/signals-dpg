/**
 * Plan PII-reveal Task 9 — integration test for GET
 * /api/v1/action/:action_id/contact-details against a real Postgres +
 * Redis.
 *
 * Mirrors the shape of on_behalf_of.integration.test.ts in this same
 * directory:
 *   - boots a real Fastify on API_PORT, lazy-imports drizzle (so the
 *     suite is `.skip`'d cleanly when POSTGRES_URL/POSTGRES_USER is
 *     absent),
 *   - seeds an aggregator-type service org so /admin/participant can
 *     onboard real users,
 *   - onboards alice (seeker) and bob (provider) as participants, which
 *     creates real profile_1.0 items including private fields landing
 *     in item_private_state,
 *   - then mints per-user apikeys so the action endpoints see
 *     request.user.id == alice/bob via the apikey auth path.
 *
 * Why purple_dot, not blue_dot? The repo's .env declares
 * SERVED_DOMAINS=purple_dot/seeker,purple_dot/provider, and only
 * purple_dot's `connect` action declares `reveals_pii_on_status:
 * ["accepted"]` on both directions (seeker→provider AND
 * provider→seeker). purple_dot profile_1.0 also marks beneficiary_name,
 * mobile_number, etc. as `private: true`, so we can assert the merged
 * item_state in the reveal response includes a private-only field.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration -- get_action_contact_details
 *
 * Cleanup: afterAll deletes seeded participant + service-user rows;
 * pii_reveal_audit, items, and item_actions cascade or are wiped
 * explicitly (no FK from these to user).
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

describeIf(`GET /action/:action_id/contact-details (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let piiRevealAuditTable: typeof import('@api/db/postgres/schema').pii_reveal_audit;
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;

  // Fastify must listen on the port the network config declares for
  // purple_dot, otherwise INVALID_TARGET_INSTANCE fires when
  // /action/perform calls /network/action/perform via HTTP loopback.
  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  // Aggregator service org — used to onboard alice + bob via
  // /admin/participant. Seeded directly via drizzle, mirroring
  // on_behalf_of.integration.test.ts.
  const agg = {
    org_id: `org_${randomUUID()}`,
    user_id: `usr_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `pii-reveal-agg-${Date.now()}`,
    user_email: `pii-reveal-agg-${Date.now()}@signals.local`,
  };

  // Per-participant apikeys minted post-onboarding so /action/* sees
  // request.user.id === alice / bob (apikey auth resolves user via
  // apikey.userId). These are NOT for service-tier acting-on-behalf —
  // they're authenticating the participant as themselves.
  const alice_apikey_id = `key_${randomUUID()}`;
  const alice_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const bob_apikey_id = `key_${randomUUID()}`;
  const bob_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;

  // Config-driven binding resolution — populated in beforeAll.
  let primary: ResolvedBinding;    // seeker
  let secondary: ResolvedBinding;  // provider

  // Populated by /admin/participant + first action call.
  const seeded_participant_ids: string[] = [];
  let alice_user_id: string;
  let alice_item_id: string;
  let bob_user_id: string;
  let bob_item_id: string;
  let action_id: string;

  // Private values asserted later — alice's mobile_number is private on
  // the purple_dot seeker schema. We seed a recognisable value so the
  // assertion can be exact.
  const alice_private_mobile = '9000099001';
  const bob_private_phone = '9000099002';

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const api_schema_mod = await import('@api/db/postgres/schema');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    piiRevealAuditTable = api_schema_mod.pii_reveal_audit;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;

    // Resolve network/domain/item_type/schema from the served config so
    // the suite isn't hardcoded to purple_dot. SERVED_DOMAINS determines
    // primary (seeker) and secondary (provider) at runtime.
    const bindings = await resolveBindings();
    primary = bindings.primary;
    if (!bindings.secondary) {
      throw new Error(
        'get_action_contact_details integration suite requires two served domains ' +
        '(seeker + provider). Set SERVED_DOMAINS="<network>/seeker,<network>/provider".',
      );
    }
    secondary = bindings.secondary;

    const { admin_routes } = await import('../../admin/admin_routes.js');
    const action_routes_mod = await import('../action_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
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

    // Seed the aggregator org + service user + member + apikey row.
    await db.insert(organization).values({
      id: agg.org_id,
      slug: agg.slug,
      name: `${agg.slug} (integration aggregator)`,
      type: 'aggregator',
      createdAt: now,
    });
    await db.insert(user).values({
      id: agg.user_id,
      email: agg.user_email,
      name: agg.slug,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(member).values({
      id: agg.member_id,
      organizationId: agg.org_id,
      userId: agg.user_id,
      role: 'service',
      createdAt: now,
    });
    const agg_hashed_key = createHash('sha256').update(agg.raw_key).digest('base64url');
    await db.insert(apikey).values({
      id: agg.apikey_id,
      name: agg.slug,
      key: agg_hashed_key,
      userId: agg.user_id,
      referenceId: agg.user_id,
      configId: 'default',
      start: agg.raw_key.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: now,
      updatedAt: now,
    });

    // Onboard alice as a seeker. /admin/participant creates the user +
    // member row + a profile item; the private fields land in
    // item_private_state per the schema's `private: true` flags. We
    // merge the generated minimal state with a known mobile_number so
    // the assertion later can be exact.
    const alice_item_state = {
      ...generateMinimalItemState(primary.schema),
      mobile_number: alice_private_mobile,
    };
    const aliceRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg.raw_key,
        'x-acting-org-id': agg.org_id,
        'content-type': 'application/json',
      },
      payload: {
        phone_number:
          '+919910' + Math.floor(100000 + Math.random() * 900000).toString(),
        name: 'Alice PII Seeker',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id: `pii_reveal_alice_${Date.now()}`,
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: alice_item_state,
      },
    });
    if (aliceRes.statusCode !== 200) {
      throw new Error(
        `seed alice onboard failed: ${aliceRes.statusCode} ${aliceRes.body}`,
      );
    }
    const aliceBody = aliceRes.json();
    alice_user_id = aliceBody.user_id;
    alice_item_id = aliceBody.items[0].item_id;
    expect(aliceBody.user_existed).toBe(false);
    seeded_participant_ids.push(alice_user_id);

    // Onboard bob as a provider. Merge the generated minimal state with
    // a known contact_phone so the assertion later can be exact.
    const bob_item_state = {
      ...generateMinimalItemState(secondary.schema),
      contact_phone: bob_private_phone,
    };
    const bobRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg.raw_key,
        'x-acting-org-id': agg.org_id,
        'content-type': 'application/json',
      },
      payload: {
        phone_number:
          '+919911' + Math.floor(100000 + Math.random() * 900000).toString(),
        name: 'Bob PII Provider',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id: `pii_reveal_bob_${Date.now()}`,
        network: secondary.network,
        domain: secondary.domain,
        item_type: secondary.item_type,
        item_state: bob_item_state,
      },
    });
    if (bobRes.statusCode !== 200) {
      throw new Error(
        `seed bob onboard failed: ${bobRes.statusCode} ${bobRes.body}`,
      );
    }
    const bobBody = bobRes.json();
    bob_user_id = bobBody.user_id;
    bob_item_id = bobBody.items[0].item_id;
    expect(bobBody.user_existed).toBe(false);
    seeded_participant_ids.push(bob_user_id);

    // Mint per-participant apikeys so we can authenticate as alice or
    // bob without going through better-auth's session machinery.
    // auth_middleware verifies the apikey and resolves request.user
    // from apikey.userId — exactly what the handler reads.
    const alice_hashed = createHash('sha256').update(alice_raw_key).digest('base64url');
    await db.insert(apikey).values({
      id: alice_apikey_id,
      name: `alice-int-${Date.now()}`,
      key: alice_hashed,
      userId: alice_user_id,
      referenceId: alice_user_id,
      configId: 'default',
      start: alice_raw_key.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
    const bob_hashed = createHash('sha256').update(bob_raw_key).digest('base64url');
    await db.insert(apikey).values({
      id: bob_apikey_id,
      name: `bob-int-${Date.now()}`,
      key: bob_hashed,
      userId: bob_user_id,
      referenceId: bob_user_id,
      configId: 'default',
      start: bob_raw_key.slice(0, 6),
      prefix: 'sk_signals_',
      enabled: true,
      rateLimitEnabled: false,
      createdAt: now,
      updatedAt: now,
    });

    // Alice files a `connect` action targeting bob's item — self-acted
    // (no x-acting-org-id header). reveals_pii_on_status=["accepted"]
    // is declared for seeker→provider in the network config.
    // Resolve the interaction's consent text so we can include it in
    // the request body (required since PR #38 when consent_text_initiator
    // is declared).
    const performConsent = await resolveInteractionConsent({
      actionType: 'connect',
      fromNetwork: primary.network,
      fromDomain: primary.domain,
      fromItemType: primary.item_type,
      toNetwork: secondary.network,
      toDomain: secondary.domain,
      toItemType: secondary.item_type,
    });
    const performRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': alice_raw_key,
        'content-type': 'application/json',
      },
      payload: {
        action_type: 'connect',
        source_item: {
          item_network: primary.network,
          item_domain: primary.domain,
          item_type: primary.item_type,
          item_id: alice_item_id,
        },
        target_item: {
          item_network: secondary.network,
          item_domain: secondary.domain,
          item_type: secondary.item_type,
          item_id: bob_item_id,
          item_instance_url: base_url,
        },
        requirements_snapshot: {},
        ...(consentAck(performConsent?.consent_text_initiator) !== undefined
          ? { consent: consentAck(performConsent?.consent_text_initiator) }
          : {}),
      },
    });
    if (performRes.statusCode !== 201) {
      throw new Error(
        `seed action.perform failed: ${performRes.statusCode} ${performRes.body}`,
      );
    }
    action_id = performRes.json().action_id;

    // Bob accepts. /update-status enforces target_item_owner = caller,
    // which matches bob's apikey-resolved user_id. "accepted" is in
    // reveals_pii_on_status so the route requires consent_text_receiver
    // acknowledgement (PR #38).
    const updateConsent = await resolveInteractionConsent({
      actionType: 'connect',
      fromNetwork: primary.network,
      fromDomain: primary.domain,
      fromItemType: primary.item_type,
      toNetwork: secondary.network,
      toDomain: secondary.domain,
      toItemType: secondary.item_type,
    });
    const updateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: {
        'x-api-key': bob_raw_key,
        'content-type': 'application/json',
      },
      payload: {
        action_id,
        action_status: 'accepted',
        remarks: 'Happy to help.',
        ...(consentAck(updateConsent?.consent_text_receiver) !== undefined
          ? { consent: consentAck(updateConsent?.consent_text_receiver) }
          : {}),
      },
    });
    if (updateRes.statusCode !== 200) {
      throw new Error(
        `seed action.update-status failed: ${updateRes.statusCode} ${updateRes.body}`,
      );
    }
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      // Wipe pii_reveal_audit rows tied to the seeded participants
      // first (no FK so no cascade), then item_actions, then items,
      // then users + apikeys + org.
      if (seeded_participant_ids.length > 0) {
        try {
          await db
            .delete(piiRevealAuditTable)
            .where(
              inArray(piiRevealAuditTable.viewerUserId, seeded_participant_ids),
            );
        } catch {
          /* table may not exist if test bailed before insert; ignore */
        }
        await db
          .delete(itemActionsTable)
          .where(
            inArray(itemActionsTable.source_item_owner, seeded_participant_ids),
          );
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, seeded_participant_ids));
        await db.delete(user).where(inArray(user.id, seeded_participant_ids));
      }
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg.apikey_id, alice_apikey_id, bob_apikey_id]));
      await db.delete(user).where(inArray(user.id, [agg.user_id]));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg.org_id]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  it('alice (source) sees bob with private fields revealed; audit row written', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/action/${action_id}/contact-details`,
      headers: { 'x-api-key': alice_raw_key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action_id).toBe(action_id);
    expect(body.action_status).toBe('accepted');
    expect(body.other_actor.item.item_id).toBe(bob_item_id);
    expect(body.other_actor.item.created_by).toBe(bob_user_id);
    // bob's contact_phone is a `private: true` field on the purple_dot
    // provider profile_1.0 schema — its presence in item_state proves
    // the merge of item_private_state landed.
    expect(body.other_actor.item.item_state.contact_phone).toBe(bob_private_phone);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('bob (target) sees alice with private fields revealed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/action/${action_id}/contact-details`,
      headers: { 'x-api-key': bob_raw_key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.other_actor.item.item_id).toBe(alice_item_id);
    expect(body.other_actor.item.created_by).toBe(alice_user_id);
    expect(body.other_actor.item.item_state.mobile_number).toBe(alice_private_mobile);
  });

  it('pii_reveal_audit has exactly two rows after the first two reveals', async () => {
    const rows = await db
      .select({
        viewer_user_id: piiRevealAuditTable.viewerUserId,
        revealed_item_id: piiRevealAuditTable.revealedItemId,
        revealed_item_owner: piiRevealAuditTable.revealedItemOwner,
        revealed_action_status_at_view:
          piiRevealAuditTable.revealedActionStatusAtView,
      })
      .from(piiRevealAuditTable)
      .where(eq(piiRevealAuditTable.actionId, action_id));

    expect(rows).toHaveLength(2);
    const pairs = rows.map((r) => ({
      viewer: r.viewer_user_id,
      revealed_item: r.revealed_item_id,
    }));
    expect(pairs).toContainEqual({
      viewer: alice_user_id,
      revealed_item: bob_item_id,
    });
    expect(pairs).toContainEqual({
      viewer: bob_user_id,
      revealed_item: alice_item_id,
    });
    for (const r of rows) {
      expect(r.revealed_action_status_at_view).toBe('accepted');
    }
  });

  it('a second alice-as-source reveal appends a 3rd audit row (no dedup)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/action/${action_id}/contact-details`,
      headers: { 'x-api-key': alice_raw_key },
    });
    expect(res.statusCode).toBe(200);

    const rows = await db
      .select({ viewer_user_id: piiRevealAuditTable.viewerUserId })
      .from(piiRevealAuditTable)
      .where(
        and(
          eq(piiRevealAuditTable.actionId, action_id),
          eq(piiRevealAuditTable.viewerUserId, alice_user_id),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const totalRows = await db
      .select({ id: piiRevealAuditTable.revealId })
      .from(piiRevealAuditTable)
      .where(eq(piiRevealAuditTable.actionId, action_id));
    expect(totalRows).toHaveLength(3);
  });
});
