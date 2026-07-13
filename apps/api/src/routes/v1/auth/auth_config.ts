import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authConfig } from '@/config';

const AuthConfigResponse = z.object({
  selfSignupAllowed: z.boolean(),
  loginChannels: z.array(z.enum(['email', 'phone'])),
});

/**
 * Public, unauthenticated. Surfaces the instance's auth-flow configuration to
 * the UI: whether self-signup is allowed and which login channels are enabled.
 * Server env remains the single source of truth (see apps/api/src/config.ts).
 */
export const auth_config: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/config',
    method: 'GET',
    schema: {
      tags: ['auth'],
      response: { 200: AuthConfigResponse },
    },
    handler: async (_request, reply) => {
      return reply.code(200).send({
        selfSignupAllowed: authConfig.allow_self_signup,
        loginChannels: authConfig.login_channels,
      });
    },
  });
};
