import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import z, { SchemaFetchError } from '@dpg/schemas';

import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { refreshConsumedSchemas } from '@/network_schema_cache';
import { require_admin_role } from '@/middleware/require_admin_role';
import { refetch_schemas_rate_limit } from '@/utils/refetch_schemas_rate_limit';

const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export const refetch_schema: FastifyPluginAsyncZod =
  async function (fastify) {
    fastify.route({
      url: '/refetch_schemas',
      method: 'POST',
      preHandler: [
        auth_middleware_if_enabled,
        require_admin_role,
        refetch_schemas_rate_limit,
      ],
      schema: {
        tags: ['network'],
        response: {
          200: z.object({
            refreshed: z.boolean(),
            schema_count: z.number(),
          }),
          403: ErrorResponseSchema,
          429: ErrorResponseSchema,
          502: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
      handler: async (request, reply) => {
        request.log.info(
          {
            operation: 'refetch_schema',
            status: 'allowed',
            user_id: request.user?.id,
            role: request.user?.role,
          },
          'Schema refetch requested',
        );

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
