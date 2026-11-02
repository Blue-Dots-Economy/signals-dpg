import { redis } from '@api/db/secondary/redis';

/**
 * Sweeps the item read caches for one (network, domain) after a mutation:
 * `local-item-fetch:*` (1 s TTL, item_fetch_cache.ts) and `item-count:*` /
 * `item-page:*` (network-config TTL, inter_instance_fetch.ts). The
 * inter-instance entries are the long-lived ones a user would notice.
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
      // UNLINK (non-blocking) where available, else DEL.
      pending.push(redis.unlink(...keys).catch(() => redis.del(...keys)));
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  await Promise.all(pending);
}
