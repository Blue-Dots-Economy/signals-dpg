import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  U18ProfileConsentBodySchema, U18ProfileConsentResponseSchema, type U18ProfileConsentBody,
  U18ProfileConsentVerifyBodySchema, U18ProfileConsentVerifyResponseSchema, type U18ProfileConsentVerifyBody,
} from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import { getWardDob, getGuardianContactPlaintext } from '@/services/minor_guardian_repo';
import { resolveConsentVersion } from '@/services/consent_version';
import {
  issueGuardianOtp, verifyGuardianOtp, assertVerifyAttemptAllowed, GuardianOtpError,
} from '@/services/guardian_otp';
import { promoteItemOnProfileConsent } from '@/services/item_service';

const profileScope = (userId: string, itemId: string) => `${userId}:profile:${itemId}`;

async function assertOwnedMinorItem(userId: string, body: { network: string; item_domain: string; item_type: string; item_id: string }) {
  const [owner] = await db
    .select({ created_by: items.created_by })
    .from(items)
    .where(and(
      eq(items.item_network, body.network), eq(items.item_domain, body.item_domain),
      eq(items.item_type, body.item_type), eq(items.item_id, body.item_id),
      eq(items.created_by, userId),
    )).limit(1);
  if (!owner) return { ok: false as const, code: 'NOT_ITEM_OWNER' };
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
    if (err instanceof GuardianOtpError && err.code === 'RATE_LIMITED') return reply.code(429).send({ error: 'OTP_RATE_LIMITED', message: 'Too many OTP requests' });
    if (err instanceof GuardianOtpError && err.code === 'NO_OTP_PROVIDER') return reply.code(503).send({ error: 'OTP_PROVIDER_UNAVAILABLE', message: 'No OTP channel configured' });
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
    if (err instanceof GuardianOtpError && err.code === 'VERIFY_THROTTLED') return reply.code(429).send({ error: 'OTP_VERIFY_THROTTLED', message: 'Too many attempts' });
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
      await tx.insert(consent_record).values({
        level: 'item', consentCategory: 'profile_creation', userId, itemId: body.item_id,
        network: body.network, brand: body.brand ?? null, documentVersion: version,
        source: 'guardian', acceptedAt: new Date(), metadata: { variant: 'u18' } as Record<string, unknown>,
      }).onConflictDoUpdate({
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
