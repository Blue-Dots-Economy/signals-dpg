import z, { DiscoverItemsBodySchema, DiscoverResponseSchema } from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import {
  resolveAllowedFacetFilters,
  resolveTextSearchFields,
} from '@/utils/facet_guard';
import { getNetworkConfigById } from '@/network_configs';
import {
  searchSignals,
  SignalsSearchError,
  type SearchSignalsInput,
  type SignalsSearchItem,
} from '@/services/signals_search_client';
import { fetchItemsAcrossInstances } from '@/utils/inter_instance_fetch';

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
 * NATIVE FALLBACK (#394, revising #203 List PR Task 3): `searchSignals` throws
 * when signals-search is unconfigured (`SIGNALS_SEARCH_URL`/
 * `SIGNALS_SEARCH_API_KEY` unset), when the call times out (`AbortSignal.
 * timeout` in the client), or on any non-2xx/invalid response — all three
 * collapse to the same catch below. On catch, this BFF falls back to the
 * native `fetchItemsAcrossInstances` path (the same distance/recency-ordered,
 * live-only, paged fetch `/network/item/fetch` uses) so a search-service
 * outage degrades the list rather than 5xx-ing it. `q`/`filters` ARE now
 * applied on this native path too (#394) — the same value-match-on-public-
 * `item_state` (`text_search`) and facet (`item_state`) mechanisms the map's
 * `/markers` uses (see `resolveTextSearchFields`/`resolveAllowedFacetFilters`
 * in `facet_guard.ts`, applied by `buildWhereClause`) — so only relevance
 * RANKING is unavailable without signals-search. `meta.source:
 * 'native_fallback'`/`degraded: true` let the UI (Task 6) show the "basic
 * matches" note.
 *
 * PROFILE ANCHOR RELEVANCE (#394): `body.anchor_item_id` (the viewer's own
 * profile item) is forwarded to signals-search as `intent.item`. signals-
 * search returns an anchor error (`404 ANCHOR_NOT_FOUND` when the anchor isn't
 * indexed yet, or `403 INTERACTION_NOT_ALLOWED` when the anchor's domain has
 * no interaction with the browsed domain per the network's interaction matrix
 * — e.g. seeker→seeker) — neither is a search-service outage, so instead of
 * degrading to the native fallback, this retries `searchSignals` exactly once
 * with the anchor removed, still resolving as `source: 'signals_search'`,
 * `degraded: false`. The UI also avoids sending an anchor for non-interacting
 * domain pairs in the first place (schema-driven, see `home-page`); this
 * retry is the server-side safety net. Only a failure of THAT retry (or any
 * other non-anchor error) falls through to the native fallback.
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

type NativeFetchResult = Awaited<ReturnType<typeof fetchItemsAcrossInstances>>;
type NativeItem = NativeFetchResult['items'][number];

// Native fallback (Task 3): `fetchItemsAcrossInstances` already returns the
// same DPG item response shape (`ItemResponseSchema`) the discover response
// item extends, so this mapper is a narrow pass-through — no `score`/
// `distanceMeters` since the native path does no ranking (nearest-first is
// ordering only, not a comparable score).
function mapNativeItemToDiscoverItem(item: NativeItem) {
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

    // Validate item_type up-front (should-fix, PR #419 review): an unknown
    // item_type otherwise throws inside resolveAllowedFacetFilters →
    // getDomainItemSchema → the outer catch → a 500 that logs the client's
    // request body at error level. Treat a bogus item_type as a 400 bad
    // request, mirroring the served-domain guard's early return, and don't
    // log client input at error for it.
    const domainConfig = networkConfig.domains.find(
      (entry) => entry.id === body.item_domain
    );
    if (!domainConfig || domainConfig.item_schemas?.[body.item_type] === undefined) {
      return reply.code(400).send({
        error: 'INVALID_ITEM_TYPE',
        message: `item_type "${body.item_type}" is not defined for domain "${body.item_domain}" in network "${body.item_network}".`,
      });
    }

    // Server-resolved: the client's field list is never trusted, even though
    // item_state is already the masked public projection (defense-in-depth).
    const allowedFilters = resolveAllowedFacetFilters(
      networkConfig,
      body.item_domain,
      body.item_type,
      body.filters ?? []
    );

    const searchInput: SearchSignalsInput = {
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
      anchorItemId: body.anchor_item_id,
    };

    // Native fallback (#394, revising Task 3): thrown for a request timeout, a
    // non-2xx/invalid response, OR signals-search being unconfigured (the
    // client throws for all three). A search-service outage must never surface
    // as a 5xx, so this falls back to the native, distance/recency-ordered
    // paged fetch `/network/item/fetch` uses — but now applying `q`/`filters`
    // natively too (value-match on public item_state + declared, non-private
    // facet fields; #394 dropped the `filterable` gate — see
    // `resolveTextSearchFields`/`resolveAllowedFacetFilters` in `facet_guard.ts`,
    // applied by `buildWhereClause`), the same mechanisms `/markers` uses. So
    // only relevance RANKING is unavailable; `meta.source: 'native_fallback'`/
    // `degraded: true` tell the UI to show the "basic matches" note.
    //
    // Multi-instance limitation (single-instance is the target): the facet
    // `item_state` filter forwards to peers (each re-guards it), but `q` does
    // NOT (the peer `/fetch_local` body has no `q`), so on a federated network
    // a text query filters only this instance's rows; peers contribute live,
    // public, facet-filtered (but not text-filtered) rows. Documented follow-up.
    const fallBackToNative = async (logErr: unknown) => {
      request.log.warn(
        { err: logErr, body },
        'signals-search unavailable; falling back to native item fetch for discover (search/filters applied natively, no ranking)'
      );

      const nativeResult = await fetchItemsAcrossInstances({
        networkConfig,
        filters: {
          item_network: body.item_network,
          item_domain: body.item_domain,
          item_type: body.item_type,
          item_latitude: body.item_latitude,
          item_longitude: body.item_longitude,
          radius_meters: body.distance_meters,
          limit: body.limit,
          offset: body.offset,
          lifecycle_filter: 'live_only',
          item_state:
            allowedFilters.length > 0
              ? Object.fromEntries(
                  allowedFilters.map((filter) => [filter.field, filter.values])
                )
              : undefined,
          text_search: body.q
            ? {
                q: body.q,
                fields: resolveTextSearchFields(
                  networkConfig,
                  body.item_domain,
                  body.item_type
                ),
              }
            : undefined,
        },
        log: request.log,
      });

      const items = nativeResult.items.map(mapNativeItemToDiscoverItem);

      return reply.code(200).send({
        meta: {
          total: nativeResult.meta.total,
          limit: nativeResult.meta.limit,
          offset: nativeResult.meta.offset,
          source: 'native_fallback' as const,
          degraded: true,
        },
        items,
      });
    };

    try {
      const searchResult = await searchSignals(searchInput);

      // signals-search's order is already the ranked order — mapped straight
      // through, no local-DB hydrate/re-read by id (see module doc comment).
      const items = searchResult.items.map(mapSignalsSearchItemToDiscoverItem);

      return reply.code(200).send({
        meta: {
          total: searchResult.meta.total,
          limit: searchResult.meta.limit,
          offset: searchResult.meta.offset,
          source: 'signals_search' as const,
          degraded: false,
        },
        items,
      });
    } catch (searchErr) {
      // Anchor relevance (#394): an anchor signals-search can't use is a
      // client-input condition, not a search-service outage — retry ONCE
      // without the anchor rather than degrading to the native fallback
      // (which loses ranking). Two anchor cases: `404 ANCHOR_NOT_FOUND` (the
      // anchor isn't indexed yet) and `403 INTERACTION_NOT_ALLOWED` (the
      // anchor's domain has no interaction with the browsed domain per the
      // network's interaction matrix — e.g. a seeker anchor browsing seekers;
      // the UI already avoids sending the anchor for such pairs, this is the
      // server-side safety net). Any other error (no anchor sent, or a real
      // search failure) falls straight through to the native fallback below.
      const isRecoverableAnchorError =
        body.anchor_item_id !== undefined &&
        searchErr instanceof SignalsSearchError &&
        (searchErr.status === 404 ||
          searchErr.status === 403 ||
          searchErr.code === 'ANCHOR_NOT_FOUND' ||
          searchErr.code === 'INTERACTION_NOT_ALLOWED');

      if (isRecoverableAnchorError) {
        try {
          const retryResult = await searchSignals({
            ...searchInput,
            anchorItemId: undefined,
          });

          const items = retryResult.items.map(mapSignalsSearchItemToDiscoverItem);

          return reply.code(200).send({
            meta: {
              total: retryResult.meta.total,
              limit: retryResult.meta.limit,
              offset: retryResult.meta.offset,
              source: 'signals_search' as const,
              degraded: false,
            },
            items,
          });
        } catch (retryErr) {
          return await fallBackToNative(retryErr);
        }
      }

      return await fallBackToNative(searchErr);
    }
  } catch (err) {
    request.log.error(
      { err, body },
      'Failed to discover items'
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to discover items',
    });
  }
};
