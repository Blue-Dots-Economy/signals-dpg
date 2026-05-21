import { redis } from '@api/db/secondary/redis';

/**
 * Cache-invalidation companion for the item read paths.
 *
 * Two caches sit in front of the items table:
 *   - `local-item-fetch:*`  → 1 s TTL, set by item_fetch_cache.ts
 *   - `item-count:*` / `item-page:*` → minimum_cache_ttl_seconds from the
 *      network config (defaults to 300 s for blue_dot/seeker), set by
 *      inter_instance_fetch.ts
 *
 * The longer-lived inter-instance caches are the ones operators notice
 * after a create / update / delete — the local cache is sub-second and
 * effectively self-heals. After any item mutation we sweep both cache
 * families for the affected (network, domain) so the next read sees
 * fresh data.
 */
export async function invalidateItemFetchCache(
  network: string,
  domain: string,
): Promise<void> {
  const patterns = [
    `local-item-fetch:*${network}*${domain}*`,
    `item-count:${network}:${domain}:*`,
    `item-page:${network}:${domain}:*`,
  ];
  await Promise.all(patterns.map(deleteByPattern));
}

async function deleteByPattern(pattern: string): Promise<void> {
  // SCAN keeps Redis responsive on large keyspaces; KEYS would block.
  const stream = redis.scanStream({ match: pattern, count: 200 });
  const pending: Promise<unknown>[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      if (keys.length === 0) return;
      // UNLINK if available (non-blocking delete in newer Redis), else DEL.
      pending.push(redis.unlink(...keys).catch(() => redis.del(...keys)));
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  await Promise.all(pending);
}
