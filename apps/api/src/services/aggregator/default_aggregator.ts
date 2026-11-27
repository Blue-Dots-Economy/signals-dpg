import { eq, sql, type SQL } from 'drizzle-orm';
import { user } from '@api/db/postgres/schema/auth';
import type { DbOrTx } from '@/services/db_types';
import { resolveServedNetworkForDomain } from '@/utils/served_domain_guard';

/**
 * Default-aggregator resolution and tagging. A user arriving through an
 * uncontrolled path (portal self-signup, a cold voice call) is tagged with the
 * aggregator an operator nominated for their (network, domain) binding, so
 * someone owns, verifies and can decrypt them.
 *
 * Design: docs/architecture/api-aggregator-default-aggregator.md
 */

export interface DefaultAggregatorResolution {
  /** The default aggregator, or null when none is nominated. */
  org_id: string | null;
}

/** Canonical served-domain binding key, same shape as `binding.key` in `served_domain_guard.ts`. */
export const bindingKey = (network: string, domain: string): string => `${network}/${domain}`;

/**
 * The lookup for a binding's default aggregator. `LIMIT 1` is safe because `organization_default_binding_exclusive` guarantees
 * at most one org holds any given binding.
 */
export const defaultAggregatorQuery = (binding: string): SQL =>
  sql`SELECT id FROM organization
       WHERE default_for_bindings && ARRAY[${binding}]::text[]
         AND type = 'aggregator'
       LIMIT 1`;

/**
 * The default aggregator for a served-domain binding. Not cached: an operator
 * changes the value by hand, so a cache would have nothing to invalidate it.
 */
export async function resolveDefaultAggregator(
  exec: DbOrTx,
  network: string,
  domain: string,
): Promise<DefaultAggregatorResolution> {
  const result = (await exec.execute(
    defaultAggregatorQuery(bindingKey(network, domain)),
  )) as unknown as { rows?: Array<{ id: string }> };

  return { org_id: result.rows?.[0]?.id ?? null };
}

/**
 * Fill `user.onboarded_by_org_id` from the default aggregator, only if unset.
 *
 * `IS NULL` makes the tag write-once at the database level, so moving someone
 * between aggregators stays an explicit operation.
 *
 * `onboarded_by_default` marks the user as defaulted rather than genuinely
 * onboarded. It is server-only because `onboarded_via` comes from the request's
 * `channel` and so is caller-controlled.
 *
 * `onboarded_at` uses `coalesce` so an earlier real join date (voice or
 * account-only creates write one with a null org) is kept: `item_metrics.age_days`
 * and `profile_status` derive from it.
 *
 * @returns whether this call actually wrote the tag.
 */
export async function tagUserWithDefaultAggregator(
  exec: DbOrTx,
  userId: string,
  network: string,
  domain: string,
): Promise<{ tagged: boolean }> {
  const binding = bindingKey(network, domain);

  // For an already-owned user the WHERE fails before the subqueries run, so
  // this is cheap enough for every profile create. The EXISTS avoids writing
  // NULL over NULL (a wasted row version) when no default is nominated.
  const updated = (await exec.execute(sql`
    UPDATE "user"
       SET onboarded_by_org_id = (
             SELECT id FROM organization
              WHERE default_for_bindings && ARRAY[${binding}]::text[]
                AND type = 'aggregator'
              LIMIT 1),
           onboarded_by_default = true,
           onboarded_via = coalesce(onboarded_via, 'self'),
           onboarded_at  = coalesce(onboarded_at, now()),
           updated_at    = now()
     WHERE id = ${userId}
       AND onboarded_by_org_id IS NULL
       AND EXISTS (
             SELECT 1 FROM organization
              WHERE default_for_bindings && ARRAY[${binding}]::text[]
                AND type = 'aggregator')
    RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };

  return { tagged: (updated.rows ?? []).length > 0 };
}

export interface OwnerGateContext {
  has_owner: boolean;
  /** Whether a default aggregator is nominated for this binding. */
  default_configured: boolean;
}

/**
 * The two signals the `owner_required` go-live gate needs: whether the profile
 * owner has an owning aggregator, and whether a default is nominated for this
 * binding at all.
 */
export async function resolveOwnerGateContext(
  exec: DbOrTx,
  ownerUserId: string,
  network: string,
  domain: string,
): Promise<OwnerGateContext> {
  const [owner] = await exec
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, ownerUserId))
    .limit(1);

  const resolution = await resolveDefaultAggregator(exec, network, domain);

  return {
    // A missing user row counts as "no owner" (fail closed).
    has_owner: Boolean(owner?.onboardedByOrgId),
    default_configured: Boolean(resolution.org_id),
  };
}

/**
 * Tag a user from the default aggregator for the domain they just joined.
 * Called where `user.domains` is established: `applySignupExtras`
 * (provisioning) and `POST /api/v1/user/domains`. `create_item` calls
 * `tagUserWithDefaultAggregator` directly with the request's concrete network.
 *
 * Derives the network from the instance's served bindings because
 * `user.domains` stores a bare domain; an unserved or ambiguous domain leaves
 * the user untagged (see `resolveServedNetworkForDomain`).
 *
 * @returns whether the tag was written.
 */
export async function tagUserForDomain(
  exec: DbOrTx,
  userId: string,
  domain: string,
): Promise<boolean> {
  const network = resolveServedNetworkForDomain(domain);
  if (!network) return false;

  const { tagged } = await tagUserWithDefaultAggregator(exec, userId, network, domain);
  return tagged;
}
