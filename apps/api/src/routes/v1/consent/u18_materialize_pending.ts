import z from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { materializeSignupGuardian } from '@/services/signup_guardian';

const U18MaterializeResponse = z.object({ ok: z.boolean() });

/**
 * Authenticated. Materializes a pending pre-auth signup-guardian capture onto
 * the CURRENT user — the existing-user analogue of the `afterUserCreate` hook
 * that fires for brand-new signups. Called by the OTP page right after an
 * existing user (who collected DOB + guardian BEFORE their login OTP) verifies.
 * A no-op when there's no pending capture for this user (idempotent).
 */
export const u18_materialize_pending: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/materialize-pending',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], response: { 200: U18MaterializeResponse } },
    handler: async (request, reply) => {
      const userId = request.user?.id;
      // Best-effort (like the signup materialize): never block sign-in. Any
      // problem → { ok: false } and the client proceeds; the home-page gate
      // remains the safety net.
      if (!userId) return reply.code(200).send({ ok: false });
      try {
        // Look up email/phone from the row — the pending capture is keyed on the
        // signup identifier, so we match on whatever channel the user has.
        const [row] = await db
          .select({ email: user.email, phoneNumber: user.phoneNumber })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1);
        await materializeSignupGuardian({ id: userId, email: row?.email ?? null, phoneNumber: row?.phoneNumber ?? null });
      } catch (err) {
        request.log.error({ err }, 'Failed to materialize pending signup guardian for existing user');
        return reply.code(200).send({ ok: false });
      }
      return reply.code(200).send({ ok: true });
    },
  });
};
