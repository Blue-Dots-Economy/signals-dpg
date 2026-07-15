import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { U18GuardianBodySchema, U18GuardianResponseSchema, type U18GuardianBody } from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import {
  getMinorGuardian,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
} from '@/services/minor_guardian_repo';
import { resolveConsentVersion } from '@/services/consent_version';
import { issueGuardianOtp, GuardianOtpError } from '@/services/guardian_otp';

type Req = FastifyRequest<{ Body: U18GuardianBody }>;

export const u18_guardian: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/guardian',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18GuardianBodySchema, response: { 200: U18GuardianResponseSchema } },
    handler: u18_guardian_handler,
  });
};

export const guardianOtpScope = (userId: string) => `${userId}:guardian`;

export const u18_guardian_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }

  const mg = await getMinorGuardian(userId);
  if (!mg) return reply.code(409).send({ error: 'DOB_REQUIRED', message: 'Submit date of birth before guardian details' });
  if (!isMinor(mg.birthYear, mg.birthMonth)) {
    return reply.code(409).send({ error: 'NOT_A_MINOR', message: 'Guardian flow applies only to under-18 users' });
  }

  // Record the ward's guardian-validity attestation (D12): source='self', u18.
  const declVersion = await resolveConsentVersion({
    network: body.network, brand: body.brand, category: 'guardian_declaration', variant: 'u18',
  });
  if (declVersion === null) {
    return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: 'guardian_declaration not configured' });
  }

  try {
    await upsertGuardianDetails(userId, {
      guardianName: body.guardianName,
      guardianContact: body.guardianContact,
      guardianContactType: body.guardianContactType,
    });
    await db.insert(consent_record).values({
      level: 'user',
      consentCategory: 'guardian_declaration',
      userId,
      network: body.network,
      brand: body.brand ?? null,
      documentVersion: declVersion,
      source: 'self',
      acceptedAt: new Date(),
      metadata: { variant: 'u18' },
    });
  } catch (err) {
    request.log.error({ err }, 'Failed to persist guardian details/declaration');
    return reply.code(500).send({ error: 'GUARDIAN_WRITE_FAILED', message: 'Failed to record guardian details' });
  }

  const contact = await getGuardianContactPlaintext(userId);
  if (!contact) return reply.code(500).send({ error: 'GUARDIAN_WRITE_FAILED', message: 'Guardian contact missing after write' });

  try {
    await issueGuardianOtp({ scope: guardianOtpScope(userId), contact: contact.contact, contactType: contact.contactType });
  } catch (err) {
    if (err instanceof GuardianOtpError && err.code === 'RATE_LIMITED') {
      return reply.code(429).send({ error: 'OTP_RATE_LIMITED', message: 'Too many OTP requests; try again shortly' });
    }
    if (err instanceof GuardianOtpError && err.code === 'NO_OTP_PROVIDER') {
      return reply.code(503).send({ error: 'OTP_PROVIDER_UNAVAILABLE', message: 'No OTP channel configured for this instance' });
    }
    request.log.error({ err }, 'Failed to issue guardian OTP');
    return reply.code(500).send({ error: 'OTP_SEND_FAILED', message: 'Failed to send guardian OTP' });
  }

  return reply.code(200).send({ otpSent: true });
};
