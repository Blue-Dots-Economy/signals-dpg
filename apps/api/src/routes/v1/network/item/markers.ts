import z, {
  MarkersBodySchema,
  MarkersQuerySchema,
  MarkerResponseSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { fetchLocalMarkers } from '@/utils/item_fetch_runtime';
import { getNetworkConfigById } from '@/network_configs';
import { fetchMarkersAcrossInstances } from '@/utils/inter_instance_fetch';
import { peer_instance_guard } from '@/middleware/peer_instance_guard';

type FetchMarkersAggregateRequest = FastifyRequest<{
  Querystring: z.infer<typeof MarkersQuerySchema>;
}>;

type FetchMarkersLocalRequest = FastifyRequest<{
  Body: z.infer<typeof MarkersBodySchema>;
}>;

export const markers: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/item/markers',
    method: 'GET',
    schema: {
      tags: ['network'],
      query: MarkersQuerySchema,
      response: {
        200: z.object({
          meta: z.object({
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
            partial: z.boolean(),
            unavailable_instances: z.string().array(),
          }),
          markers: MarkerResponseSchema.array(),
        }),
      },
    },
    handler: fetch_network_markers_handler,
  });

  fastify.route({
    url: '/item/markers_local',
    method: 'POST',
    preHandler: peer_instance_guard,
    schema: {
      tags: ['network'],
      body: MarkersBodySchema,
      response: {
        200: z.object({
          meta: z.object({
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          markers: MarkerResponseSchema.array(),
        }),
      },
    },
    handler: fetch_local_markers_handler,
  });
};

const fetch_network_markers_handler = async (
  request: FetchMarkersAggregateRequest,
  reply: FastifyReply
) => {
  const {
    item_id,
    item_network,
    item_type,
    item_domain,
    item_instance_url,
    item_schema_url,
    item_state,
    item_latitude,
    item_longitude,
    radius_meters,
    min_lat,
    min_lng,
    max_lat,
    max_lng,
    limit,
    offset,
    cache_ttl_seconds,
  } = request.query;

  try {
    const networkConfig = await getNetworkConfigById(item_network);
    const domainExists = networkConfig.domains.some(
      (domain: (typeof networkConfig.domains)[number]) =>
        domain.id === item_domain
    );

    if (!domainExists) {
      return await replyForUnservedDomain(reply, item_network, item_domain);
    }

    const result = await fetchMarkersAcrossInstances({
      networkConfig,
      filters: {
        item_id,
        item_network,
        item_type,
        item_domain,
        item_instance_url,
        item_schema_url,
        item_state,
        item_latitude,
        item_longitude,
        radius_meters,
        min_lat,
        min_lng,
        max_lat,
        max_lng,
        limit,
        offset,
        lifecycle_filter: 'live_only',
      },
      requestedCacheTtlSeconds: cache_ttl_seconds,
      log: request.log,
    });

    reply.header('x-network-partial', String(result.meta.partial));
    return reply.code(200).send(result);
  } catch (err) {
    request.log.error(
      { err, query: request.query },
      'Failed to fetch markers across network instances'
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch markers across network instances',
    });
  }
};

const fetch_local_markers_handler = async (
  request: FetchMarkersLocalRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  return reply
    .code(200)
    .send(await fetchLocalMarkers({ ...body, lifecycle_filter: 'live_only' }));
};
