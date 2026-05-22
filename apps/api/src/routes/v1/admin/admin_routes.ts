import type { FastifyPluginAsync } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { aggregator_upsert } from './aggregator/upsert.js';

/**
 * Mounts /api/v1/admin/*. Every request through this scope passes through:
 *   1. auth_middleware — populates request.user from apikey / session.
 *   2. acting_org preHandler — populates request.acting_org from the
 *      x-acting-org-id header, validating it points at an aggregator,
 *      voice, or network_service org and that the caller is a registered
 *      service user.
 *
 * Sub-routes (Tasks 6-8 of Plan 1, plus Plan 2's onboarding endpoint) are
 * registered here as they land. This file stays small — it's a wiring
 * shim, not a domain module.
 */
export const admin_routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', auth_middleware_if_enabled);
  app.addHook('preHandler', acting_org_preHandler);

  await app.register(aggregator_upsert);
};

export default admin_routes;
