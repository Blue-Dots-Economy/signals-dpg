import z, { ProfileConsentStatusResponseSchema } from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { getWardDob } from '@/services/minor_guardian_repo';
import { isMinor } from '@/services/minor';

const ProfileStatusQuerySchema = z.object({ network: z.string().min(1) });

type Req = FastifyRequest<{ Querystring: { network: string } }>;

export const get_profile_consent_status: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/profile-status',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['consent'],
      querystring: ProfileStatusQuerySchema,
      response: {
        200: ProfileConsentStatusResponseSchema,
      },
    },
    handler: get_profile_consent_status_handler,
  });
};

export const get_profile_consent_status_handler = async (
  request: Req,
  reply: FastifyReply,
) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }

  const { network } = request.query;

  try {
    // For a MINOR, profile_creation consent must be GUARDIAN-given (D13). The
    // self row `create_item` writes at create time (source='profile') does NOT
    // satisfy it, so the client keeps prompting until the guardian confirms via
    // OTP (which writes source='guardian'). Adults: any profile_creation row.
    const dob = await getWardDob(userId);
    const isMinorWard = dob !== null && isMinor(dob);

    const conditions = [
      eq(consent_record.userId, userId),
      eq(consent_record.level, 'item'),
      eq(consent_record.consentCategory, 'profile_creation'),
      eq(consent_record.network, network),
    ];
    if (isMinorWard) {
      conditions.push(eq(consent_record.source, 'guardian'));
    }

    const rows = await db
      .select({ itemId: consent_record.itemId })
      .from(consent_record)
      .where(and(...conditions));

    const seen = new Set<string>();
    for (const row of rows) {
      if (row.itemId) seen.add(row.itemId);
    }

    return reply.code(200).send({
      consented_item_ids: Array.from(seen),
    });
  } catch (err) {
    request.log.error({ err }, 'profile consent status read failed');
    return reply.code(500).send({
      error: 'CONSENT_READ_FAILED',
      message: 'Failed to read profile consent status.',
    });
  }
};
