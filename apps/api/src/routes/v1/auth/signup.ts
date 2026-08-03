import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { selfSignup } from '@/services/auth/self_signup';

const SignupBody = z.object({
  name: z.string().min(1).max(200),
  email: z.email().optional(),
  phoneNumber: z.string().min(1).optional(),
  /** Network domain to join. Validated against served domains server-side. */
  domain: z.string().min(1).optional(),
  /** Age in years, derived from the birth year on the client (#331). Drives U18 gating once applied. */
  age: z.coerce.number().int().min(0).max(120).optional(),
});

const SignupResponse = z.object({
  ok: z.literal(true),
  /** True when the identifier already belongs to someone — go sign in. */
  alreadyRegistered: z.boolean(),
});

const ErrorResponse = z.object({
  code: z.string(),
  error: z.string(),
  message: z.string(),
});

/** Which HTTP status each refusal maps to. */
type ErrorStatus = 400 | 403 | 429 | 500;
const STATUS: Record<string, ErrorStatus> = {
  SIGNUP_NOT_AVAILABLE: 400,
  SELF_SIGNUP_DISABLED: 403,
  NO_IDENTIFIER: 400,
  LOGIN_CHANNEL_DISABLED: 403,
  SIGNUP_RATE_LIMITED: 429,
  DOMAIN_NOT_SERVED: 400,
  INVALID_AGE: 400,
  SIGNUP_FAILED: 500,
};

/**
 * Public, unauthenticated self-signup for Keycloak instances.
 *
 * Creates the Keycloak identity only — the local `user` row appears at first
 * successful login, so nothing exists in signals until the person has proved
 * they own the identifier via OTP. See `services/auth/self_signup.ts` for why
 * this endpoint has to exist at all (the OTP SPI cannot create users, and
 * Keycloak's own registration form is password-based).
 *
 * Unauthenticated by necessity — the caller has no account yet. `SELF_SIGNUP_MODE`
 * is the gate, and the service rate-limits per identifier and per IP.
 */
export const auth_signup: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/signup',
    method: 'POST',
    schema: {
      tags: ['auth'],
      body: SignupBody,
      response: {
        200: SignupResponse,
        400: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
        500: ErrorResponse,
      },
    },
    handler: async (request, reply) => {
      const result = await selfSignup(
        { ...request.body, clientIp: request.ip },
        request.log
      );

      if (!result.ok) {
        const status: ErrorStatus = STATUS[result.code] ?? 400;
        return reply.code(status).send({
          code: result.code,
          error: status >= 500 ? 'Internal Server Error' : 'Bad Request',
          message: result.message,
        });
      }

      return reply.code(200).send({
        ok: true,
        alreadyRegistered: result.alreadyRegistered,
      });
    },
  });
};
