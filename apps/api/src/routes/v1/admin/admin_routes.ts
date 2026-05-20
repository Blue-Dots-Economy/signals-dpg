import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { onboard } from '@/routes/v1/admin/onboard';
import { list_items } from '@/routes/v1/admin/list_items';

const admin_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(onboard);
  fastify.register(list_items);
};

export default admin_routes;
