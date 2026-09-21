/**
 * Native `x-api-key` verification — the in-process replacement for
 * better-auth's `authInstance.api.verifyApiKey` (#517).
 *
 * **The `apikey` table is a cross-repo contract, not a better-auth artifact.**
 * Three independent implementations agree on the same hash today:
 *
 *   1. this file,
 *   2. signals-search's `src/api/auth.ts` (direct SQL, another repo — #516),
 *   3. the automation's `provision_service_users.sql`, which seeds rows with a
 *      raw Postgres `digest()` and never loads better-auth at all.
 *
 * That is why the library can go while the table stays: (3) already proves the
 * hash is derivable without better-auth. The scheme is
 * `base64url(sha256(raw_key))` — unpadded, `+/` → `-_` — matching
 * `@better-auth/api-key`'s `defaultKeyHasher` byte for byte, so **no partner
 * has to rotate a key** across this change.
 *
 * Deliberately NOT ported from the plugin:
 *
 * - **Rate limiting.** The plugin's 10 000/hr ceiling was per-key and gated on
 *   `apikey.rate_limit_enabled`, which `provision_service_users.sql` seeds
 *   `false` for every service key. It was already inert for every key that
 *   exists, so porting it would add a limiter that has never once engaged.
 *   Instance-wide limits are #669's territory.
 * - **`remaining` decrementing.** Checked here, never written — same stance
 *   signals-search takes, and for the same reason: two writers racing on a
 *   counter neither of them owns. Seeded keys carry `remaining = NULL`
 *   (unlimited), so the column gates nothing today; it is read only so that a
 *   key manually given a quota still runs out.
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/postgres/drizzle_config';
import { apikey as apikeyTable } from '../../db/postgres/schema/auth';

/**
 * `base64url(sha256(raw))`, unpadded — `@better-auth/api-key`'s
 * `defaultKeyHasher`. Node's `'base64url'` digest encoding is already unpadded
 * and uses the `-_` alphabet, so it needs no post-processing.
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
