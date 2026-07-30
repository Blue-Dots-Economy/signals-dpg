import z, {
  MarkersBodySchema,
  MarkersQuerySchema,
  MarkerResponseSchema,
  getDomainItemSchema,
  getDomainItemTypes,
  type NetworkConfigDocument,
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
import { resolveAllowedFacetFields } from '@/utils/facet_guard';

/**
 * #394 map native text search: resolves the SERVER-known allowlist of
 * non-private `item_state` field keys a free-text `q` may match against, for
 * a given network/domain (+ optional item_type). Reuses
 * `resolveAllowedFacetFields` (facet_guard.ts) — the same `private: true`
 * convention every other item_state guard in this codebase already trusts —
 * never the client's own field list, so a client can't expand its match
 * surface by naming more fields.
 *
 * `item_type` is optional on `MarkersQuerySchema`/`MarkersBodySchema` (a
 * viewport can span every item_type in a domain), so when it's omitted this
 * unions the non-private fields across every item_type declared for the
 * domain — the same "no single item_type" treatment item_fetch_runtime.ts's
 * own (differently-scoped, array-facet) `resolveAllowedFacetFields` already
 * gives. A network/domain/item_type this instance doesn't actually define
 * contributes no fields — fails closed via `buildWhereClause`'s
 * `fields.length === 0` branch (unsatisfiable match), never a throw or a 500.
 */
function resolveTextSearchFields(
  networkConfig: NetworkConfigDocument,
  domain: string,
  itemType: string | undefined
): string[] {
  let itemTypes: string[];
  try {
    itemTypes = itemType ? [itemType] : getDomainItemTypes(networkConfig, domain);
  } catch {
    return [];
  }

  const fields = new Set<string>();
  for (const type of itemTypes) {
    let schema: Record<string, unknown>;
    try {
      schema = getDomainItemSchema(networkConfig, domain, type) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    for (const field of resolveAllowedFacetFields(schema).keys()) {
      fields.add(field);
    }
  }

  return [...fields];
}

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
    q,
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
        text_search: q
          ? { q, fields: resolveTextSearchFields(networkConfig, item_domain, item_type) }
          : undefined,
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

  // The peer body carries only the raw `q` (#394) — never a resolved field
  // allowlist (see MarkersSchemaBase's doc comment). This instance resolves
  // its OWN non-private field set from its OWN network config rather than
  // trusting anything the requesting peer computed, mirroring every other
  // item_state guard in this file/module.
  let textSearchFields: string[] = [];
  if (body.q) {
    const networkConfig = await getNetworkConfigById(body.item_network);
    textSearchFields = resolveTextSearchFields(
      networkConfig,
      body.item_domain,
      body.item_type
    );
  }

  return reply.code(200).send(
    await fetchLocalMarkers(
      {
        ...body,
        lifecycle_filter: 'live_only',
        text_search: body.q ? { q: body.q, fields: textSearchFields } : undefined,
      },
      request.log
    )
  );
};
