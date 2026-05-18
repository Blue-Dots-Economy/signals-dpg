import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getConfiguredNetworkSchemas } from '@/network_schema_cache';

const ReadSchemasQuerySchema = z.object({
  network: z.string().optional(),
  domain: z.string().optional(),
  item_type: z.string().optional(),
  schema_url: z.string().optional(),
});

export const fetch_schemas: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/schemas',
    method: 'GET',
    schema: {
      tags: ['network'],
      querystring: ReadSchemasQuerySchema,
    },
    handler: async (request, reply) => {
      const schemas = await getConfiguredNetworkSchemas();
      const query = request.query as z.infer<typeof ReadSchemasQuerySchema>;

      return reply.send(
        schemas.filter((entry) => {
          if (query.network && entry.network !== query.network) {
            return false;
          }

          if (query.domain && entry.domain !== query.domain) {
            return false;
          }

          if (query.item_type && entry.item_type !== query.item_type) {
            return false;
          }

          if (query.schema_url && entry.schema_url !== query.schema_url) {
            return false;
          }

          return true;
        })
      );
    },
  });
};
