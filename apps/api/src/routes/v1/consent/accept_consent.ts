import {
  ConsentAcceptBodySchema,
  ConsentAcceptResponseSchema,
  type ConsentAcceptBody,
} from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';

type Req = FastifyRequest<{ Body: ConsentAcceptBody }>;

export const accept_consent: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/accept',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['consent'],
      body: ConsentAcceptBodySchema,
      response: {
        200: ConsentAcceptResponseSchema,
      },
    },
    handler: accept_consent_handler,
  });
};

export const accept_consent_handler = async (
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

  const body = request.body;
  const validNetworks = apiConfig.served_domains.map((b) => b.network);

  if (!validNetworks.includes(body.network)) {
    return reply.code(400).send({
      error: 'UNKNOWN_NETWORK',
      message: `Network "${body.network}" is not served by this instance`,
    });
  }

  const acceptedAt = new Date();
  const rows = body.items.map((item) => ({
    level: 'user' as const,
    consentCategory: item.category,
    userId,
    network: body.network,
    brand: body.brand ?? null,
    documentVersion: item.version,
    source: body.source,
    acceptedAt,
  }));

  try {
    await db.insert(consent_record).values(rows);
  } catch (err) {
    request.log.error({ err }, 'Failed to write consent_record rows');
    return reply.code(500).send({
      error: 'CONSENT_WRITE_FAILED',
      message: 'Failed to record consent',
    });
  }

  return reply.code(200).send({ recorded: body.items.length });
};
