import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { U18GuardianBodySchema, U18GuardianResponseSchema, type U18GuardianBody } from '@dpg/schemas';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record, user } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import {
  getWardAge,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
  resolveOtpChannel,
  isGuardianWardLimitReached,
  guardianContactMatchesWard,
  WardLimitError,
} from '@/services/minor_guardian_repo';
import { resolveConsentVersion } from '@/services/consent_version';
import { issueGuardianOtp, guardianOtpErrorReply } from '@/services/guardian_otp';
import { guardianUserConsentRow } from '@/services/guardian_consent_rows';

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

  const age = await getWardAge(userId);
  if (age === null) return reply.code(409).send({ error: 'DOB_REQUIRED', message: 'Submit age before guardian details' });
  if (!isMinor(age)) {
    return reply.code(409).send({ error: 'NOT_A_MINOR', message: 'Guardian flow applies only to under-18 users' });
  }

  // Warn-and-confirm: a guardian contact must not silently equal the ward's
  // own email/phone. Not a hard reject — an explicit ack lets the ward proceed.
  const [ward] = await db.select({ email: user.email, phoneNumber: user.phoneNumber }).from(user).where(eq(user.id, userId));
  const matchesWard = guardianContactMatchesWard({
    wardEmail: ward?.email,
    wardPhone: ward?.phoneNumber,
    guardianEmail: body.guardianEmail,
    guardianPhone: body.guardianPhone,
  });
  // Hard block: a ward may not be their own guardian. (Allowing it with an ack
  // is a possible FUTURE use case — deliberately disabled for now.)
  if (matchesWard) {
    return reply.code(409).send({
      error: 'SAME_CONTACT_NOT_ALLOWED',
      message: "Guardian contact can't be the same as your own",
    });
  }

  // Cap: at most MAX_WARDS_PER_GUARDIAN wards may share one guardian contact.
  const channel = resolveOtpChannel({ guardianEmail: body.guardianEmail, guardianPhone: body.guardianPhone });
  if (await isGuardianWardLimitReached(channel.contact, userId)) {
    return reply.code(409).send({
      error: 'GUARDIAN_WARD_LIMIT',
      message: `This guardian is already linked to the maximum of ${apiConfig.max_wards_per_guardian} accounts.`,
    });
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
      guardianEmail: body.guardianEmail ?? null,
      guardianPhone: body.guardianPhone ?? null,
    });
    await db.insert(consent_record).values(guardianUserConsentRow({
      category: 'guardian_declaration',
      userId,
      network: body.network,
      brand: body.brand,
      documentVersion: declVersion,
      source: 'self',
    }));
  } catch (err) {
    // The atomic cap re-check (advisory lock in upsertGuardianDetails) can lose
    // the race the pre-check above passed → surface it as the same 409.
    if (err instanceof WardLimitError) {
      return reply.code(409).send({
        error: 'GUARDIAN_WARD_LIMIT',
        message: `This guardian is already linked to the maximum of ${apiConfig.max_wards_per_guardian} accounts.`,
      });
    }
    request.log.error({ err }, 'Failed to persist guardian details/declaration');
    return reply.code(500).send({ error: 'GUARDIAN_WRITE_FAILED', message: 'Failed to record guardian details' });
  }

  const contact = await getGuardianContactPlaintext(userId);
  if (!contact) return reply.code(500).send({ error: 'GUARDIAN_WRITE_FAILED', message: 'Guardian contact missing after write' });

  try {
    await issueGuardianOtp({
      scope: guardianOtpScope(userId),
      contact: contact.contact,
      contactType: contact.contactType,
      scenario: { kind: 'account' },
      variables: { parentName: body.guardianName },
    });
  } catch (err) {
    const r = guardianOtpErrorReply(err);
    if (r) return reply.code(r.status).send({ error: r.error, message: r.message });
    request.log.error({ err }, 'Failed to issue guardian OTP');
    return reply.code(500).send({ error: 'OTP_SEND_FAILED', message: 'Failed to send guardian OTP' });
  }

  return reply.code(200).send({ otpSent: true });
};
