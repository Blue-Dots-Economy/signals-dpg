import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  U18ProfileConsentBodySchema, U18ProfileConsentResponseSchema, type U18ProfileConsentBody,
  U18ProfileConsentVerifyBodySchema, U18ProfileConsentVerifyResponseSchema, type U18ProfileConsentVerifyBody,
  U18ProfilePrecreateBodySchema, U18ProfilePrecreateResponseSchema, type U18ProfilePrecreateBody,
  U18ProfilePrecreateVerifyBodySchema, U18ProfilePrecreateVerifyResponseSchema, type U18ProfilePrecreateVerifyBody,
  U18ProfileFinalizeBodySchema, U18ProfileFinalizeResponseSchema, type U18ProfileFinalizeBody,
} from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import { getNetworkConfigById } from '@/network_configs';
import { getWardDob, getGuardianContactPlaintext } from '@/services/minor_guardian_repo';
import { resolveConsentVersion } from '@/services/consent_version';
import {
  issueGuardianOtp, verifyGuardianOtp, assertVerifyAttemptAllowed, guardianOtpErrorReply,
} from '@/services/guardian_otp';
import { promoteItemOnProfileConsent, isItemOwnedBy } from '@/services/item_service';
import { guardianProfileConsentRow } from '@/services/guardian_consent_rows';

const profileScope = (userId: string, itemId: string) => `${userId}:profile:${itemId}`;
// Pre-create OTP is scoped to the ward + network + domain (no item yet). The
// verify sets a short-lived token under this key; finalize consumes it.
const precreateScope = (userId: string, network: string, domain: string) =>
  `${userId}:profile_create:${network}:${domain}`;
const precreateTokenKey = (userId: string, network: string, domain: string) =>
  `u18:precreate:${userId}:${network}:${domain}`;
const PRECREATE_TOKEN_TTL_SEC = 900; // 15 min — long enough to fill + submit the form after verifying

async function assertOwnedMinorItem(userId: string, body: { network: string; item_domain: string; item_type: string; item_id: string }) {
  const owned = await isItemOwnedBy(userId, body);
  if (!owned) return { ok: false as const, code: 'NOT_ITEM_OWNER' };
  const dob = await getWardDob(userId);
  if (!dob) return { ok: false as const, code: 'DOB_REQUIRED' };
  if (!isMinor(dob)) return { ok: false as const, code: 'NOT_A_MINOR' };
  return { ok: true as const };
}

type IssueReq = FastifyRequest<{ Body: U18ProfileConsentBody }>;
type VerifyReq = FastifyRequest<{ Body: U18ProfileConsentVerifyBody }>;

export const u18_profile_consent: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/profile-consent/issue', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfileConsentBodySchema, response: { 200: U18ProfileConsentResponseSchema } },
    handler: issue_handler,
  });
  fastify.route({
    url: '/u18/profile-consent/verify', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfileConsentVerifyBodySchema, response: { 200: U18ProfileConsentVerifyResponseSchema } },
    handler: verify_handler,
  });
  fastify.route({
    url: '/u18/profile-consent/precreate/issue', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfilePrecreateBodySchema, response: { 200: U18ProfilePrecreateResponseSchema } },
    handler: precreate_issue_handler,
  });
  fastify.route({
    url: '/u18/profile-consent/precreate/verify', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfilePrecreateVerifyBodySchema, response: { 200: U18ProfilePrecreateVerifyResponseSchema } },
    handler: precreate_verify_handler,
  });
  fastify.route({
    url: '/u18/profile-consent/finalize', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfileFinalizeBodySchema, response: { 200: U18ProfileFinalizeResponseSchema } },
    handler: finalize_handler,
  });
};

/**
 * Assert the caller is a minor on a guardian-gated domain. Shared by the
 * pre-create issue/verify handlers (which run before any item exists, so they
 * can't use `assertOwnedMinorItem`). Returns a typed failure code otherwise.
 */
async function assertMinorGatedDomain(userId: string, network: string, domain: string) {
  const dob = await getWardDob(userId);
  if (!dob) return { ok: false as const, code: 'DOB_REQUIRED', status: 409 };
  if (!isMinor(dob)) return { ok: false as const, code: 'NOT_A_MINOR', status: 409 };
  const networkConfig = await getNetworkConfigById(network);
  if (!guardianConsentRequired(networkConfig, domain)) {
    return { ok: false as const, code: 'NOT_GATED', status: 409 };
  }
  return { ok: true as const };
}

const precreate_issue_handler = async (
  request: FastifyRequest<{ Body: U18ProfilePrecreateBody }>,
  reply: FastifyReply,
) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertMinorGatedDomain(userId, body.network, body.item_domain);
  if (!check.ok) return reply.code(check.status).send({ error: check.code, message: check.code });

  const contact = await getGuardianContactPlaintext(userId);
  if (!contact) return reply.code(409).send({ error: 'GUARDIAN_REQUIRED', message: 'Submit guardian details first' });

  try {
    await issueGuardianOtp({
      scope: precreateScope(userId, body.network, body.item_domain),
      contact: contact.contact,
      contactType: contact.contactType,
    });
  } catch (err) {
    const r = guardianOtpErrorReply(err);
    if (r) return reply.code(r.status).send({ error: r.error, message: r.message });
    request.log.error({ err }, 'Failed to issue pre-create profile-consent OTP');
    return reply.code(500).send({ error: 'OTP_SEND_FAILED', message: 'Failed to send guardian OTP' });
  }
  return reply.code(200).send({ otpSent: true });
};

const precreate_verify_handler = async (
  request: FastifyRequest<{ Body: U18ProfilePrecreateVerifyBody }>,
  reply: FastifyReply,
) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertMinorGatedDomain(userId, body.network, body.item_domain);
  if (!check.ok) return reply.code(check.status).send({ error: check.code, message: check.code });

  const scope = precreateScope(userId, body.network, body.item_domain);
  try {
    await assertVerifyAttemptAllowed(scope);
  } catch (err) {
    const r = guardianOtpErrorReply(err);
    if (r) return reply.code(r.status).send({ error: r.error, message: r.message });
    request.log.error({ err }, 'pre-create verify attempt check failed');
    return reply.code(500).send({ error: 'OTP_VERIFY_FAILED', message: 'Failed to check verify attempts' });
  }

  const ok = await verifyGuardianOtp({ scope, otp: body.otp });
  if (!ok) return reply.code(400).send({ error: 'INVALID_OTP', message: 'OTP is invalid or expired' });

  // Token proves a guardian OTP was verified for a not-yet-created profile in
  // this (network, domain); `finalize` consumes it once the item exists.
  await redis.set(precreateTokenKey(userId, body.network, body.item_domain), '1', 'EX', PRECREATE_TOKEN_TTL_SEC);
  return reply.code(200).send({ verified: true });
};

const finalize_handler = async (
  request: FastifyRequest<{ Body: U18ProfileFinalizeBody }>,
  reply: FastifyReply,
) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertOwnedMinorItem(userId, body);
  if (!check.ok) {
    const status = check.code === 'NOT_ITEM_OWNER' ? 403 : 409;
    return reply.code(status).send({ error: check.code, message: check.code });
  }

  // Consume the pre-create token — must have verified the guardian OTP before
  // creating this item. Delete-after-read so it can't be replayed.
  const tokenKey = precreateTokenKey(userId, body.network, body.item_domain);
  const token = await redis.get(tokenKey);
  if (!token) {
    return reply.code(409).send({ error: 'GUARDIAN_PRECREATE_REQUIRED', message: 'Guardian OTP not verified for this profile creation' });
  }

  const version = await resolveConsentVersion({ network: body.network, brand: body.brand, category: 'profile_creation', variant: 'u18' });
  if (version === null) return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: 'u18 profile_creation not configured' });

  let promoted = false;
  try {
    await db.transaction(async (tx) => {
      // Upsert to source='guardian' (see verify_handler for why an existing
      // source='profile' row from create_item must be upgraded, not skipped).
      await tx.insert(consent_record).values(
        guardianProfileConsentRow({ userId, itemId: body.item_id, network: body.network, brand: body.brand, documentVersion: version }),
      ).onConflictDoUpdate({
        target: [consent_record.userId, consent_record.itemId],
        targetWhere: sql`level = 'item' AND consent_category = 'profile_creation'`,
        set: { source: 'guardian', documentVersion: version, acceptedAt: new Date(), metadata: { variant: 'u18' } as Record<string, unknown> },
      });
      promoted = await promoteItemOnProfileConsent(tx, body.item_id);
    });
  } catch (err) {
    request.log.error({ err }, 'Failed to finalize guardian profile consent');
    return reply.code(500).send({ error: 'CONSENT_WRITE_FAILED', message: 'Failed to record guardian profile consent' });
  }
  await redis.del(tokenKey);
  return reply.code(200).send({ promoted });
};

const issue_handler = async (request: IssueReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertOwnedMinorItem(userId, body);
  if (!check.ok) {
    const status = check.code === 'NOT_ITEM_OWNER' ? 403 : 409;
    return reply.code(status).send({ error: check.code, message: check.code });
  }
  const contact = await getGuardianContactPlaintext(userId);
  if (!contact) return reply.code(409).send({ error: 'GUARDIAN_REQUIRED', message: 'Submit guardian details first' });
  try {
    await issueGuardianOtp({ scope: profileScope(userId, body.item_id), contact: contact.contact, contactType: contact.contactType });
  } catch (err) {
    const r = guardianOtpErrorReply(err);
    if (r) return reply.code(r.status).send({ error: r.error, message: r.message });
    request.log.error({ err }, 'Failed to issue profile-consent OTP');
    return reply.code(500).send({ error: 'OTP_SEND_FAILED', message: 'Failed to send guardian OTP' });
  }
  return reply.code(200).send({ otpSent: true });
};

const verify_handler = async (request: VerifyReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertOwnedMinorItem(userId, body);
  if (!check.ok) {
    const status = check.code === 'NOT_ITEM_OWNER' ? 403 : 409;
    return reply.code(status).send({ error: check.code, message: check.code });
  }
  const scope = profileScope(userId, body.item_id);
  try {
    await assertVerifyAttemptAllowed(scope);
  } catch (err) {
    const r = guardianOtpErrorReply(err);
    if (r) return reply.code(r.status).send({ error: r.error, message: r.message });
    request.log.error({ err }, 'verify attempt check failed');
    return reply.code(500).send({ error: 'OTP_VERIFY_FAILED', message: 'Failed to check verify attempts' });
  }
  // Resolve version BEFORE consuming the single-use OTP.
  const version = await resolveConsentVersion({ network: body.network, brand: body.brand, category: 'profile_creation', variant: 'u18' });
  if (version === null) return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: 'u18 profile_creation not configured' });

  const ok = await verifyGuardianOtp({ scope, otp: body.otp });
  if (!ok) return reply.code(400).send({ error: 'INVALID_OTP', message: 'OTP is invalid or expired' });

  let promoted = false;
  try {
    await db.transaction(async (tx) => {
      // Upsert (not plain insert): a minor's item can already have a
      // `source='profile'` profile_creation row (self-create, or the adult
      // /profile-accept path) written before the guardian gate ran. The
      // partial unique index on (user_id, item_id) doesn't include `source`,
      // so a plain insert would 23505 there, leave the guardian row
      // unwritten, and permanently block the go-live gate (which requires a
      // `source='guardian'` row). Upgrade any existing row to 'guardian'
      // instead of skipping the write.
      await tx.insert(consent_record).values(
        guardianProfileConsentRow({ userId, itemId: body.item_id, network: body.network, brand: body.brand, documentVersion: version }),
      ).onConflictDoUpdate({
        target: [consent_record.userId, consent_record.itemId],
        targetWhere: sql`level = 'item' AND consent_category = 'profile_creation'`,
        set: { source: 'guardian', documentVersion: version, acceptedAt: new Date(), metadata: { variant: 'u18' } as Record<string, unknown> },
      });
      promoted = await promoteItemOnProfileConsent(tx, body.item_id);
    });
  } catch (err) {
    request.log.error({ err }, 'Failed to write guardian profile consent');
    return reply.code(500).send({ error: 'CONSENT_WRITE_FAILED', message: 'Failed to record guardian profile consent' });
  }
  return reply.code(200).send({ verified: true, promoted });
};
