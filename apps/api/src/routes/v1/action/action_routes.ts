import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler_optional } from '@/middleware/acting_org_optional';
import { fetch_actions } from '@/routes/v1/action/fetch_actions';
import { perform_action } from '@/routes/v1/action/perform_action';
import { update_action_status } from '@/routes/v1/action/update_action_status';

const action_routes: FastifyPluginAsyncZod = async (fastify) => {
  // Order matters: auth_middleware populates `request.user` from the
  // apikey / session, which acting_org_preHandler_optional reads via
  // `request.user.id` to validate the service user. Fastify runs
  // plugin-level preHandler hooks in registration order BEFORE the
  // route-level preHandler chain, so installing auth here at the
  // plugin scope guarantees `request.user` is set before the
  // optional acting_org check fires. (Each individual route still
  // declares its own auth preHandler for clarity — Fastify runs the
  // route-level preHandler chain after plugin hooks; auth_middleware
  // is idempotent so the second pass is a no-op cost in exchange for
  // route-handler-local readability.)
  fastify.addHook('preHandler', auth_middleware_if_enabled);
  fastify.addHook('preHandler', acting_org_preHandler_optional);
  fastify.register(fetch_actions);
  fastify.register(perform_action);
  fastify.register(update_action_status);
};

export default action_routes;
