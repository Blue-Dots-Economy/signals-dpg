import {
  getDomainMinimumCacheTtlSeconds,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import { redis } from '@api/db/secondary/redis';
import { getCurrentApiBaseUrl } from '@/config';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import {
  countLocalItems,
  fetchLocalItems,
  type ItemFetchFilters,
} from '@/utils/item_fetch_runtime';

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

export async function fetchItemsAcrossInstances(input: {
  networkConfig: NetworkConfigDocument;
  filters: ItemFetchFilters;
  requestedCacheTtlSeconds?: number;
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
    return normalizeFetchItemsResponse(
      JSON.parse(cachedPage) as FetchItemsResponse
    );
  }

  const domainInstances = input.networkConfig.instances.filter(
    (instance) => instance.domain_id === input.filters.item_domain
  );

  const counts = await Promise.all(
    domainInstances.map(async (instance) => ({
      instanceUrl: instance.instance_url,
      count: await getInstanceCount({
        instanceUrl: instance.instance_url,
        filters: input.filters,
        cacheTtlSeconds,
      }),
    }))
  );

  const total = counts.reduce(
    (sum: number, entry: InstanceCount) => sum + entry.count,
    0
  );
  const slices = buildPagePlan(counts, input.filters.offset, input.filters.limit);
  const responses = await Promise.all(
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

  const mergedResponse = {
    meta: {
      total,
      limit: input.filters.limit,
      offset: input.filters.offset,
    },
    items: responses.flatMap((response) => response.items),
  };

  await redis.set(
    pageCacheKey,
    JSON.stringify(mergedResponse),
    'EX',
    cacheTtlSeconds
  );

  return mergedResponse;
}

async function getInstanceCount(input: {
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
  const response = await fetch(
    new URL('/api/v1/network/item/count_local', instanceUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(filters),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch count from ${instanceUrl}: ${response.status} ${response.statusText}`
    );
  }

  const body = (await response.json()) as { count: number };
  return body.count;
}

async function fetchRemotePage(instanceUrl: string, filters: ItemFetchFilters) {
  const response = await fetch(
    new URL('/api/v1/network/item/fetch_local', instanceUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(filters),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch items from ${instanceUrl}: ${response.status} ${response.statusText}`
    );
  }

  return normalizeFetchItemsResponse(
    (await response.json()) as FetchItemsResponse
  );
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
