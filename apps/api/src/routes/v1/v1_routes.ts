import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import item_routes from '@/routes/v1/item/item_routes';
import action_routes from '@/routes/v1/action/action_routes';
import event_routes from '@/routes/v1/event/event_routes';
import network_routes from '@/routes/v1/network/network_routes';
import match_score_routes from '@/routes/v1/match_score/match_score_routes';

const v1_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(item_routes, { prefix: '/item' });
  fastify.register(action_routes, { prefix: '/action' });
  fastify.register(event_routes, { prefix: '/event' });
  fastify.register(match_score_routes, { prefix: '/match-score' });
  fastify.register(network_routes, { prefix: '/network' });
};

export default v1_routes;
