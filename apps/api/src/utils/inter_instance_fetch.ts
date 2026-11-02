import type { FastifyBaseLogger } from 'fastify';
import {
  getDomainMinimumCacheTtlSeconds,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import { redis } from '@api/db/secondary/redis';
import { stableStringify } from './stable_stringify';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { buildPeerHeaders } from '@/utils/instance_token';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import {
  countLocalItems,
  fetchLocalItems,
  fetchLocalMarkers,
  type ItemFetchFilters,
  type ItemFetchLog,
} from '@/utils/item_fetch_runtime';
import { mergeSortAndSlice, type MergeableRow } from '@/utils/instance_merge';
import type { LatLng } from '@/utils/geo_distance';

type InstanceCount = {
  instanceUrl: string;
  count: number;
};

type PageSlice = {
  instanceUrl: string;
  offset: number;
  limit: number;
};

type FetchItemsResponse = Awaited<ReturnType<typeof fetchLocalItems>>;
type FetchItemsResponseItem = FetchItemsResponse['items'][number];

type FetchMarkersResponse = Awaited<ReturnType<typeof fetchLocalMarkers>>;
type FetchMarkersResponseMarker = FetchMarkersResponse['markers'][number];

export function buildPagePlan(
  counts: InstanceCount[],
  offset: number,
  limit: number
): PageSlice[] {
  const active = counts.filter((entry) => entry.count > 0);
  const globalStart = offset;
  const globalEnd = offset + limit;
  const slices: PageSlice[] = [];
  let cursor = 0;

  for (const inst of active) {
    const instStart = cursor;
    const instEnd = cursor + inst.count;

    const overlapStart = Math.max(globalStart, instStart);
    const overlapEnd = Math.min(globalEnd, instEnd);

    if (overlapStart < overlapEnd) {
      slices.push({
        instanceUrl: inst.instanceUrl,
        offset: overlapStart - instStart,
        limit: overlapEnd - overlapStart,
      });
    }

    cursor = instEnd;
  }

  return slices;
}

/**
 * Cross-instance top-K merge, used only when more than one instance has
 * matching rows (a single instance's direct slice is already globally ordered).
 * Asks every active peer for its own top `offset + limit` rows, merges the
 * union here and slices the page. A failed peer is reported in
 * `unavailableInstances` rather than failing the page.
 *
 * `peerLimitMax` is the peer route's own `limit` cap; asking for more would
 * fail the peer's body validation. Past that cap, ordering for a deep page is
 * approximate: each peer contributes at most `peerLimitMax` rows.
 */
export async function scatterGatherPage<T extends MergeableRow>(input: {
  activeInstances: string[];
  filters: ItemFetchFilters;
  peerLimitMax: number;
  fetchPage: (input: {
    instanceUrl: string;
    filters: ItemFetchFilters;
  }) => Promise<T[]>;
}): Promise<{ rows: T[]; unavailableInstances: Set<string> }> {
  const { offset, limit, item_latitude, item_longitude, order_by } = input.filters;

  // Over-fetch from each peer because the share of any peer's rows in the
  // final page is unknown in advance.
  const topNFilters: ItemFetchFilters = {
    ...input.filters,
    offset: 0,
    limit: Math.min(offset + limit, input.peerLimitMax),
  };

  const settled = await Promise.allSettled(
    input.activeInstances.map(async (instanceUrl) => ({
      instanceUrl,
      rows: await input.fetchPage({ instanceUrl, filters: topNFilters }),
    }))
  );

  const unavailableInstances = new Set<string>();
  const union: T[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      union.push(...result.value.rows);
      return;
    }
    unavailableInstances.add(input.activeInstances[index]);
  });

  const center: LatLng | null =
    item_latitude !== undefined && item_longitude !== undefined
      ? { lat: item_latitude, lng: item_longitude }
      : null;

  // Peers order by earth_distance and mergeSortAndSlice uses haversine on the
  // same 6371 km sphere, so this is a true merge of sorted runs. `order_by` is
  // forwarded so the merge honours the requested order.
  const rows = mergeSortAndSlice(union, { center, offset, limit, orderBy: order_by });

  return { rows, unavailableInstances };
}

export async function fetchItemsAcrossInstances(input: {
  networkConfig: NetworkConfigDocument;
  filters: ItemFetchFilters;
  requestedCacheTtlSeconds?: number;
  log: FastifyBaseLogger;
}) {
  const minimumTtlSeconds = getDomainMinimumCacheTtlSeconds(
    input.networkConfig,
    input.filters.item_domain
  );
  const cacheTtlSeconds = Math.max(
    minimumTtlSeconds,
    input.requestedCacheTtlSeconds ?? minimumTtlSeconds
  );
  const pageCacheKey = buildPageCacheKey(input.filters, cacheTtlSeconds);
  const cachedPage = await redis.get(pageCacheKey);

  if (cachedPage) {
    // Only complete aggregates are cached, so a hit is complete. Older entries
    // lack the partial fields; default them for a stable response shape.
    const normalized = normalizeFetchItemsResponse(
      JSON.parse(cachedPage) as FetchItemsResponse
    );
    return {
      ...normalized,
      meta: {
        ...normalized.meta,
        partial: false,
        unavailable_instances: [] as string[],
      },
    };
  }

  const domainInstances = input.networkConfig.instances.filter(
    (instance) => instance.domain_id === input.filters.item_domain
  );

  // One unhealthy or slow peer must never fail the whole aggregate: fan out
  // with allSettled, drop failed peers with a warn, and return a partial.
  const unavailableInstances = new Set<string>();

  const settledCounts = await Promise.allSettled(
    domainInstances.map(async (instance) => ({
      instanceUrl: instance.instance_url,
      count: await getInstanceCount({
        instanceUrl: instance.instance_url,
        filters: input.filters,
        cacheTtlSeconds,
        log: input.log,
      }),
    }))
  );

  const counts: InstanceCount[] = [];
  settledCounts.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      counts.push(result.value);
      return;
    }
    const instanceUrl = domainInstances[index].instance_url;
    unavailableInstances.add(instanceUrl);
    input.log.warn(
      { err: result.reason, instanceUrl, phase: 'count' },
      'Peer count fetch failed; excluding instance from aggregate'
    );
  });

  const total = counts.reduce(
    (sum: number, entry: InstanceCount) => sum + entry.count,
    0
  );

  // With at most one active instance, its direct slice is already globally
  // ordered, so no scatter-gather is needed.
  const activeInstances = counts.filter((entry) => entry.count > 0);

  let items: FetchItemsResponseItem[];

  if (activeInstances.length <= 1) {
    const slices = buildPagePlan(counts, input.filters.offset, input.filters.limit);
    const settledResponses = await Promise.allSettled(
      slices.map((slice) =>
        fetchInstancePage({
          instanceUrl: slice.instanceUrl,
          filters: {
            ...input.filters,
            offset: slice.offset,
            limit: slice.limit,
          },
          log: input.log,
        })
      )
    );

    const responses: FetchItemsResponse[] = [];
    settledResponses.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        responses.push(result.value);
        return;
      }
      const instanceUrl = slices[index].instanceUrl;
      unavailableInstances.add(instanceUrl);
      input.log.warn(
        { err: result.reason, instanceUrl, phase: 'page' },
        'Peer page fetch failed; dropping slice from aggregate'
      );
    });

    items = responses.flatMap((response) => response.items);
  } else {
    const { rows, unavailableInstances: failedPages } =
      await scatterGatherPage<FetchItemsResponseItem>({
        activeInstances: activeInstances.map((entry) => entry.instanceUrl),
        filters: input.filters,
        // FetchItemsBodySchema caps `limit` at 1000 on the peer.
        peerLimitMax: 1000,
        fetchPage: async ({ instanceUrl, filters }) =>
          (await fetchInstancePage({ instanceUrl, filters, log: input.log })).items,
      });

    failedPages.forEach((instanceUrl) => {
      unavailableInstances.add(instanceUrl);
      input.log.warn(
        { instanceUrl, phase: 'page' },
        'Peer page fetch failed; excluding instance from scatter-gather aggregate'
      );
    });

    items = rows;
  }

  const partial = unavailableInstances.size > 0;

  const mergedResponse = {
    meta: {
      total,
      limit: input.filters.limit,
      offset: input.filters.offset,
      partial,
      unavailable_instances: [...unavailableInstances],
    },
    items,
  };

  // Never cache a partial aggregate: caching it would serve incomplete data
  // under the full-page key even after the failed peer recovers. Skipping the
  // write means the next request re-attempts the peer and self-heals.
  if (!partial) {
    await redis.set(
      pageCacheKey,
      JSON.stringify(mergedResponse),
      'EX',
      cacheTtlSeconds
    );
  }

  return mergedResponse;
}

/**
 * Marker counterpart of fetchItemsAcrossInstances: same count-first discovery
 * and partial semantics, slim marker projection, and a distinct `marker-page:*`
 * cache key. Across instances the merge is nearest-first when a centre is
 * supplied. Without a centre (anonymous viewer, bbox only) markers carry no
 * `created_at`, so the merge cannot reorder and which markers survive the cap
 * is unspecified; acceptable because the cap is a density guard, not a ranking.
 */
export async function fetchMarkersAcrossInstances(input: {
  networkConfig: NetworkConfigDocument;
  filters: ItemFetchFilters;
  requestedCacheTtlSeconds?: number;
  log: FastifyBaseLogger;
}) {
  const minimumTtlSeconds = getDomainMinimumCacheTtlSeconds(
    input.networkConfig,
    input.filters.item_domain
  );
  const cacheTtlSeconds = Math.max(
    minimumTtlSeconds,
    input.requestedCacheTtlSeconds ?? minimumTtlSeconds
  );
  const pageCacheKey = buildMarkerPageCacheKey(input.filters, cacheTtlSeconds);
  const cachedPage = await redis.get(pageCacheKey);

  if (cachedPage) {
    // Only complete aggregates are cached, so a hit is complete. Older entries
    // lack the partial fields; default them for a stable response shape.
    const normalized = JSON.parse(cachedPage) as FetchMarkersResponse;
    return {
      ...normalized,
      meta: {
        ...normalized.meta,
        partial: false,
        unavailable_instances: [] as string[],
      },
    };
  }

  const domainInstances = input.networkConfig.instances.filter(
    (instance) => instance.domain_id === input.filters.item_domain
  );

  // One unhealthy or slow peer must never fail the whole aggregate: fan out
  // with allSettled, drop failed peers with a warn, and return a partial.
  const unavailableInstances = new Set<string>();

  const settledCounts = await Promise.allSettled(
    domainInstances.map(async (instance) => ({
      instanceUrl: instance.instance_url,
      count: await getInstanceCount({
        instanceUrl: instance.instance_url,
        filters: input.filters,
        cacheTtlSeconds,
        log: input.log,
      }),
    }))
  );

  const counts: InstanceCount[] = [];
  settledCounts.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      counts.push(result.value);
      return;
    }
    const instanceUrl = domainInstances[index].instance_url;
    unavailableInstances.add(instanceUrl);
    input.log.warn(
      { err: result.reason, instanceUrl, phase: 'count' },
      'Peer count fetch failed; excluding instance from aggregate'
    );
  });

  const total = counts.reduce(
    (sum: number, entry: InstanceCount) => sum + entry.count,
    0
  );

  // With at most one active instance, its direct slice is already globally
  // ordered, so no scatter-gather is needed.
  const activeInstances = counts.filter((entry) => entry.count > 0);

  let markers: FetchMarkersResponseMarker[];

  if (activeInstances.length <= 1) {
    const slices = buildPagePlan(counts, input.filters.offset, input.filters.limit);
    const settledResponses = await Promise.allSettled(
      slices.map((slice) =>
        fetchInstanceMarkers({
          instanceUrl: slice.instanceUrl,
          filters: {
            ...input.filters,
            offset: slice.offset,
            limit: slice.limit,
          },
          log: input.log,
        })
      )
    );

    const responses: FetchMarkersResponse[] = [];
    settledResponses.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        responses.push(result.value);
        return;
      }
      const instanceUrl = slices[index].instanceUrl;
      unavailableInstances.add(instanceUrl);
      input.log.warn(
        { err: result.reason, instanceUrl, phase: 'page' },
        'Peer marker page fetch failed; dropping slice from aggregate'
      );
    });

    markers = responses.flatMap((response) => response.markers);
  } else {
    const { rows, unavailableInstances: failedPages } =
      await scatterGatherPage<FetchMarkersResponseMarker>({
        activeInstances: activeInstances.map((entry) => entry.instanceUrl),
        filters: input.filters,
        // MarkersBodySchema caps `limit` at 25000 on the peer.
        peerLimitMax: 25000,
        fetchPage: async ({ instanceUrl, filters }) =>
          (await fetchInstanceMarkers({ instanceUrl, filters, log: input.log })).markers,
      });

    failedPages.forEach((instanceUrl) => {
      unavailableInstances.add(instanceUrl);
      input.log.warn(
        { instanceUrl, phase: 'page' },
        'Peer marker page fetch failed; excluding instance from scatter-gather aggregate'
      );
    });

    markers = rows;
  }

  const partial = unavailableInstances.size > 0;

  const mergedResponse = {
    meta: {
      total,
      limit: input.filters.limit,
      offset: input.filters.offset,
      partial,
      unavailable_instances: [...unavailableInstances],
    },
    markers,
  };

  // Never cache a partial aggregate: caching it would serve incomplete data
  // under the full-page key even after the failed peer recovers. Skipping the
  // write means the next request re-attempts the peer and self-heals.
  if (!partial) {
    await redis.set(
      pageCacheKey,
      JSON.stringify(mergedResponse),
      'EX',
      cacheTtlSeconds
    );
  }

  return mergedResponse;
}

export async function getInstanceCount(input: {
  instanceUrl: string;
  filters: ItemFetchFilters;
  cacheTtlSeconds: number;
  log?: ItemFetchLog;
}) {
  const countCacheKey = buildCountCacheKey(input.filters, input.instanceUrl);
  const cachedCount = await redis.get(countCacheKey);

  if (cachedCount) {
    return Number(cachedCount);
  }

  const countFilters = {
    item_id: input.filters.item_id,
    item_network: input.filters.item_network,
    item_domain: input.filters.item_domain,
    item_type: input.filters.item_type,
    item_instance_url: input.filters.item_instance_url,
    item_schema_url: input.filters.item_schema_url,
    item_state: input.filters.item_state,
    // Applies to the in-process local count. A remote peer's count_local body
    // schema has no text_search, so it is stripped there: cross-instance
    // counts are not narrowed by `q`.
    text_search: input.filters.text_search,
    item_latitude: input.filters.item_latitude,
    item_longitude: input.filters.item_longitude,
    radius_meters: input.filters.radius_meters,
    min_lat: input.filters.min_lat,
    min_lng: input.filters.min_lng,
    max_lat: input.filters.max_lat,
    max_lng: input.filters.max_lng,
    lifecycle_filter: input.filters.lifecycle_filter,
  };

  const count =
    input.instanceUrl === getCurrentApiBaseUrl() &&
    isServedDomainBinding(input.filters.item_network, input.filters.item_domain)
      ? await countLocalItems(countFilters, input.log)
      : await fetchRemoteCount(input.instanceUrl, countFilters);

  await redis.set(countCacheKey, String(count), 'EX', input.cacheTtlSeconds);

  return count;
}

async function fetchInstancePage(input: {
  instanceUrl: string;
  filters: ItemFetchFilters;
  log?: ItemFetchLog;
}) {
  if (
    input.instanceUrl === getCurrentApiBaseUrl() &&
    isServedDomainBinding(input.filters.item_network, input.filters.item_domain)
  ) {
    return fetchLocalItems(input.filters, input.log);
  }

  return fetchRemotePage(input.instanceUrl, input.filters);
}

async function fetchRemoteCount(
  instanceUrl: string,
  filters: Omit<ItemFetchFilters, 'limit' | 'offset'>
) {
  const target = new URL('/api/v1/network/item/count_local', instanceUrl);
  const requestBody = JSON.stringify(filters);
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildPeerHeaders(target.pathname, requestBody),
    },
    body: requestBody,
    signal: AbortSignal.timeout(apiConfig.peer_fetch_timeout_ms),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch count from ${instanceUrl}: ${response.status} ${response.statusText}`
    );
  }

  const body = (await response.json()) as { count: number };
  return body.count;
}

async function fetchRemotePage(instanceUrl: string, filters: ItemFetchFilters) {
  const target = new URL('/api/v1/network/item/fetch_local', instanceUrl);
  const requestBody = JSON.stringify(filters);
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildPeerHeaders(target.pathname, requestBody),
    },
    body: requestBody,
    signal: AbortSignal.timeout(apiConfig.peer_fetch_timeout_ms),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch items from ${instanceUrl}: ${response.status} ${response.statusText}`
    );
  }

  return normalizeFetchItemsResponse(
    (await response.json()) as FetchItemsResponse
  );
}

async function fetchInstanceMarkers(input: {
  instanceUrl: string;
  filters: ItemFetchFilters;
  log?: ItemFetchLog;
}) {
  if (
    input.instanceUrl === getCurrentApiBaseUrl() &&
    isServedDomainBinding(input.filters.item_network, input.filters.item_domain)
  ) {
    return fetchLocalMarkers(input.filters, input.log);
  }

  return fetchRemoteMarkers(input.instanceUrl, input.filters);
}

async function fetchRemoteMarkers(instanceUrl: string, filters: ItemFetchFilters) {
  const target = new URL('/api/v1/network/item/markers_local', instanceUrl);
  // Adds a top-level `q`: the peer ignores `text_search` and resolves its own
  // non-private field allowlist. Without it the peer returns
  // every marker in the viewport.
  const requestBody = JSON.stringify({
    ...filters,
    ...(filters.text_search?.q ? { q: filters.text_search.q } : {}),
  });
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildPeerHeaders(target.pathname, requestBody),
    },
    body: requestBody,
    signal: AbortSignal.timeout(apiConfig.peer_fetch_timeout_ms),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch markers from ${instanceUrl}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as FetchMarkersResponse;
}

function buildCountCacheKey(
  filters: Omit<ItemFetchFilters, 'limit' | 'offset'>,
  instanceUrl: string
) {
  return [
    'item-count',
    filters.item_network,
    filters.item_domain,
    instanceUrl,
    stableStringify(filters),
  ].join(':');
}

// The cache key rounds lat/lng/radius to a grid whose cell scales with the
// radius, so near-identical viewports share an entry. Peers always receive the
// true, unrounded filters; only the key is bucketed. The served set may differ
// by up to half a radius step, the same tolerance the UI's own viewport
// bucketing accepts (apps/ui/src/hooks/use-map-markers.ts).
const RADIUS_BUCKET_STEP_METERS = 500;
const METERS_PER_DEG_LAT = 111_320;

function bucketGeoForCacheKey(filters: ItemFetchFilters): ItemFetchFilters {
  const { item_latitude, item_longitude, radius_meters } = filters;
  if (item_latitude === undefined || item_longitude === undefined) {
    return filters;
  }
  const radiusBucket =
    radius_meters !== undefined
      ? Math.round(radius_meters / RADIUS_BUCKET_STEP_METERS) *
        RADIUS_BUCKET_STEP_METERS
      : RADIUS_BUCKET_STEP_METERS;
  const cellMeters = Math.max(radiusBucket / 2, RADIUS_BUCKET_STEP_METERS);
  const latStepDeg = cellMeters / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((item_latitude * Math.PI) / 180) || 1;
  const lngStepDeg = cellMeters / (METERS_PER_DEG_LAT * cosLat);
  return {
    ...filters,
    item_latitude: Math.round(item_latitude / latStepDeg) * latStepDeg,
    item_longitude: Math.round(item_longitude / lngStepDeg) * lngStepDeg,
    ...(radius_meters !== undefined ? { radius_meters: radiusBucket } : {}),
  };
}

// Bbox counterpart of the radius bucketing: snap each corner to a grid sized
// as a fraction of the box span, floored at MIN_BBOX_BUCKET_STEP_DEG. Only the
// key is snapped; peers receive the true bbox.
const BBOX_BUCKET_FRACTION = 0.2;
const MIN_BBOX_BUCKET_STEP_DEG = 0.01; // ~1.1 km of latitude at the equator

function bucketBboxForCacheKey(filters: ItemFetchFilters): ItemFetchFilters {
  const { min_lat, min_lng, max_lat, max_lng } = filters;
  if (
    min_lat === undefined ||
    min_lng === undefined ||
    max_lat === undefined ||
    max_lng === undefined
  ) {
    return filters;
  }

  const latSpan = max_lat - min_lat;
  const lngSpan = max_lng - min_lng;
  if (latSpan <= 0 || lngSpan <= 0) {
    // Degenerate box: buildWhereClause already returns empty; key unbucketed.
    return filters;
  }

  const latStep = Math.max(latSpan * BBOX_BUCKET_FRACTION, MIN_BBOX_BUCKET_STEP_DEG);
  const lngStep = Math.max(lngSpan * BBOX_BUCKET_FRACTION, MIN_BBOX_BUCKET_STEP_DEG);

  return {
    ...filters,
    min_lat: Math.round(min_lat / latStep) * latStep,
    min_lng: Math.round(min_lng / lngStep) * lngStep,
    max_lat: Math.round(max_lat / latStep) * latStep,
    max_lng: Math.round(max_lng / lngStep) * lngStep,
  };
}

function buildPageCacheKey(filters: ItemFetchFilters, cacheTtlSeconds: number) {
  return [
    'item-page',
    filters.item_network,
    filters.item_domain,
    stableStringify({
      ...bucketBboxForCacheKey(bucketGeoForCacheKey(filters)),
      cacheTtlSeconds,
    }),
  ].join(':');
}

// Distinct prefix so the marker aggregate never collides with an item page.
function buildMarkerPageCacheKey(
  filters: ItemFetchFilters,
  cacheTtlSeconds: number
) {
  return [
    'marker-page',
    filters.item_network,
    filters.item_domain,
    stableStringify({
      ...bucketBboxForCacheKey(bucketGeoForCacheKey(filters)),
      cacheTtlSeconds,
    }),
  ].join(':');
}

function normalizeFetchItemsResponse(
  response: FetchItemsResponse
): FetchItemsResponse {
  return {
    ...response,
    items: response.items.map(normalizeFetchItemsResponseItem),
  };
}

function normalizeFetchItemsResponseItem(
  item: FetchItemsResponseItem
): FetchItemsResponseItem {
  return {
    ...item,
    created_at: normalizeDateValue(item.created_at),
    updated_at: normalizeDateValue(item.updated_at),
  };
}

function normalizeDateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
