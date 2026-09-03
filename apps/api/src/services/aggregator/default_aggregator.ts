import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { user } from '@api/db/postgres/schema/auth';
import type { DbOrTx } from '@/services/db_types';

/**
 * Default-aggregator resolution (#640, SS-3).
 *
 * A user arriving through an uncontrolled inbound path — portal self-signup, or
 * a cold call to the network-hosted voice agent — has no aggregator of their
 * own. `user.onboarded_by_org_id` is the tenancy key for participant reads,
 * action authorisation and **PII decryption**, so leaving it null means nobody
 * is responsible for verifying that person and nobody can decrypt them.
 *
 * The default aggregator is a real, already-approved aggregator org that the
 * network admin nominates through `POST /api/v1/admin/aggregator/default`. It
 * is deliberately never system-generated: an org minted by the system has no
 * enabled Keycloak user, so the "unverified queue" it owns would be a queue
 * nobody can open.
 *
 * ## One default per instance, enforced by the database
 *
 * `organization.default_for_bindings` records which (network, domain) bindings
 * an org is the default for — product asked for a per-domain default (#640 Q3).
 * But the tag it drives, `user.onboarded_by_org_id`, is **per account** and
 * write-once, and `participant_decrypt` scopes on it with no domain condition.
 * So "which org owns this person" must have exactly one answer; with two
 * default orgs there is no sound answer, only a guess that would let one
 * decrypt the other's participants.
 *
 * Rather than detect that at runtime, `organization_single_default_idx` makes
 * it impossible: a unique index over rows holding a binding, so a second
 * default fails with 23505 at write time. Resolution is therefore binary — a
 * default exists, or it does not — and the go-live gate needs no third case.
 *
 * Per-binding ownership is the per-profile `profile_origin` work in
 * `docs/superpowers/specs/2026-08-30-account-profile-identity-model-design.md`:
 * until attribution moves to the profile-creation event, an account-level tag
 * cannot express it.
 */

export interface DefaultAggregatorResolution {
  /** The default aggregator, or null when none is nominated. */
  org_id: string | null;
}

/**
 * THE lookup for the instance's default aggregator.
 *
 * Not filtered by binding: ownership is account-level, so this asks "which org
 * is the default?" — a question the unique index guarantees has at most one
 * answer.
 */
export const defaultAggregatorQuery = (): SQL =>
  sql`SELECT id FROM organization
       WHERE default_for_bindings IS NOT NULL
         AND type = 'aggregator'
       LIMIT 1`;

/**
 * The instance's default aggregator.
 *
 * Not cached. It runs at most once per user, inside a transaction that is
 * already writing an item — and the value is changed by an operator, so a cache
 * would introduce a stale window with nothing to invalidate it.
 */
export async function resolveDefaultAggregator(
  exec: DbOrTx,
): Promise<DefaultAggregatorResolution> {
  const result = (await exec.execute(defaultAggregatorQuery())) as unknown as {
    rows?: Array<{ id: string }>;
  };

  return { org_id: result.rows?.[0]?.id ?? null };
}

/**
 * Fill `user.onboarded_by_org_id` from the default aggregator, but only if it
 * is still unset.
 *
 * `IS NULL` in the WHERE makes the write **write-once at the database level**:
 * a later profile create or edit can never re-point an existing tag, so moving
 * someone between aggregators stays an explicit, audited operation rather than
 * something that can happen by accident.
 *
 * `onboarded_by_default` is what marks these users as *defaulted* rather than
 * genuinely onboarded. It is a server-only column on purpose — `onboarded_via`
 * is written from the request's `channel` field, so a caller could set it, and
 * this flag is the key the re-assignment job scopes on.
 *
 * `onboarded_at` is filled with `coalesce` so a participant who was onboarded
 * months ago (voice/account-only creates already write a real `onboarded_at`
 * with a null org) does not have their genuine join date overwritten with the
 * tagging time — `item_metrics.age_days` and `profile_status` are derived from
 * it, and a dormant participant must not resurface as brand new.
 *
 * @returns the resolution, plus whether this call actually wrote the tag and
 *   whether the user ends up owned. Callers use this to build the go-live gate
 *   context without a second round trip.
 */
export async function tagUserWithDefaultAggregator(
  exec: DbOrTx,
  userId: string,
): Promise<{ resolution: DefaultAggregatorResolution; tagged: boolean }> {
  const resolution = await resolveDefaultAggregator(exec);
  if (!resolution.org_id) return { resolution, tagged: false };

  const updated = await exec
    .update(user)
    .set({
      onboardedByOrgId: resolution.org_id,
      onboardedByDefault: true,
      onboardedAt: sql`coalesce(${user.onboardedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(user.id, userId), isNull(user.onboardedByOrgId)))
    .returning({ id: user.id });

  return { resolution, tagged: updated.length > 0 };
}

export interface OwnerGateContext {
  has_owner: boolean;
  /** Whether a default aggregator is nominated at all. */
  default_configured: boolean;
}

/**
 * The two signals the `owner_required` go-live gate needs: whether the profile
 * owner has an owning aggregator, and what state the instance's default is in.
 *
 * Pass `known` when the caller has already resolved the default (every path
 * that tags does), so a gated write costs one `organization` read, not two.
 */
export async function resolveOwnerGateContext(
  exec: DbOrTx,
  ownerUserId: string,
  known?: DefaultAggregatorResolution,
): Promise<OwnerGateContext> {
  const [owner] = await exec
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, ownerUserId))
    .limit(1);

  const resolution = known ?? (await resolveDefaultAggregator(exec));

  return {
    // A missing user row counts as "no owner" — fail closed. It should not
    // happen (items FK to `user`), and treating it as owned would be the
    // wrong direction on a gate that exists to guarantee an owner.
    has_owner: Boolean(owner?.onboardedByOrgId),
    default_configured: Boolean(resolution.org_id),
  };
}
