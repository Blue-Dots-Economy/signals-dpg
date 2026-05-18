import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { fetch_actions } from '@/routes/v1/action/fetch_actions';
import { perform_action } from '@/routes/v1/action/perform_action';
import { update_action_status } from '@/routes/v1/action/update_action_status';

const action_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(fetch_actions);
  fastify.register(perform_action);
  fastify.register(update_action_status);
};

export default action_routes;
