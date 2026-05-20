import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { onboard } from '@/routes/v1/admin/onboard';

const admin_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(onboard);
};

export default admin_routes;
