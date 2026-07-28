import z, { DiscoverItemsBodySchema, DiscoverResponseSchema } from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { fetchLocalItemsByIds } from '@/utils/item_fetch_runtime';
import { resolveAllowedFacetFilters } from '@/utils/facet_guard';
import { getNetworkConfigById } from '@/network_configs';
import { searchSignals } from '@/services/signals_search_client';

type DiscoverItemsRequest = FastifyRequest<{
  Body: z.infer<typeof DiscoverItemsBodySchema>;
}>;

/**
 * Public `/network/item/discover` BFF (#203 List PR, P-follow-3 Task 2).
 * Mirrors `/network/item/fetch` in being unauthenticated (no `preHandler`) —
 * discovery of the masked public `item_state` needs no auth either way.
 *
 * RANK-THEN-HYDRATE: signals-search ranks (ids + score/distanceMeters), then
 * this handler hydrates the full item rows from the local DB, preserving
 * signals-search's order, so the response shape matches native
 * `/network/item/fetch` items (same fields, e.g. `item_instance_url`) plus
 * `score`/`distanceMeters`. Live-only, single-instance — see
 * `fetchLocalItemsByIds` for why there's no cross-instance aggregation here.
 *
 * This task's happy path always calls signals-search directly; Task 3 adds
 * the native-fallback + degraded flag when the search service is
 * unreachable/slow/misconfigured.
 */
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

    const rankedIds = searchResult.items.map((item) => item.item_id);
    const rows = await fetchLocalItemsByIds({
      item_network: body.item_network,
      item_domain: body.item_domain,
      item_ids: rankedIds,
      lifecycle_filter: 'live_only',
    });
    const rowsById = new Map(rows.map((row) => [row.item_id, row]));

    // Preserve signals-search's ranked order; drop any id with no local row
    // (item retired/removed since being indexed — see fetchLocalItemsByIds).
    const items = rankedIds.flatMap((itemId, index) => {
      const row = rowsById.get(itemId);
      if (!row) return [];
      const rankedItem = searchResult.items[index];
      return [
        {
          ...row,
          score: rankedItem.score,
          distanceMeters: rankedItem.distanceMeters,
        },
      ];
    });

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
