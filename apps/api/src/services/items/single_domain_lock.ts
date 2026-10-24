import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@/services/db_types';

/**
 * The single-domain lock: an account holds profiles in exactly one domain, for
 * life, because the per-account PII tenancy key (`user.onboarded_by_org_id`)
 * must not span domains. Shared by every item create and
 * `POST /api/v1/user/domains` so the rule cannot drift.
 *
 * Design: docs/architecture/api-items-single-domain-lock.md
 */

/**
 * Record `domain` as the account's domain, only if it has none yet.
 *
 * `cardinality(domains) = 0` makes the claim write-once and race-safe without an
 * advisory lock (a concurrent caller re-evaluates the WHERE after the row lock).
 * `NOT EXISTS items` stops an account with an empty column but existing items
 * (not yet backfilled, legacy, or support-reset) from claiming a second domain.
 *
 * @returns whether this call recorded the domain. `false` means the account
 *   already has one, owns items, or does not exist; call
 *   {@link readLockedDomains} to find out which.
 */
export async function claimDomain(
  exec: DbOrTx,
  userId: string,
  domain: string,
): Promise<boolean> {
  const claimed = (await exec.execute(sql`
    UPDATE "user"
       SET domains = ARRAY[${domain}]::text[],
           updated_at = now()
     WHERE id = ${userId}
       AND (domains IS NULL OR cardinality(domains) = 0)
       AND NOT EXISTS (SELECT 1 FROM items WHERE created_by = ${userId})
    RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };

  return (claimed.rows ?? []).length > 0;
}

/**
 * The domains an account is locked to: `user.domains`, else the domains of the
 * items it owns (the source of truth; the column is a cache). The fallback runs
 * only when the column is empty.
 *
 * Callers must treat an empty result as "this account does not exist", never
 * as "allow anything".
 *
 * @returns more than one entry only for a legacy account that held items in
 *   two domains before the lock existed; callers honour all of them.
 */
export async function readLockedDomains(exec: DbOrTx, userId: string): Promise<string[]> {
  const fromColumn = (await exec.execute(sql`
    SELECT domains FROM "user" WHERE id = ${userId} LIMIT 1
  `)) as unknown as { rows?: Array<{ domains: string[] | null }> };

  const declared = fromColumn.rows?.[0]?.domains ?? [];
  if (declared.length > 0) return declared;

  const fromItems = (await exec.execute(sql`
    SELECT DISTINCT item_domain FROM items WHERE created_by = ${userId}
  `)) as unknown as { rows?: Array<{ item_domain: string }> };

  return (fromItems.rows ?? []).map((r) => r.item_domain);
}

/** The `DOMAIN_LOCKED` copy, so the create path and the route cannot drift. */
export const domainLockedMessage = (locked: string, requested: string, verb: string): string =>
  `You are registered as "${locked}" and cannot ${verb} "${requested}".`;
