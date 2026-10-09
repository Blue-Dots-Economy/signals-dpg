import { redis } from '@api/db/secondary/redis';
import { sha256Hex } from '@/utils/secure_crypto';

/**
 * Short-lived Redis values keyed by a secret identifier (an OIDC `state`, an
 * SSO handle, a one-time code).
 *
 * The identifier is itself a credential, so it never becomes a Redis key in
 * the clear: the key is `prefix + sha256(id)`. Anyone with read access to
 * Redis (a `KEYS` dump, a monitoring tool) then learns nothing they could
 * replay.
 */

function keyFor(prefix: string, id: string): string {
  return prefix + sha256Hex(id);
}

/** Store `value` as JSON for `ttlSeconds`. */
export async function putValue(
  prefix: string,
  id: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  await redis.set(keyFor(prefix, id), JSON.stringify(value), 'EX', ttlSeconds);
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Read without consuming. */
export async function peekValue<T>(prefix: string, id: string): Promise<T | null> {
  return parse<T>(await redis.get(keyFor(prefix, id)));
}

/** Read and delete in one step: the value is good for exactly one reader. */
export async function takeValue<T>(prefix: string, id: string): Promise<T | null> {
  return parse<T>(await redis.getdel(keyFor(prefix, id)));
}

/**
 * Record `id` as used for `ttlSeconds`. Returns true the first time and false
 * on every repeat within the window (SET NX) — a replay guard.
 */
export async function claimOnce(
  prefix: string,
  id: string,
  ttlSeconds: number
): Promise<boolean> {
  const result = await redis.set(keyFor(prefix, id), '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}
