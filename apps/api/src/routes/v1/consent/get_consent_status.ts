import {
  ConsentStatusQuerySchema,
  ConsentStatusResponseSchema,
} from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';

type Req = FastifyRequest<{ Querystring: { network: string } }>;

export const get_consent_status: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/status',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['consent'],
      querystring: ConsentStatusQuerySchema,
      response: {
        200: ConsentStatusResponseSchema,
      },
    },
    handler: get_consent_status_handler,
  });
};

export const get_consent_status_handler = async (
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
    const rows = await db
      .select({
        consentCategory: consent_record.consentCategory,
        documentVersion: consent_record.documentVersion,
      })
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, userId),
          eq(consent_record.level, 'user'),
          eq(consent_record.network, network),
          inArray(consent_record.consentCategory, ['terms', 'privacy']),
        ),
      );

    const termsSet = new Set<number>();
    const privacySet = new Set<number>();

    for (const row of rows) {
      if (row.consentCategory === 'terms') {
        termsSet.add(row.documentVersion);
      } else if (row.consentCategory === 'privacy') {
        privacySet.add(row.documentVersion);
      }
    }

    return reply.code(200).send({
      statuses: {
        terms: Array.from(termsSet).sort((a, b) => a - b),
        privacy: Array.from(privacySet).sort((a, b) => a - b),
      },
    });
  } catch (err) {
    request.log.error({ err }, 'consent status read failed');
    return reply.code(500).send({
      error: 'CONSENT_READ_FAILED',
      message: 'Failed to read consent status.',
    });
  }
};
