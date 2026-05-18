import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { create_item } from '@/routes/v1/item/create_item';
import { fetch_item } from '@/routes/v1/item/fetch_item';
import { update_item } from '@/routes/v1/item/update_item';

const item_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(create_item);
  fastify.register(fetch_item);
  fastify.register(update_item);
};

export default item_routes;
