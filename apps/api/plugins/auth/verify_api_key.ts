/**
 * In-process `x-api-key` verification.
 *
 * The `apikey` table is a cross-repo contract: this file, signals-search's
 * `src/api/auth.ts` (direct SQL) and the automation's
 * `provision_service_users.sql` (raw Postgres `digest()`) must agree on the
 * hash, `base64url(sha256(raw_key))` unpadded. Changing it forces every partner
 * to rotate keys.
 *
 * Not implemented on purpose:
 *
 * - Per-key rate limiting: `provision_service_users.sql` seeds
 *   `rate_limit_enabled = false` for every service key.
 * - Decrementing `remaining`: it is read, never written, as in signals-search,
 *   so two services never race on a counter neither owns. Seeded keys carry
 *   `remaining = NULL` (unlimited); it only matters for a key manually given a
 *   quota.
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/postgres/drizzle_config';
import { apikey as apikeyTable } from '../../db/postgres/schema/auth';

/**
 * `base64url(sha256(raw))`, unpadded. Node's `'base64url'` digest is already
 * unpadded with the `-_` alphabet.
 */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

export type ApiKeyVerification =
  | { valid: true; userId: string | null }
  | { valid: false };

/**
 * Resolves a raw `x-api-key` to its owning user id.
 *
 * Returns a flat `valid` verdict rather than throwing: the middleware's
 * contract is `403 INVALID_API_KEY` for every rejection reason, and collapsing
 * them here keeps the caller from leaking *why* a key failed (disabled vs
 * expired vs unknown) to an unauthenticated caller.
 */
export async function verifyApiKey(
  rawKey: string,
  executor: Pick<typeof db, 'select'> = db
): Promise<ApiKeyVerification> {
  const hashed = hashApiKey(rawKey);

  const [row] = await executor
    .select({
      userId: apikeyTable.userId,
      referenceId: apikeyTable.referenceId,
      remaining: apikeyTable.remaining,
      expiresAt: apikeyTable.expiresAt,
    })
    .from(apikeyTable)
    // `enabled` is filtered in SQL rather than in JS so a disabled key is
    // indistinguishable from an unknown one at every layer, including timing.
    .where(and(eq(apikeyTable.key, hashed), eq(apikeyTable.enabled, true)))
    .limit(1);

  if (!row) return { valid: false };

  // NULL expiry means "never expires" — the shape every seeded service key has.
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { valid: false };
  }

  // NULL remaining means "unlimited". Only a non-null, exhausted quota fails.
  if (row.remaining !== null && row.remaining <= 0) {
    return { valid: false };
  }

  return { valid: true, userId: row.userId ?? row.referenceId ?? null };
}
