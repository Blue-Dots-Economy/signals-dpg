import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import z, { SchemaFetchError } from '@dpg/schemas';

import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { refreshConsumedSchemas } from '@/network_schema_cache';

const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export const refetch_schema: FastifyPluginAsyncZod =
  async function (fastify) {
    fastify.route({
      url: '/refetch_schemas',
      method: 'POST',
      // A service operation, not a participant action: otherwise any
      // participant could trigger repeated outbound schema re-fetches
      // (AUTHZ-VULN-13). Gated like /admin/*: auth, then acting_org, then the
      // handler checks for a network_service org.
      preHandler: [auth_middleware_if_enabled, acting_org_preHandler],
      schema: {
        tags: ['network'],
        response: {
          200: z.object({
            refreshed: z.boolean(),
            schema_count: z.number(),
          }),
          403: ErrorResponseSchema,
          502: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
      handler: async (request, reply) => {
        if (request.acting_org?.org_type !== 'network_service') {
          return reply.code(403).send({
            error: 'FORBIDDEN',
            message:
              'only the network service caller may refresh consumed schemas',
          });
        }

        try {
          const schemas = await refreshConsumedSchemas();

          return reply.send({
            refreshed: true,
            schema_count: schemas.length,
          });
        } catch (err) {
          request.log.error({ err }, 'Failed to refresh consumed schemas');

          if (err instanceof SchemaFetchError) {
            return reply.code(502).send({
              error: 'REMOTE_SCHEMA_FETCH_FAILED',
              message: `Failed to fetch remote schema: ${err.url}`,
            });
          }

          return reply.code(500).send({
            error: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to refresh consumed schemas',
          });
        }
      },
    });
  };
