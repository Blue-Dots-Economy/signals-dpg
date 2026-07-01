import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { get_consent_status } from '@/routes/v1/consent/get_consent_status';
import { accept_consent } from '@/routes/v1/consent/accept_consent';

const consent_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(get_consent_status);
  fastify.register(accept_consent);
};

export default consent_routes;
