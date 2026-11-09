import z, { GeoResolveBodySchema, GeoResolveResponseSchema } from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware } from '@api/plugins/auth/auth_middleware';
import { geocodingConfig } from '@/config';
import { resolvePlace } from '@/services/geocoding/geo_resolver';

const ErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
});

/**
 * Resolve a free-text address to a point, for service callers only
 * (signals-search, via a Keycloak client-credentials token).
 *
 * Always authenticated: `auth_middleware`, never the `_if_enabled` variant.
 * Only the client-credentials path sets `service_client_id`, so API-key and
 * browser callers are refused, as is any client not in `resolve_client_ids`.
 */
export const geo_resolve: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/resolve',
    method: 'POST',
    preHandler: auth_middleware,
    schema: {
      tags: ['geo'],
      body: GeoResolveBodySchema,
      response: {
        200: GeoResolveResponseSchema,
        403: ErrorResponse,
        422: ErrorResponse,
        503: ErrorResponse,
      },
    },
    handler: async (request, reply) => {
      const clientId = request.service_client_id;
      if (
        typeof request.headers['x-api-key'] === 'string' ||
        !clientId ||
        !geocodingConfig.resolve_client_ids.includes(clientId)
      ) {
        return reply.status(403).send({
          error: 'GEO_RESOLVE_NOT_ALLOWED',
          message: 'This credential may not use geo resolve',
        });
      }

      const { address } = request.body;
      const result = await resolvePlace(address, {
        timeoutMs: geocodingConfig.resolve_timeout_ms,
        retryAttempts: 1,
        dailyCap: geocodingConfig.resolve_daily_cap,
      });

      if (result.kind === 'found') {
        request.log.info({ address_length: address.length, outcome: 'found' }, 'geo resolve');
        return reply.status(200).send(result.place);
      }
      if (result.kind === 'not_found') {
        request.log.info({ address_length: address.length, outcome: 'not_found' }, 'geo resolve');
        return reply.status(422).send({
          error: 'LOCATION_NOT_RESOLVED',
          message: `Could not resolve location '${address}' to a place`,
        });
      }
      request.log.info(
        { address_length: address.length, outcome: 'unavailable', reason: result.reason },
        'geo resolve',
      );
      return reply.status(503).send({
        error: 'GEOCODER_UNAVAILABLE',
        message: 'Geocoding is temporarily unavailable; retry later',
      });
    },
  });
};
