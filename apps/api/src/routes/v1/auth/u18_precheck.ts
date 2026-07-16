import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { items } from '@dpg/database';
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired } from '@/services/minor';

const U18PrecheckBody = z.object({
  network: z.string().min(1),
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
});

const U18PrecheckResponse = z.object({
  /** Existing user on a guardian-gated domain with no stored DOB → collect DOB
   *  (+ guardian, for minors) in the auth flow before the login OTP. */
  requiresDob: z.boolean(),
  /** The gated domain the user holds, when requiresDob is true. */
  domain: z.string().nullable(),
});

/**
 * PUBLIC, unauthenticated. Given a login identifier, tells the UI whether an
 * EXISTING user still needs to provide a date of birth before signing in
 * (they hold a profile in a guardian-gated domain and `user.date_of_birth` is
 * unset). Reveals only that single boolean — never PII. New users (no match)
 * and users who already have a DOB return `requiresDob: false`.
 */
export const u18_precheck: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/u18-precheck',
    method: 'POST',
    schema: {
      tags: ['auth'],
      body: U18PrecheckBody,
      response: { 200: U18PrecheckResponse },
    },
    handler: async (request, reply) => {
      const body = request.body;
      const identifierCond = body.email
        ? eq(user.email, body.email)
        : body.phoneNumber
          ? eq(user.phoneNumber, body.phoneNumber)
          : null;
      if (!identifierCond) return reply.code(200).send({ requiresDob: false, domain: null });

      const [row] = await db
        .select({ id: user.id, dob: user.dateOfBirth })
        .from(user)
        .where(identifierCond)
        .limit(1);

      // No such user, or DOB already stored → nothing to collect pre-OTP.
      if (!row || row.dob) return reply.code(200).send({ requiresDob: false, domain: null });

      // Find a guardian-gated domain the user holds in this network.
      const owned = await db
        .selectDistinct({ domain: items.item_domain })
        .from(items)
        .where(and(eq(items.item_network, body.network), eq(items.created_by, row.id)));

      const networkConfig = await getNetworkConfigById(body.network).catch(() => null);
      if (!networkConfig) return reply.code(200).send({ requiresDob: false, domain: null });

      const gatedDomain = owned
        .map((o) => o.domain)
        .find((d) => guardianConsentRequired(networkConfig, d));

      return reply.code(200).send({
        requiresDob: Boolean(gatedDomain),
        domain: gatedDomain ?? null,
      });
    },
  });
};
