import type { FastifyPluginAsync } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { aggregator_default } from './aggregator/default.js';
import { aggregator_upsert } from './aggregator/upsert.js';
import { participant } from './participant.js';
import { participant_read } from './participant_read.js';
import { participant_decrypt } from './participant_decrypt.js';

/**
 * Mounts /api/v1/admin/*. Every request through this scope passes through:
 *   1. auth_middleware — populates request.user from apikey / session.
 *   2. acting_org preHandler — populates request.acting_org from the
 *      x-acting-org-id header, validating it points at an aggregator,
 *      voice, or network_service org and that the caller is a registered
 *      service user.
 */
export const admin_routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', auth_middleware_if_enabled);
  app.addHook('preHandler', acting_org_preHandler);

  await app.register(aggregator_upsert);
  await app.register(aggregator_default);
  await app.register(participant);
  await app.register(participant_read);
  await app.register(participant_decrypt);
};

export default admin_routes;
