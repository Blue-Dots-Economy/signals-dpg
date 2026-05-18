import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { fetch_schemas } from '@/routes/v1/network/schema/fetch_schemas';
import { refetch_schema } from '@/routes/v1/network/schema/refetch_schema';
import { fetch_schema } from '@/routes/v1/network/schema/fetch_schema';
import { fetch_item } from '@/routes/v1/network/item/fetch_item';
import { perform_network_action } from '@/routes/v1/network/action/perform_action';

const network_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(fetch_schemas);
  fastify.register(fetch_schema);
  fastify.register(fetch_item);
  fastify.register(perform_network_action);
  fastify.register(refetch_schema);
};

export default network_routes;
