import z, {
  getDomainItemSchema,
  getInstanceCustomItemSchemaUrl,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { getOrFetchSchemaByUrl } from '@/network_schema_cache';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';

const ReadSchemaParamsSchema = z.object({
  network: z.string().min(1),
  domain: z.string().min(1),
  itemType: z.string().min(1),
});

export const fetch_schema: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/schema/:network/:domain/:itemType',
    method: 'GET',
    schema: {
      tags: ['network'],
      params: ReadSchemaParamsSchema,
    },
    handler: async (request, reply) => {
      const params = request.params as z.infer<typeof ReadSchemaParamsSchema>;

      if (!isServedDomainBinding(params.network, params.domain)) {
        return await replyForUnservedDomain(
          reply,
          params.network,
          params.domain
        );
      }

      const networkConfig = await getNetworkConfigById(params.network);
      const currentInstanceUrl = getCurrentApiBaseUrl();
      const customSchemaUrl = getInstanceCustomItemSchemaUrl(networkConfig, {
        domain: params.domain,
        instanceUrl: currentInstanceUrl,
        itemType: params.itemType,
      });

      if (customSchemaUrl) {
        return reply.send(
          await getOrFetchSchemaByUrl({
            schemaUrl: customSchemaUrl,
            network: params.network,
            domain: params.domain,
            itemType: params.itemType,
            instanceUrl: currentInstanceUrl,
            kind: 'instance_custom_item_schema',
          })
        );
      }

      return reply.send(
        getDomainItemSchema(networkConfig, params.domain, params.itemType)
      );
    },
  });
};
