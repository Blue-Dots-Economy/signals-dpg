import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { calculate_match_score } from '@/routes/v1/match_score/calculate_match_score';

const match_score_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(calculate_match_score);
};

export default match_score_routes;
