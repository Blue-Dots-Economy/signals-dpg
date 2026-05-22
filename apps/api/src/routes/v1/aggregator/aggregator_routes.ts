import type { FastifyPluginAsync } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { aggregator_dashboard } from './dashboard.js';
import { aggregator_export } from './export.js';

/**
 * Mounts /api/v1/aggregator/*. Mirrors the admin_routes wiring shim:
 * every request through this scope first passes through
 *   1. auth_middleware - populates request.user from apikey / session.
 *   2. acting_org preHandler - populates request.acting_org from the
 *      x-acting-org-id header.
 * Individual route plugins narrow further to org_type === 'aggregator'.
 */
export const aggregator_routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', auth_middleware_if_enabled);
  app.addHook('preHandler', acting_org_preHandler);

  await app.register(aggregator_dashboard);
  await app.register(aggregator_export);
};

export default aggregator_routes;
