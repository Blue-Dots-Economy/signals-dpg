import type { FastifyBaseLogger } from 'fastify';
import {
  getDomainMinimumCacheTtlSeconds,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import { redis } from '@api/db/secondary/redis';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { buildPeerHeaders } from '@/utils/instance_token';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import {
  countLocalItems,
  fetchLocalItems,
  fetchLocalMarkers,
  type ItemFetchFilters,
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
 * §4.4 scatter-gather top-K cross-instance merge. Only used when a domain has
 * >1 active (count > 0) instance — with exactly one active instance, a
 * direct `[offset, limit)` slice from that instance is already globally
 * ordered, so callers keep that frozen single-instance path instead.
 *
 * Fans out to every active instance for its own top rows `[0, offset+limit)`
 * (each peer is already locally ordered nearest-first / newest-first — see
 * `buildDistanceOrderBy` in `item_fetch_runtime.ts`), then merges the union
 * on this instance via `mergeSortAndSlice` and slices the requested page.
 * `Promise.allSettled` so one slow/failed peer degrades to a partial
 * aggregate instead of failing the whole page. Shared by
 * `fetchItemsAcrossInstances` and (Task 3) `fetchMarkersAcrossInstances` —
 * only `fetchPage`'s projection (full item vs. slim marker) differs.
 *
 * `peerLimitMax` clamps the per-peer top-K request to whatever limit cap the
 * peer route itself enforces (e.g. `FetchItemsBodySchema` caps `limit` at
 * 1000; `MarkersBodySchema` at 10000) — every remote peer validates its
 * request body against that schema, so asking for more than the cap fails
 * Zod validation on every remote peer and turns a healthy deep page into a
 * spurious partial. When `offset + limit > peerLimitMax`, cross-instance
 * ordering is only approximate for that page — each peer contributes at most
 * its top `peerLimitMax` rows instead of its true top `offset + limit` — but
 * this is an accepted limitation bounded by the peer route's own cap; it
 * trades a rare deep-page ordering approximation for avoiding the spurious
 * partial. (The list's own base limit is ≤1000 and deep multi-instance
 * paging past the cap is a rare edge.)
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
  const { offset, limit, item_latitude, item_longitude } = input.filters;

  // Every active instance is asked for its own top `offset + limit` rows —
  // the requesting instance can't know in advance how many of any peer's
  // rows land in the final page, so it over-fetches from each and lets the
  // merge below pick the true global top page. Clamped to `peerLimitMax` so
  // the per-peer request never exceeds what the peer route's own schema
  // accepts (see doc comment above).
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

  const rows = mergeSortAndSlice(union, { center, offset, limit });

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
    // Only complete aggregates are ever cached, so a cache hit is by
    // definition complete. Legacy entries predate the partial fields; default
    // them so the response shape is stable.
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

  // Scatter-gather only kicks in with >1 active (count > 0) instance: with
  // exactly one, its direct [offset, limit) slice is already globally
  // ordered, so that path is frozen byte-identical to pre-§4.4 behavior
  // (same buildPagePlan call, same cache keys, same partial semantics).
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
        // FetchItemsBodySchema (packages/schemas/src/api/item_schemas.ts) caps
        // limit at 1000 — every remote peer validates its fetch_local body
        // against that schema, so the per-peer top-K request must never ask
        // for more.
        peerLimitMax: 1000,
        fetchPage: async ({ instanceUrl, filters }) =>
          (await fetchInstancePage({ instanceUrl, filters })).items,
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
 * §4.3 slim viewport aggregate: mirrors fetchItemsAcrossInstances (count-first
 * discovery via the shared getInstanceCount/buildPagePlan, then a page fetch
 * fan-out) but returns the slim marker projection instead of full items, and
 * caches under a distinct `marker-page:*` key so the two aggregates never
 * collide or serve each other's shape.
 *
 * Note (P5): fetchItemsAcrossInstances and fetchMarkersAcrossInstances share
 * this structure almost verbatim, differing only in the page-fetch call and
 * cache-key prefix. P5's scatter-gather rework is expected to unify both into
 * one generic aggregator parameterized by projection; left duplicated here
 * deliberately per the task 2 brief (do not refactor the item-fetch path).
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
    // Only complete aggregates are ever cached, so a cache hit is by
    // definition complete. Legacy entries predate the partial fields; default
    // them so the response shape is stable.
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

  const partial = unavailableInstances.size > 0;

  const mergedResponse = {
    meta: {
      total,
      limit: input.filters.limit,
      offset: input.filters.offset,
      partial,
      unavailable_instances: [...unavailableInstances],
    },
    markers: responses.flatMap((response) => response.markers),
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
    item_latitude: input.filters.item_latitude,
    item_longitude: input.filters.item_longitude,
    radius_meters: input.filters.radius_meters,
    lifecycle_filter: input.filters.lifecycle_filter,
  };

  const count =
    input.instanceUrl === getCurrentApiBaseUrl() &&
    isServedDomainBinding(input.filters.item_network, input.filters.item_domain)
      ? await countLocalItems(countFilters)
      : await fetchRemoteCount(input.instanceUrl, countFilters);

  await redis.set(countCacheKey, String(count), 'EX', input.cacheTtlSeconds);

  return count;
}

async function fetchInstancePage(input: {
  instanceUrl: string;
  filters: ItemFetchFilters;
}) {
  if (
    input.instanceUrl === getCurrentApiBaseUrl() &&
    isServedDomainBinding(input.filters.item_network, input.filters.item_domain)
  ) {
    return fetchLocalItems(input.filters);
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
}) {
  if (
    input.instanceUrl === getCurrentApiBaseUrl() &&
    isServedDomainBinding(input.filters.item_network, input.filters.item_domain)
  ) {
    return fetchLocalMarkers(input.filters);
  }

  return fetchRemoteMarkers(input.instanceUrl, input.filters);
}

async function fetchRemoteMarkers(instanceUrl: string, filters: ItemFetchFilters) {
  const target = new URL('/api/v1/network/item/markers_local', instanceUrl);
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

function buildPageCacheKey(filters: ItemFetchFilters, cacheTtlSeconds: number) {
  return [
    'item-page',
    filters.item_network,
    filters.item_domain,
    stableStringify({
      ...filters,
      cacheTtlSeconds,
    }),
  ].join(':');
}

// Distinct prefix from buildPageCacheKey so the slim marker aggregate never
// collides with (or is confused for) a full-item page cache entry.
function buildMarkerPageCacheKey(
  filters: ItemFetchFilters,
  cacheTtlSeconds: number
) {
  return [
    'marker-page',
    filters.item_network,
    filters.item_domain,
    stableStringify({
      ...filters,
      cacheTtlSeconds,
    }),
  ].join(':');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
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
