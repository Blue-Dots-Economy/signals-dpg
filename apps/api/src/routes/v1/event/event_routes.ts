import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { fetch_events } from '@/routes/v1/event/fetch_events';
import { store_event } from '@/routes/v1/event/store_event';

const event_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(fetch_events);
  fastify.register(store_event);
};

export default event_routes;
