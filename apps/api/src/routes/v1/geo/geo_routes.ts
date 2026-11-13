import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { geo_resolve } from '@/routes/v1/geo/resolve';

const geo_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(geo_resolve);
};

export default geo_routes;
