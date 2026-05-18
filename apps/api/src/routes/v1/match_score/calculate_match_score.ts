import z, {
  MatchScoreRequestSchema,
  MatchScoreResponseSchema,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '../../../../plugins/auth/auth_middleware';
import { getMatchScoreClient } from '../../../utils/match_score_client';

type CalculateMatchScoreRequest = FastifyRequest<{
  Body: z.infer<typeof MatchScoreRequestSchema>;
}>;

const MatchScoreErrorResponseSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
});

export const calculate_match_score: FastifyPluginAsyncZod = async function (
  fastify
) {
  fastify.route({
    url: '/calculate',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['match_score'],
      body: MatchScoreRequestSchema,
      response: {
        200: MatchScoreResponseSchema,
        502: MatchScoreErrorResponseSchema,
        503: MatchScoreErrorResponseSchema,
      },
    },
    handler: calculateMatchScoreHandler,
  });
};

const calculateMatchScoreHandler = async (
  request: CalculateMatchScoreRequest,
  reply: FastifyReply
) => {
  const client = getMatchScoreClient();

  if (!client) {
    return reply.code(503).send({
      error: 'MATCH_SCORE_NOT_CONFIGURED',
      message: 'Match score provider is not configured',
    });
  }

  try {
    const result = await client.calculate(request.body);
    return reply.code(200).send(result);
  } catch (err) {
    request.log.error(
      {
        err,
        provider: 'dpg_scoring',
        item_a_id: request.body.itemA.item_id,
        item_b_id: request.body.itemB.item_id,
      },
      'Failed to calculate match score'
    );

    return reply.code(502).send({
      error: 'MATCH_SCORE_SERVICE_UNAVAILABLE',
      message: 'Failed to reach the configured match score provider',
    });
  }
};
