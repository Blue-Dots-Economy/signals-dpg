import z, {
  DiscoverItemsBodySchema,
  DiscoverResponseSchema,
  type DiscoverSort,
} from '@dpg/schemas';
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
  type SignalsSearchFacetInput,
} from '@/services/signals_search_client';
import { fetchItemsAcrossInstances } from '@/utils/inter_instance_fetch';
import { signalsSearchConfig } from '@/config';

// Mirrors signals-search's default `s_dwithin` radius. Used only to report
// `meta.distance_meters`; never sent, so signals-search applies its own default.
const DEFAULT_SEARCH_DISTANCE_METERS = 30000;

type DiscoverItemsRequest = FastifyRequest<{
  Body: z.infer<typeof DiscoverItemsBodySchema>;
}>;

/**
 * Public `/network/item/discover` BFF: signals-search first, native fetch as
 * fallback. Unauthenticated like `/network/item/fetch`; it returns only the
 * masked public `item_state`.
 *
 * Design: docs/architecture/http-discover.md
 */
/**
 * Default and validate the requested order. Mirrors `resolveSort` in
 * signals-search; the two services deploy independently, so it is not shared.
 *
 * Never errors: an order the request cannot have degrades to `newest`, and the
 * response reports what was actually applied.
 */
export function resolveDiscoverSort(input: {
  requested?: DiscoverSort;
  hasAnchor: boolean;
  hasQ: boolean;
  hasOrderingCenter: boolean;
}): DiscoverSort {
  if (input.requested === 'relevance') {
    // Cosine needs a query vector, which comes from the anchor or the text.
    return input.hasAnchor || input.hasQ ? 'relevance' : 'newest';
  }
  if (input.requested === 'nearest') {
    return input.hasOrderingCenter ? 'nearest' : 'newest';
  }
  if (input.requested === 'newest') return 'newest';

  // Unspecified: relevance whenever there is a query vector (anchor or text).
  // `buildSearchInput` always sends `sort`, so this default overrides
  // signals-search's own inference and must match it.
  return input.hasAnchor || input.hasQ ? 'relevance' : 'newest';
}

/**
 * The geo params the native fallback should receive. `buildDistanceOrderBy`
 * keys off lat/lng only, while `buildWhereClause` adds a radius clause only
 * when lat, lng and radius_meters are all present.
 */
function resolveNativeGeoFilters(input: {
  sortApplied: DiscoverSort;
  hasAreaFilter: boolean;
  effectiveDistanceMeters: number | undefined;
  body: Pick<
    z.infer<typeof DiscoverItemsBodySchema>,
    | 'item_latitude'
    | 'item_longitude'
    | 'ordering_latitude'
    | 'ordering_longitude'
    | 'min_lat'
    | 'min_lng'
    | 'max_lat'
    | 'max_lng'
  >;
}): {
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  order_by?: 'distance' | 'created_at';
} {
  const { sortApplied, hasAreaFilter, effectiveDistanceMeters, body } = input;

  // Viewport: the bbox filters; `nearest` inside a viewport orders by the
  // ordering centre the UI sends alongside it.
  if (body.min_lat !== undefined) {
    const nearestCentreGiven =
      sortApplied === 'nearest' &&
      body.ordering_latitude !== undefined &&
      body.ordering_longitude !== undefined;
    return {
      min_lat: body.min_lat,
      min_lng: body.min_lng,
      max_lat: body.max_lat,
      max_lng: body.max_lng,
      ...(nearestCentreGiven
        ? {
            item_latitude: body.ordering_latitude,
            item_longitude: body.ordering_longitude,
            order_by: 'distance' as const,
          }
        : { order_by: 'created_at' as const }),
    };
  }

  if (sortApplied === 'nearest') {
    // Natively one lat/lng pair is both the filter centre and the distance
    // origin. With a radius area, the area's centre wins for both, so the
    // native path filters the same circle signals-search would. With no
    // radius, the ordering centre orders an unbounded set.
    const hasRadius = effectiveDistanceMeters !== undefined;
    return hasRadius
      ? {
          item_latitude: body.item_latitude,
          item_longitude: body.item_longitude,
          radius_meters: effectiveDistanceMeters,
          order_by: 'distance',
        }
      : {
          item_latitude: body.ordering_latitude,
          item_longitude: body.ordering_longitude,
          order_by: 'distance',
        };
  }
  if (hasAreaFilter) {
    return {
      item_latitude: body.item_latitude,
      item_longitude: body.item_longitude,
      radius_meters: effectiveDistanceMeters,
      // The area narrows the set but must not choose the order: the native
      // ORDER BY otherwise keys off the mere presence of coordinates.
      order_by: 'created_at',
    };
  }
  return { order_by: 'created_at' };
}

/** The signals-search input for one discover request. */
function buildSearchInput(input: {
  body: z.infer<typeof DiscoverItemsBodySchema>;
  filters: SignalsSearchFacetInput[];
  sortApplied: DiscoverSort;
  hasBbox: boolean;
  hasRadiusCenter: boolean;
  hasOrderingCenter: boolean;
}): SearchSignalsInput {
  const { body, filters, sortApplied, hasBbox, hasRadiusCenter, hasOrderingCenter } = input;

  const bbox = hasBbox
    ? {
        minLat: body.min_lat,
        minLng: body.min_lng,
        maxLat: body.max_lat,
        maxLng: body.max_lng,
      }
    : undefined;

  const radius = hasRadiusCenter
    ? {
        lat: body.item_latitude,
        lng: body.item_longitude,
        // Not `effectiveDistanceMeters`: when neither request nor env sets a
        // radius, nothing is sent and signals-search applies its own default.
        // Sending our mirrored default would pin it if theirs changed.
        distanceMeters: body.distance_meters ?? signalsSearchConfig.distanceMeters,
      }
    : undefined;

  const ordering = hasOrderingCenter
    ? { orderingLat: body.ordering_latitude, orderingLng: body.ordering_longitude }
    : undefined;

  return {
    network: body.item_network,
    domain: body.item_domain,
    itemType: body.item_type,
    q: body.q,
    filters,
    ...bbox,
    ...radius,
    ...ordering,
    sort: sortApplied,
    limit: body.limit,
    offset: body.offset,
    anchorItemId: body.anchor_item_id,
  };
}

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

// No `score`/`distanceMeters`: the native path does no ranking.
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

    // Validate item_type up front: an unknown one otherwise throws inside
    // resolveAllowedFacetFilters and becomes a 500 that logs the client's body
    // at error level.
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

    // Area filter, opt-in: `radius` sends a centre (+ distance), `viewport` a
    // rectangle. In the default `anywhere` mode no spatial clause is built and
    // the SIGNALS_SEARCH_DISTANCE_METERS fallback does not apply, because
    // signals-search treats any spatial clause as a hard `s_dwithin` predicate.
    const hasBbox = body.min_lat !== undefined;
    // The reported radius keys off this, not off "some area filter exists".
    const hasRadiusCenter =
      body.item_latitude !== undefined && body.item_longitude !== undefined;
    const hasAreaFilter = hasRadiusCenter || hasBbox;

    // Effective reported radius, for a radius filter only: request override,
    // then env, then the mirrored signals-search default. A viewport applies
    // no radius, and the UI shows a "within X km" note whenever this is set.
    const effectiveDistanceMeters = hasRadiusCenter
      ? (body.distance_meters ??
        signalsSearchConfig.distanceMeters ??
        DEFAULT_SEARCH_DISTANCE_METERS)
      : undefined;

    // Ordering centre: orders without filtering. Never contributes a spatial
    // clause and never sets `meta.distance_meters`.
    const hasOrderingCenter =
      body.ordering_latitude !== undefined && body.ordering_longitude !== undefined;

    // `nearest` needs a centre. A radius area's centre serves as one; a
    // viewport's midpoint does not, or "search this area" would change the
    // chosen sort.
    const sortApplied = resolveDiscoverSort({
      requested: body.sort,
      hasAnchor: body.anchor_item_id !== undefined,
      hasQ: body.q !== undefined,
      hasOrderingCenter: hasOrderingCenter || hasRadiusCenter,
    });

    const searchInput = buildSearchInput({
      body,
      filters: allowedFilters,
      sortApplied,
      hasBbox,
      hasRadiusCenter,
      hasOrderingCenter,
    });

    // Native fallback for a timeout, a non-2xx/invalid response, or an
    // unconfigured signals-search: an outage must never surface as a 5xx. `q`
    // and facet filters still apply natively; only ranking is lost. `q` is not
    // forwarded to peers, so on a federated network it filters only this
    // instance's rows.
    const nativeGeoFilters = resolveNativeGeoFilters({
      sortApplied,
      hasAreaFilter,
      effectiveDistanceMeters,
      body,
    });

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
          ...nativeGeoFilters,
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
          // The native path has no anchor concept; `q` still filters here.
          anchor_applied: false,
          distance_meters: effectiveDistanceMeters,
          // No native ranking: a relevance request got recency.
          sort_applied: sortApplied === 'relevance' ? ('newest' as const) : sortApplied,
        },
        items,
      });
    };

    try {
      const searchResult = await searchSignals(searchInput);

      if (searchResult.meta.sort_applied === undefined) {
        // Logged because it is otherwise invisible. Only a signals-search
        // predating explicit sort omits the field.
        request.log.warn(
          {
            itemNetwork: body.item_network,
            itemDomain: body.item_domain,
            requestedSort: body.sort,
            resolvedSort: sortApplied,
          },
          'signals-search reported no sort_applied; it predates explicit sort, so the applied order is unknown and is reported as unknown'
        );
      }

      // signals-search's order is the ranked order; no local re-read by id.
      const items = searchResult.items.map(mapSignalsSearchItemToDiscoverItem);

      return reply.code(200).send({
        meta: {
          total: searchResult.meta.total,
          limit: searchResult.meta.limit,
          offset: searchResult.meta.offset,
          source: 'signals_search' as const,
          degraded: false,
          distance_meters: effectiveDistanceMeters,
          // Reached only when signals-search did NOT reject the anchor, so an
          // anchor that was sent was also used.
          anchor_applied: body.anchor_item_id !== undefined,
          // signals-search is the authority; absent means unknown, never our
          // guess. A version predating sort support ignores `intent.sort`, so
          // its order cannot be predicted here, and the UI then names no order.
          sort_applied: searchResult.meta.sort_applied,
        },
        items,
      });
    } catch (searchErr) {
      // An unusable anchor is a client-input condition, not an outage: retry
      // once without it rather than losing ranking to the native fallback.
      // `404 ANCHOR_NOT_FOUND` = not indexed yet; `403 INTERACTION_NOT_ALLOWED`
      // = the network's interaction matrix has no edge between the anchor's
      // domain and the browsed one. Any other error falls through to native.
      const isRecoverableAnchorError =
        body.anchor_item_id !== undefined &&
        searchErr instanceof SignalsSearchError &&
        (searchErr.status === 404 ||
          searchErr.status === 403 ||
          searchErr.code === 'ANCHOR_NOT_FOUND' ||
          searchErr.code === 'INTERACTION_NOT_ALLOWED');

      if (isRecoverableAnchorError) {
        // Logged because the retry is otherwise invisible: it returns 200,
        // `degraded: false`, and only `sort_applied` differs.
        request.log.warn(
          {
            err: searchErr,
            anchorItemId: body.anchor_item_id,
            itemNetwork: body.item_network,
            itemDomain: body.item_domain,
            requestedSort: body.sort,
            resolvedSort: sortApplied,
          },
          'signals-search rejected the discover anchor; retrying without it (relevance ranking will degrade to newest)'
        );

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
              distance_meters: effectiveDistanceMeters,
              // The only way the caller can tell the anchor was dropped.
              anchor_applied: false,
              // Same rule as the primary path: absent means unknown.
              sort_applied: retryResult.meta.sort_applied,
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
