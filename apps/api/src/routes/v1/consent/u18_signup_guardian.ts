import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  SignupGuardianBodySchema,
  SignupGuardianResponseSchema,
  type SignupGuardianBody,
  SignupGuardianVerifyBodySchema,
  SignupGuardianVerifyResponseSchema,
  type SignupGuardianVerifyBody,
} from '@dpg/schemas';
import { apiConfig } from '@/config';
import { redis } from '@api/db/secondary/redis';
import {
  startSignupGuardian,
  verifySignupGuardian,
  SignupGuardianError,
  type SignupIdentifier,
} from '@/services/signup_guardian';
import { GuardianOtpError } from '@/services/guardian_otp';

// Per-IP fixed window on this PUBLIC, unauthenticated send route (mirrors
// u18_precheck) — a first line against OTP-send abuse before the per-scope /
// per-guardian-contact caps in issueGuardianOtp.
const SIGNUP_GUARDIAN_RL_WINDOW_SEC = 300;
const SIGNUP_GUARDIAN_RL_MAX = 10;

// Increment the per-IP counter; return true when the caller is OVER the window.
// Fail-open on a limiter error (the per-contact cap still applies downstream).
async function overIpLimit(ip: string): Promise<boolean> {
  try {
    const key = `u18_signup_guardian_rl:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, SIGNUP_GUARDIAN_RL_WINDOW_SEC);
    return n > SIGNUP_GUARDIAN_RL_MAX;
  } catch {
    return false;
  }
}

type StartReq = FastifyRequest<{ Body: SignupGuardianBody }>;
type VerifyReq = FastifyRequest<{ Body: SignupGuardianVerifyBody }>;

function identifierFrom(body: { email?: string; phoneNumber?: string }): SignupIdentifier {
  // Schema-enforced: exactly one of email/phoneNumber is present.
  return body.email ? { email: body.email } : { phoneNumber: body.phoneNumber as string };
}

const SIGNUP_GUARDIAN_ERROR_STATUS: Record<SignupGuardianError['code'], number> = {
  UNKNOWN_NETWORK: 400,
  NOT_GATED: 400,
  NOT_A_MINOR: 409,
  SAME_CONTACT_NEEDS_ACK: 409,
  GUARDIAN_WARD_LIMIT: 409,
  INVALID_OTP: 400,
  NO_PENDING_SIGNUP: 400,
};

function guardianOtpErrorStatus(code: GuardianOtpError['code']): number {
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'NO_OTP_PROVIDER') return 503;
  return 429; // VERIFY_THROTTLED
}

/**
 * PRE-AUTH, signup-scoped guardian consent (U18 spec, pre-signup phase).
 *
 * Both routes are PUBLIC and unauthenticated — deliberately no
 * `auth_middleware_if_enabled` preHandler, mirroring `routes/v1/auth/
 * auth_config.ts`. The account this guardian is being captured for does not
 * exist yet, so there is no session/apikey to authenticate against; the flow
 * is keyed on the signup identifier itself (see `services/signup_guardian.ts`).
 */
export const u18_signup_guardian: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/signup/guardian',
    method: 'POST',
    schema: {
      tags: ['consent'],
      body: SignupGuardianBodySchema,
      response: { 200: SignupGuardianResponseSchema },
    },
    handler: start_handler,
  });

  fastify.route({
    url: '/u18/signup/guardian/verify',
    method: 'POST',
    schema: {
      tags: ['consent'],
      body: SignupGuardianVerifyBodySchema,
      response: { 200: SignupGuardianVerifyResponseSchema },
    },
    handler: verify_handler,
  });
};

const start_handler = async (request: StartReq, reply: FastifyReply) => {
  if (await overIpLimit(request.ip)) {
    return reply.code(429).send({ error: 'OTP_RATE_LIMITED', message: 'Too many requests; try again shortly' });
  }

  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network && b.domain === body.domain)) {
    return reply.code(400).send({
      error: 'UNKNOWN_NETWORK',
      message: `Network/domain "${body.network}/${body.domain}" is not served`,
    });
  }

  try {
    await startSignupGuardian({
      network: body.network,
      domain: body.domain,
      identifier: identifierFrom(body),
      dateOfBirth: body.dateOfBirth,
      guardianName: body.guardianName,
      guardianEmail: body.guardianEmail,
      guardianPhone: body.guardianPhone,
      guardianDeclarationAccepted: body.guardianDeclarationAccepted,
      sameContactAcknowledged: body.sameContactAcknowledged,
    });
  } catch (err) {
    if (err instanceof SignupGuardianError) {
      return reply.code(SIGNUP_GUARDIAN_ERROR_STATUS[err.code]).send({ error: err.code, message: err.code });
    }
    if (err instanceof GuardianOtpError) {
      return reply.code(guardianOtpErrorStatus(err.code)).send({ error: err.code, message: err.code });
    }
    request.log.error({ err }, 'Failed to start signup guardian flow');
    return reply.code(500).send({ error: 'SIGNUP_GUARDIAN_FAILED', message: 'Failed to start guardian verification' });
  }

  return reply.code(200).send({ otpSent: true });
};

const verify_handler = async (request: VerifyReq, reply: FastifyReply) => {
  const body = request.body;
  if (body.network && !apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }

  try {
    await verifySignupGuardian({ identifier: identifierFrom(body), otp: body.otp });
  } catch (err) {
    if (err instanceof SignupGuardianError) {
      return reply.code(SIGNUP_GUARDIAN_ERROR_STATUS[err.code]).send({ error: err.code, message: err.code });
    }
    if (err instanceof GuardianOtpError) {
      return reply.code(guardianOtpErrorStatus(err.code)).send({ error: err.code, message: err.code });
    }
    request.log.error({ err }, 'Failed to verify signup guardian OTP');
    return reply.code(500).send({ error: 'SIGNUP_GUARDIAN_VERIFY_FAILED', message: 'Failed to verify guardian OTP' });
  }

  return reply.code(200).send({ verified: true });
};
