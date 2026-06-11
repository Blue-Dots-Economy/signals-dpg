/**
 * Plan B Task 15 — integration test for the consent gate and event-payload
 * snapshot across the full chain: Fastify → consent gate → network handler →
 * buildActionEventPayload → insertActionEvent → Postgres.
 *
 * Network: purple_dot   Action: connect   Interaction: seeker→provider
 *   - consent_text_initiator declared → /action/perform gate
 *   - consent_text_receiver declared AND reveals_pii_on_status: ["accepted"]
 *     → /action/update-status gate when transitioning to "accepted"
 *
 * Requirements: purple_dot connect has an empty requirement_schema
 * ({ type: "object", properties: {} }) so requirements_snapshot can be {}.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration -- consent_flow
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
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

// Consent texts as declared in examples/schemas/purple_dot/network.json
const INITIATOR_CONSENT_TEXT =
  'I agree to share my contact details (name, email, phone) with this provider if they accept my request.';
const RECEIVER_CONSENT_TEXT =
  'I agree to share my contact details (name, email, phone) with the requester.';

describeIf(`consent flow integration (purple_dot/connect)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let actionEventsTable: typeof import('@dpg/database').action_events;
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;

  // Fastify must listen on the port the network config declares for
  // purple_dot, otherwise INVALID_TARGET_INSTANCE fires when
  // /action/perform proxies to /network/action/perform via HTTP loopback.
  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  // Aggregator service org — used to onboard alice (seeker) and bob (provider).
  const agg = {
    org_id: `org_${randomUUID()}`,
    user_id: `usr_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `consent-flow-agg-${Date.now()}`,
    user_email: `consent-flow-agg-${Date.now()}@signals.local`,
  };

  // Per-participant apikeys so we can authenticate as alice or bob
  // without going through better-auth's session machinery.
  const alice_apikey_id = `key_${randomUUID()}`;
  const alice_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const bob_apikey_id = `key_${randomUUID()}`;
  const bob_raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;

  const seeded_participant_ids: string[] = [];
  let alice_user_id: string;
  let alice_item_id: string;
  let bob_user_id: string;
  let bob_item_id: string;

  beforeAll(async () => {
    // Lazy-imported so CI without a live DB doesn't blow up on import.
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    actionEventsTable = database_pkg.action_events;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;

    const { admin_routes } = await import('../../admin/admin_routes.js');
    const action_routes_mod = await import('../action_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(action_routes_mod.default, { prefix: '/api/v1/action' });
    await app.register(network_routes_mod.default, {
      prefix: '/api/v1/network',
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

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    // Seed aggregator org + service user + member + apikey.
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
    const agg_hashed_key = createHash('sha256')
      .update(agg.raw_key)
      .digest('base64url');
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

    // Onboard alice as a purple_dot seeker.
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
          '+919930' + Math.floor(100000 + Math.random() * 900000).toString(),
        name: 'Alice Consent Seeker',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id: `consent_flow_alice_${Date.now()}`,
        network: 'purple_dot',
        domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {
          beneficiary_name: 'Alice Consent Seeker',
          mobile_number: '9000099100',
          age: 28,
          gender: 'Female',
          disability_type: ['Locomotor Disability'],
          disability_percentage: 50,
          looking_for: ['Assistive Devices'],
          looking_for_details: 'Need a wheelchair.',
          address: '1 Test Street, Pune, Maharashtra',
          documents_available: ['Aadhaar'],
        },
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
    seeded_participant_ids.push(alice_user_id);

    // Onboard bob as a purple_dot provider.
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
          '+919931' + Math.floor(100000 + Math.random() * 900000).toString(),
        name: 'Bob Consent Provider',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        source_id: `consent_flow_bob_${Date.now()}`,
        network: 'purple_dot',
        domain: 'provider',
        item_type: 'profile_1.0',
        item_state: {
          contact_name: 'Bob Consent Provider',
          contact_phone: '9000099101',
          contact_email: 'bob.consent@signals.local',
          provider_category: 'NGO / Trust',
          organisation_name: 'Consent Test NGO',
          disabilities_served: ['Locomotor Disability'],
          services_offered: ['Assistive Devices'],
          service_cities: ['Pune'],
          official_address: '99 Provider Street, Pune, Maharashtra',
          service_details: 'Provides assistive devices.',
        },
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
    seeded_participant_ids.push(bob_user_id);

    // Mint per-participant apikeys so /action/* sees request.user.id == alice/bob.
    const alice_hashed = createHash('sha256')
      .update(alice_raw_key)
      .digest('base64url');
    await db.insert(apikey).values({
      id: alice_apikey_id,
      name: `alice-consent-int-${Date.now()}`,
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
    const bob_hashed = createHash('sha256')
      .update(bob_raw_key)
      .digest('base64url');
    await db.insert(apikey).values({
      id: bob_apikey_id,
      name: `bob-consent-int-${Date.now()}`,
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
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      if (seeded_participant_ids.length > 0) {
        await db
          .delete(itemActionsTable)
          .where(
            inArray(itemActionsTable.source_item_owner, seeded_participant_ids),
          );
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, seeded_participant_ids));
        await db
          .delete(user)
          .where(inArray(user.id, seeded_participant_ids));
      }
      await db
        .delete(apikey)
        .where(
          inArray(apikey.id, [agg.apikey_id, alice_apikey_id, bob_apikey_id]),
        );
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

  it('returns 422 CONSENT_REQUIRED on /action/perform when consent_text_initiator is declared and body omits consent', async () => {
    // purple_dot connect (seeker→provider) declares consent_text_initiator.
    // A request without the consent field must be rejected before the action
    // is created.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': alice_raw_key,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: 'purple_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_id: alice_item_id,
          },
          target_item: {
            item_network: 'purple_dot',
            item_domain: 'provider',
            item_type: 'profile_1.0',
            item_id: bob_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          // consent field intentionally omitted
        },
      ],
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.results[0]).toMatchObject({ status: 'error', error: 'CONSENT_REQUIRED' });
    expect(typeof body.results[0].message).toBe('string');
    expect(body.results[0].message.length).toBeGreaterThan(0);
  });

  it('persists initiator consent snapshot in event_payload when /action/perform includes valid consent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': alice_raw_key,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: 'purple_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_id: alice_item_id,
          },
          target_item: {
            item_network: 'purple_dot',
            item_domain: 'provider',
            item_type: 'profile_1.0',
            item_id: bob_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          consent: {
            acknowledged: true,
            text: INITIATOR_CONSENT_TEXT,
          },
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    const responseBody = res.json();
    expect(responseBody.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(responseBody.results[0].action_id).toBeTruthy();
    expect(responseBody.results[0].action_status).toBe('created');

    const action_id: string = responseBody.results[0].action_id;

    // Query the action_events table for the new event row and assert the
    // consent snapshot was persisted verbatim.
    const eventRows = await db
      .select({
        event_payload: actionEventsTable.event_payload,
        action_status: actionEventsTable.action_status,
        update_count: actionEventsTable.update_count,
      })
      .from(actionEventsTable)
      .where(
        and(
          eq(actionEventsTable.action_id, action_id),
          eq(actionEventsTable.update_count, 0),
        ),
      )
      .limit(1);

    expect(eventRows).toHaveLength(1);
    const payload = eventRows[0].event_payload as Record<string, unknown>;
    expect(eventRows[0].action_status).toBe('created');

    // The consent sub-object must be present with the exact values sent.
    const consent = payload.consent as Record<string, unknown>;
    expect(consent).toBeTruthy();
    expect(consent.acknowledged).toBe(true);
    expect(consent.text).toBe(INITIATOR_CONSENT_TEXT);
    // consented_at must be a valid ISO timestamp.
    expect(typeof consent.consented_at).toBe('string');
    expect(Number.isFinite(Date.parse(consent.consented_at as string))).toBe(
      true,
    );
  });

  it('rejects /action/update-status to "accepted" with 403 when receiver consent is missing, then accepts with consent and persists snapshot', async () => {
    // First, create a fresh action (with initiator consent) that bob will
    // later update-status. We create a new action rather than reusing the
    // one from the previous test to keep test isolation clean.
    const performRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': alice_raw_key,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_type: 'connect',
          source_item: {
            item_network: 'purple_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_id: alice_item_id,
          },
          target_item: {
            item_network: 'purple_dot',
            item_domain: 'provider',
            item_type: 'profile_1.0',
            item_id: bob_item_id,
            item_instance_url: base_url,
          },
          requirements_snapshot: {},
          consent: {
            acknowledged: true,
            text: INITIATOR_CONSENT_TEXT,
          },
        },
      ],
    });
    if (performRes.statusCode !== 201) {
      throw new Error(
        `seed perform failed: ${performRes.statusCode} ${performRes.body}`,
      );
    }
    const action_id: string = performRes.json().results[0].action_id;

    // Step 1: Bob tries to accept WITHOUT consent — must be rejected.
    // The purple_dot connect interaction declares consent_text_receiver AND
    // reveals_pii_on_status: ["accepted"], so update-status to "accepted"
    // requires receiver consent.
    const rejectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: {
        'x-api-key': bob_raw_key,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_id,
          action_status: 'accepted',
          // consent intentionally omitted
        },
      ],
    });

    expect(rejectRes.statusCode).toBe(422);
    const rejectBody = rejectRes.json();
    expect(rejectBody.results[0]).toMatchObject({ status: 'error', error: 'CONSENT_REQUIRED' });

    // Step 2: Bob accepts WITH consent — must succeed.
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/action/update-status',
      headers: {
        'x-api-key': bob_raw_key,
        'content-type': 'application/json',
      },
      payload: [
        {
          action_id,
          action_status: 'accepted',
          consent: {
            acknowledged: true,
            text: RECEIVER_CONSENT_TEXT,
          },
        },
      ],
    });

    expect(acceptRes.statusCode).toBe(200);
    const acceptBody = acceptRes.json();
    expect(acceptBody.results[0].action_id).toBe(action_id);
    expect(acceptBody.results[0].action_status).toBe('accepted');

    // Query the event row written by update-status (update_count === 1).
    const eventRows = await db
      .select({
        event_payload: actionEventsTable.event_payload,
        action_status: actionEventsTable.action_status,
      })
      .from(actionEventsTable)
      .where(
        and(
          eq(actionEventsTable.action_id, action_id),
          eq(actionEventsTable.update_count, 1),
        ),
      )
      .limit(1);

    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].action_status).toBe('accepted');

    const payload = eventRows[0].event_payload as Record<string, unknown>;
    const consent = payload.consent as Record<string, unknown>;
    expect(consent).toBeTruthy();
    expect(consent.acknowledged).toBe(true);
    expect(consent.text).toBe(RECEIVER_CONSENT_TEXT);
    expect(typeof consent.consented_at).toBe('string');
    expect(Number.isFinite(Date.parse(consent.consented_at as string))).toBe(
      true,
    );
  });
});
