/**
 * Phase 5a Task 2 — integration test for the guardian-OTP-gated
 * profile-consent routes (`POST /u18/profile-consent/issue` + `/verify`).
 *
 * Seeds a minor ward (via the real `/u18/dob` + `/u18/guardian` endpoints, so
 * `minor_guardian` + the guardian's own contact are populated exactly the way
 * production traffic would populate them) and a DRAFT profile item owned by
 * that ward with a complete `item_state` (so the classifier would call it
 * `live` once profile_creation consent exists). The item is seeded via
 * `createItemInternal` (the same helper `create_item` uses) rather than a raw
 * `db.insert`, because `promoteItemOnProfileConsent` re-fetches the item's
 * schema by its `item_schema_url` — in local dev config that URL is this
 * instance's own `/api/v1/network/schema/...` endpoint, so a minimal Fastify
 * app registering only `network_routes` is stood up to serve that self-fetch
 * (mirrors `services/__tests__/promote_minor_gate.integration.test.ts`).
 *
 * Flow under test:
 *   1. POST /u18/profile-consent/issue → 200 { otpSent: true }.
 *   2. Read the OTP from redis (`guardian_otp:code:<userId>:profile:<itemId>`).
 *   3. POST /u18/profile-consent/verify with that OTP → 200
 *      { verified: true, promoted: true }; item flips to `live`; a
 *      guardian-source `profile_creation` consent_record row exists.
 *
 * The U18 guardian gate in `promoteItemOnProfileConsent` only fires when the
 * served domain is `guardian_consent_required` (network.json) — blue_dot's
 * seeker + provider domains are both gated, so this documents (rather than
 * silently passes) a skip if the locally served domain isn't gated.
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm --filter api test:integration src/routes/v1/consent/__tests__/u18_profile_consent.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';

// Guardian OTP send → no-op (no real notifier). Mocked before app import.
vi.mock('@/utils/notificationClient', () => ({ getNotificationClient: () => ({ notify: async () => {} }) }));

import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian, consent_record } from '@api/db/postgres/schema';
import { items, ensureItemPartition } from '@dpg/database';
import { redis } from '@api/db/secondary/redis';
import { buildU18TestApp } from './u18_test_helpers';
import { createItemInternal } from '@/services/item_service';
import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired } from '@/services/minor';
import {
  generateMinimalItemState,
  resolveBindings,
} from '../../__tests__/integration_helpers';

let ctx: Awaited<ReturnType<typeof buildU18TestApp>>;
let networkApp: FastifyInstance | undefined;
let itemId: string | undefined;
let preSeededItemId: string | undefined;
let servedNetwork: string;
let servedDomain: string;
let servedItemType: string;
let gated = false;

const network_listen_port = Number(process.env.API_PORT ?? 2742);

beforeAll(async () => {
  ctx = await buildU18TestApp();

  // Stand up a minimal app serving only network_routes so
  // promoteItemOnProfileConsent's self-fetch of the item schema (by
  // item_schema_url, which points at this instance's own
  // /api/v1/network/schema/... route in local dev) resolves.
  const network_routes_mod = await import('../../network/network_routes.js');
  networkApp = Fastify().withTypeProvider<ZodTypeProvider>();
  networkApp.setValidatorCompiler(validatorCompiler);
  networkApp.setSerializerCompiler(serializerCompiler);
  await networkApp.register(network_routes_mod.default, { prefix: '/api/v1/network' });
  try {
    await networkApp.listen({ port: network_listen_port, host: '127.0.0.1' });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === 'EADDRINUSE') {
      throw new Error(
        `u18_profile_consent integration test requires port ${network_listen_port} to be free ` +
          `(set API_PORT). Is the dev server already running?`,
      );
    }
    throw err;
  }
});

afterAll(async () => {
  await db.delete(consent_record).where(eq(consent_record.userId, ctx.userId));
  await db.delete(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
  if (itemId && servedNetwork && servedDomain && servedItemType) {
    await db
      .delete(items)
      .where(
        and(
          eq(items.item_network, servedNetwork),
          eq(items.item_domain, servedDomain),
          eq(items.item_type, servedItemType),
          eq(items.item_id, itemId),
        ),
      );
  }
  if (itemId) {
    await redis.del(`guardian_otp:code:${ctx.userId}:profile:${itemId}`);
    await redis.del(`guardian_otp:rl:${ctx.userId}:profile:${itemId}`);
    await redis.del(`guardian_otp:vrl:${ctx.userId}:profile:${itemId}`);
  }
  if (preSeededItemId && servedNetwork && servedDomain && servedItemType) {
    await db
      .delete(items)
      .where(
        and(
          eq(items.item_network, servedNetwork),
          eq(items.item_domain, servedDomain),
          eq(items.item_type, servedItemType),
          eq(items.item_id, preSeededItemId),
        ),
      );
    await redis.del(`guardian_otp:code:${ctx.userId}:profile:${preSeededItemId}`);
    await redis.del(`guardian_otp:rl:${ctx.userId}:profile:${preSeededItemId}`);
    await redis.del(`guardian_otp:vrl:${ctx.userId}:profile:${preSeededItemId}`);
  }
  await redis.del(`guardian_otp:code:${ctx.userId}:guardian`);
  await redis.del(`guardian_otp:rl:${ctx.userId}:guardian`);
  await redis.del(`guardian_otp:vrl:${ctx.userId}:guardian`);
  await ctx.close();
  if (networkApp) await networkApp.close();
});

describe('U18 profile-consent issue/verify (integration)', () => {
  it('sets up a minor ward + a draft, complete profile item owned by them', async () => {
    if (apiConfig.served_domains.length === 0) {
      throw new Error(
        'u18_profile_consent integration suite requires SERVED_DOMAINS to have at least one entry',
      );
    }

    const bindings = await resolveBindings();
    servedNetwork = bindings.primary.network;
    servedDomain = bindings.primary.domain;
    servedItemType = bindings.primary.item_type;

    const networkConfig = await getNetworkConfigById(servedNetwork);
    gated = guardianConsentRequired(networkConfig, servedDomain);
    if (!gated) {
      // eslint-disable-next-line no-console
      console.warn(
        `u18_profile_consent: served domain "${servedDomain}" on network "${servedNetwork}" ` +
          'is not guardian_consent_required — the U18 profile-consent gate cannot be exercised here. ' +
          'Run with SERVED_DOMAINS including a gated seeker/provider domain.',
      );
      expect(true).toBe(true);
      return;
    }

    // Ward is a clear minor (born 2012).
    const dobRes = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/dob',
      headers: { 'x-api-key': ctx.rawKey },
      payload: { network: servedNetwork, birthYear: 2012, birthMonth: 3 },
    });
    expect(dobRes.statusCode).toBe(200);
    expect(dobRes.json().isMinor).toBe(true);

    // Guardian details (encrypted at rest) so getGuardianContactPlaintext resolves.
    const guardianRes = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: servedNetwork, guardianName: 'Parent', guardianContact: 'parent@example.com',
        guardianContactType: 'email', guardianDeclarationAccepted: true,
      },
    });
    expect(guardianRes.statusCode).toBe(200);
    expect(guardianRes.json().otpSent).toBe(true);

    // Draft item, owned by the ward, with a complete item_state (so the
    // classifier would call it `live` once consent exists).
    await ensureItemPartition(db, servedNetwork, servedDomain);
    const item_state = generateMinimalItemState(bindings.primary.schema);
    const created = await createItemInternal(db, {
      item_network: servedNetwork,
      item_domain: servedDomain,
      item_type: servedItemType,
      item_state,
      created_by: ctx.userId,
    });
    itemId = created.itemId;

    const [seeded] = await db
      .select({ lifecycle_status: items.lifecycle_status })
      .from(items)
      .where(eq(items.item_id, itemId));
    expect(seeded.lifecycle_status).toBe('draft');
  });

  it('issue → 200 { otpSent: true }', async () => {
    if (!gated || !itemId) return;

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/profile-consent/issue',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: servedNetwork, item_domain: servedDomain, item_type: servedItemType, item_id: itemId,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ otpSent: true });
  });

  it('verify with the correct OTP → 200 { verified: true, promoted: true }, item goes live, guardian profile_creation row recorded', async () => {
    if (!gated || !itemId) return;

    const otp = await redis.get(`guardian_otp:code:${ctx.userId}:profile:${itemId}`);
    expect(otp).toMatch(/^\d{6}$/);

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/profile-consent/verify',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: servedNetwork, item_domain: servedDomain, item_type: servedItemType, item_id: itemId, otp,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verified: true, promoted: true });

    const [afterVerify] = await db
      .select({ lifecycle_status: items.lifecycle_status })
      .from(items)
      .where(eq(items.item_id, itemId));
    expect(afterVerify.lifecycle_status).toBe('live');

    const [guardianRow] = await db
      .select()
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, ctx.userId),
          eq(consent_record.itemId, itemId),
          eq(consent_record.level, 'item'),
          eq(consent_record.consentCategory, 'profile_creation'),
          eq(consent_record.source, 'guardian'),
        ),
      );
    expect(guardianRow).toBeDefined();
  });

  it('rejects a wrong OTP with 400', async () => {
    if (!gated || !itemId) return;

    // Nonce was consumed by the previous (successful) verify → no valid code.
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/profile-consent/verify',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: servedNetwork, item_domain: servedDomain, item_type: servedItemType, item_id: itemId, otp: '000000',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // Regression: `consent_record_profile_creation_unique` is partial on
  // (user_id, item_id) WHERE level='item' AND consent_category='profile_creation'
  // — it does NOT include `source`. If the minor already self-created a
  // `source='profile'` row on this item (e.g. via create_item's own
  // profile-creation consent capture) before the guardian OTP is verified, a
  // plain guardian insert would 23505, silently drop the guardian row, and
  // the go-live gate (which requires a `source='guardian'` row) would never
  // pass even though the route reports success. The verify handler must
  // upsert the existing row to `source='guardian'` instead.
  it('verify upgrades a pre-existing source=profile row to source=guardian (no 23505 deadlock)', async () => {
    if (!gated) return;

    await ensureItemPartition(db, servedNetwork, servedDomain);
    const item_state = generateMinimalItemState((await resolveBindings()).primary.schema);
    const created = await createItemInternal(db, {
      item_network: servedNetwork,
      item_domain: servedDomain,
      item_type: servedItemType,
      item_state,
      created_by: ctx.userId,
    });
    preSeededItemId = created.itemId;

    // Simulate a minor self-create (or the adult /profile-accept path) having
    // already recorded a `source='profile'` profile_creation row for this item.
    await db.insert(consent_record).values({
      level: 'item', consentCategory: 'profile_creation', userId: ctx.userId, itemId: preSeededItemId,
      network: servedNetwork, brand: null, documentVersion: 1,
      source: 'profile', acceptedAt: new Date(), metadata: { variant: 'self' },
    });

    const issueRes = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/profile-consent/issue',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: servedNetwork, item_domain: servedDomain, item_type: servedItemType, item_id: preSeededItemId,
      },
    });
    expect(issueRes.statusCode).toBe(200);
    expect(issueRes.json()).toEqual({ otpSent: true });

    const otp = await redis.get(`guardian_otp:code:${ctx.userId}:profile:${preSeededItemId}`);
    expect(otp).toMatch(/^\d{6}$/);

    const verifyRes = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/profile-consent/verify',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: servedNetwork, item_domain: servedDomain, item_type: servedItemType, item_id: preSeededItemId, otp,
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json()).toEqual({ verified: true, promoted: true });

    const [afterVerify] = await db
      .select({ lifecycle_status: items.lifecycle_status })
      .from(items)
      .where(eq(items.item_id, preSeededItemId));
    expect(afterVerify.lifecycle_status).toBe('live');

    const profileCreationRows = await db
      .select()
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, ctx.userId),
          eq(consent_record.itemId, preSeededItemId),
          eq(consent_record.level, 'item'),
          eq(consent_record.consentCategory, 'profile_creation'),
        ),
      );
    // The pre-existing `source='profile'` row must have been upgraded in
    // place, not duplicated alongside a new `source='guardian'` row.
    expect(profileCreationRows).toHaveLength(1);
    expect(profileCreationRows[0].source).toBe('guardian');
  });
});
