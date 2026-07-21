import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  U18GuardianVerifyBodySchema, U18GuardianVerifyResponseSchema, type U18GuardianVerifyBody,
} from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { resolveConsentVersion } from '@/services/consent_version';
import { guardianUserConsentRow } from '@/services/guardian_consent_rows';
import { setGuardianVerified } from '@/services/minor_guardian_repo';
import { assertVerifyAttemptAllowed, verifyGuardianOtp, guardianOtpErrorReply } from '@/services/guardian_otp';
import { guardianOtpScope } from '@/routes/v1/consent/u18_guardian';

type Req = FastifyRequest<{ Body: U18GuardianVerifyBody }>;
const GUARDIAN_USER_DOCS = ['terms', 'privacy'] as const;

export const u18_guardian_verify: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/guardian/verify',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18GuardianVerifyBodySchema, response: { 200: U18GuardianVerifyResponseSchema } },
    handler: u18_guardian_verify_handler,
  });
};

export const u18_guardian_verify_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }

  const scope = guardianOtpScope(userId);
  try {
    await assertVerifyAttemptAllowed(scope);
  } catch (err) {
    const r = guardianOtpErrorReply(err);
    if (r) return reply.code(r.status).send({ error: r.error, message: r.message });
    throw err;
  }

  // Resolve u18 versions for the guardian's user-level consents BEFORE consuming
  // the single-use OTP, so a misconfigured version doesn't burn a valid OTP.
  const rows = [];
  for (const category of GUARDIAN_USER_DOCS) {
    const version = await resolveConsentVersion({ network: body.network, brand: body.brand, category, variant: 'u18' });
    if (version === null) {
      return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: `u18 ${category} not configured` });
    }
    rows.push(guardianUserConsentRow({
      category,
      userId,
      network: body.network,
      brand: body.brand,
      documentVersion: version,
      source: 'guardian',
    }));
  }

  const ok = await verifyGuardianOtp({ scope, otp: body.otp });
  if (!ok) return reply.code(400).send({ error: 'INVALID_OTP', message: 'OTP is invalid or expired' });

  try {
    await db.insert(consent_record).values(rows);
    await setGuardianVerified(userId);
  } catch (err) {
    request.log.error({ err }, 'Failed to write guardian consents');
    return reply.code(500).send({ error: 'CONSENT_WRITE_FAILED', message: 'Failed to record guardian consent' });
  }

  return reply.code(200).send({ verified: true });
};
