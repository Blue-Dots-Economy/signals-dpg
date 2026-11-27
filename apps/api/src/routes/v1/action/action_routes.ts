import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler_optional } from '@/middleware/acting_org_optional';
import { fetch_actions } from '@/routes/v1/action/fetch_actions';
import { perform_action } from '@/routes/v1/action/perform_action';
import { update_action_status } from '@/routes/v1/action/update_action_status';
import { get_action_contact_details } from '@/routes/v1/action/get_action_contact_details';
import { export_actions } from '@/routes/v1/action/export_actions';

const action_routes: FastifyPluginAsyncZod = (fastify) => {
  // Order matters: auth_middleware populates `request.user`, which
  // acting_org_preHandler_optional reads. Fastify runs plugin-level preHandler
  // hooks in registration order before the route-level preHandler chain, so
  // installing auth at the plugin scope guarantees `request.user` is set
  // before the acting_org check. Each route also declares its own auth
  // preHandler for readability; auth_middleware is idempotent, so the second
  // pass only repeats the same resolution.
  fastify.addHook('preHandler', auth_middleware_if_enabled);
  fastify.addHook('preHandler', acting_org_preHandler_optional);
  fastify.register(fetch_actions);
  fastify.register(perform_action);
  fastify.register(update_action_status);
  fastify.register(get_action_contact_details);
  fastify.register(export_actions);
  // Plugins return a promise; nothing here awaits (routes register synchronously).
  return Promise.resolve();
};

export default action_routes;
