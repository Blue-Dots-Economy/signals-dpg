import z, { DiscoverItemsBodySchema, DiscoverResponseSchema } from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { resolveAllowedFacetFilters } from '@/utils/facet_guard';
import { getNetworkConfigById } from '@/network_configs';
import { searchSignals, type SignalsSearchItem } from '@/services/signals_search_client';

type DiscoverItemsRequest = FastifyRequest<{
  Body: z.infer<typeof DiscoverItemsBodySchema>;
}>;

/**
 * Public `/network/item/discover` BFF (#203 List PR, P-follow-3 Task 2).
 * Mirrors `/network/item/fetch` in being unauthenticated (no `preHandler`) —
 * discovery of the masked public `item_state` needs no auth either way.
 *
 * DIRECT MAP (revised — signals-search PR #87): signals-search's `/v1/search`
 * now returns the full item row per result, so each ranked result is mapped
 * straight to the DPG item response shape below — no local-DB hydrate/
 * re-read by id. signals-search's order is already the ranked order and is
 * preserved as-is. Live-only, single-instance is now signals-search's own
 * indexing invariant rather than something this BFF enforces via a lifecycle
 * filter.
 *
 * This task's happy path always calls signals-search directly; Task 3 adds
 * the native-fallback + degraded flag when the search service is
 * unreachable/slow/misconfigured.
 */
function mapSignalsSearchItemToDiscoverItem(item: SignalsSearchItem) {
  return {
    item_id: item.item_id,
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_instance_url: item.item_instance_url,
    item_schema_url: item.item_schema_url,
    item_state: item.item_state,
    item_locations: item.item_locations,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
    lifecycle_status: item.lifecycle_status,
    score: item.score,
    distanceMeters: item.distanceMeters,
  };
}

export const discover: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/item/discover',
    method: 'POST',
    schema: {
      tags: ['network'],
      body: DiscoverItemsBodySchema,
      response: {
        200: DiscoverResponseSchema,
      },
    },
    handler: discover_items_handler,
  });
};

const discover_items_handler = async (
  request: DiscoverItemsRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(reply, body.item_network, body.item_domain);
  }

  try {
    const networkConfig = await getNetworkConfigById(body.item_network);

    // Server-resolved: the client's field list is never trusted, even though
    // item_state is already the masked public projection (defense-in-depth).
    const allowedFilters = resolveAllowedFacetFilters(
      networkConfig,
      body.item_domain,
      body.item_type,
      body.filters ?? []
    );

    const searchResult = await searchSignals({
      network: body.item_network,
      domain: body.item_domain,
      itemType: body.item_type,
      q: body.q,
      filters: allowedFilters,
      lat: body.item_latitude,
      lng: body.item_longitude,
      distanceMeters: body.distance_meters,
      limit: body.limit,
      offset: body.offset,
    });

    // signals-search's order is already the ranked order — mapped straight
    // through, no local-DB hydrate/re-read by id (see module doc comment).
    const items = searchResult.items.map(mapSignalsSearchItemToDiscoverItem);

    return reply.code(200).send({
      meta: {
        total: searchResult.meta.total,
        limit: searchResult.meta.limit,
        offset: searchResult.meta.offset,
      },
      items,
    });
  } catch (err) {
    request.log.error(
      { err, body },
      'Failed to discover items via signals-search'
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to discover items',
    });
  }
};
