import { redis } from '@api/db/secondary/redis';
import type { ItemFetchFilters } from '@/utils/item_fetch_runtime';
import { stableStringify } from './stable_stringify';

const LOCAL_ITEM_FETCH_CACHE_TTL_SECONDS = 1;

export async function getCachedLocalItemFetch<T>(
  filters: ItemFetchFilters,
  loader: () => Promise<T>
) {
  const cacheKey = buildLocalItemFetchCacheKey(filters);
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached) as T;
  }

  const result = await loader();
  await redis.set(
    cacheKey,
    JSON.stringify(result),
    'EX',
    LOCAL_ITEM_FETCH_CACHE_TTL_SECONDS
  );

  return result;
}

function buildLocalItemFetchCacheKey(filters: ItemFetchFilters) {
  return ['local-item-fetch', stableStringify(filters)].join(':');
}
