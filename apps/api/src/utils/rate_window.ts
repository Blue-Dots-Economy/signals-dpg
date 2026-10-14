import { redis } from '@api/db/secondary/redis';

/**
 * Fixed-window counter: increment `key`, set the window TTL on the first hit,
 * return the running count. The caller decides the max and what to do when it
 * is exceeded.
 *
 * Extracted from `services/guardian_otp.ts` when the support route needed the
 * same primitive (#551) — it is the only rate-limit shape this API uses.
 */
export async function incrWithinWindow(key: string, windowSec: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count;
}

/**
 * Gives back one hit of `key` — for a request that was counted up front but
 * turned out not to use what the limit protects (e.g. an export refused
 * before any data was read). Never takes the counter below zero.
 */
export async function refundWithinWindow(key: string): Promise<void> {
  const count = await redis.decr(key);
  if (count < 0) await redis.set(key, 0, 'KEEPTTL');
}
