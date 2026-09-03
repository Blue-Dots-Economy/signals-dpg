import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { user } from '@api/db/postgres/schema/auth';
import type { DbOrTx } from '@/services/db_types';
import { resolveServedNetworkForDomain } from '@/utils/served_domain_guard';

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
 * ## Defaults are per binding
 *
 * `organization.default_for_bindings` is per (network, domain) — product asked
 * for a per-domain default (#640 Q3) — so a seeker aggregator and a provider
 * aggregator coexist, each owning its own self-signup population.
 *
 * That is sound even though the tag itself (`user.onboarded_by_org_id`) is per
 * ACCOUNT, because a user holds exactly one domain: the single-role lock in
 * `create_item.ts` keeps `user.domains` at one entry and never grows it. Each
 * account therefore belongs to one binding, and "which org owns this person"
 * has one answer.
 *
 * Two orgs claiming the SAME binding would break that, and is prevented by the
 * `organization_default_binding_exclusive` trigger (migration 0014).
 *
 * Residual edge: the admin api-key paths bypass the single-role lock, so a user
 * could be given profiles in two domains. That account keeps the owner from
 * whichever profile came first. Not reachable from self-signup, and fixed
 * properly by the per-profile `profile_origin` work in
 * `docs/superpowers/specs/2026-08-30-account-profile-identity-model-design.md`.
 */

export interface DefaultAggregatorResolution {
  /** The default aggregator, or null when none is nominated. */
  org_id: string | null;
}

/** Canonical served-domain binding key, same shape as `binding.key` in `served_domain_guard.ts`. */
export const bindingKey = (network: string, domain: string): string => `${network}/${domain}`;

/**
 * THE lookup for a binding's default aggregator.
 *
 * `LIMIT 1` is safe because `organization_default_binding_exclusive` guarantees
 * at most one org holds any given binding.
 */
export const defaultAggregatorQuery = (binding: string): SQL =>
  sql`SELECT id FROM organization
       WHERE default_for_bindings && ARRAY[${binding}]::text[]
         AND type = 'aggregator'
       LIMIT 1`;

/**
 * The default aggregator for a served-domain binding.
 *
 * Not cached. It runs at most once per user, inside a transaction that is
 * already writing an item — and the value is changed by an operator, so a cache
 * would introduce a stale window with nothing to invalidate it.
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
  network: string,
  domain: string,
): Promise<{ resolution: DefaultAggregatorResolution; tagged: boolean }> {
  const resolution = await resolveDefaultAggregator(exec, network, domain);
  if (!resolution.org_id) return { resolution, tagged: false };

  const updated = await exec
    .update(user)
    .set({
      onboardedByOrgId: resolution.org_id,
      onboardedByDefault: true,
      // The tagging basis the last AC on #640 asks for. `onboarded_via` has
      // exactly one other writer — `participant.ts`, from the request's
      // `channel` — which the portal self-signup path never reaches, so
      // without this those users carry NULL and show up as an unattributed
      // bucket in the aggregator dashboard's GROUP BY onboarded_via.
      //
      // `coalesce`, not an overwrite: an untagged user may already have a via.
      // A cold-voice onboard made before any default was nominated has
      // via='voice' with a null org; when a default is nominated later and
      // this fires, relabelling them 'self' would make the basis a lie.
      onboardedVia: sql`coalesce(${user.onboardedVia}, 'self')`,
      onboardedAt: sql`coalesce(${user.onboardedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(user.id, userId), isNull(user.onboardedByOrgId)))
    .returning({ id: user.id });

  return { resolution, tagged: updated.length > 0 };
}

export interface OwnerGateContext {
  has_owner: boolean;
  /** Whether a default aggregator is nominated for this binding. */
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
  network: string,
  domain: string,
  known?: DefaultAggregatorResolution,
): Promise<OwnerGateContext> {
  const [owner] = await exec
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, ownerUserId))
    .limit(1);

  const resolution = known ?? (await resolveDefaultAggregator(exec, network, domain));

  return {
    // A missing user row counts as "no owner" — fail closed. It should not
    // happen (items FK to `user`), and treating it as owned would be the
    // wrong direction on a gate that exists to guarantee an owner.
    has_owner: Boolean(owner?.onboardedByOrgId),
    default_configured: Boolean(resolution.org_id),
  };
}

/**
 * Tag a user from the default aggregator for the domain they just joined.
 *
 * THE user-level entry point (#640). Called wherever `user.domains` is first
 * established — the three places that decide which domain a user belongs to:
 *
 *   1. `applySignupExtras` (provisioning) — portal signup, from the stash
 *   2. `POST /api/v1/user/domains`        — explicit pick
 *   3. `create_item`'s first-create bootstrap
 *
 * Tagging belongs here rather than on every item write: ownership is a property
 * of the ACCOUNT, decided once when its domain is decided. Running it per item
 * write meant re-resolving the default on edits by users who were already
 * owned, which is work whose result is always discarded.
 *
 * Derives the network from the instance's served bindings, since `user.domains`
 * stores a bare domain. A domain that is unserved or ambiguous leaves the user
 * untagged (see `resolveServedNetworkForDomain`).
 *
 * @returns the org id written, or null when nothing was written.
 */
export async function tagUserForDomain(
  exec: DbOrTx,
  userId: string,
  domain: string,
): Promise<string | null> {
  const network = resolveServedNetworkForDomain(domain);
  if (!network) return null;

  const { resolution, tagged } = await tagUserWithDefaultAggregator(
    exec,
    userId,
    network,
    domain,
  );
  return tagged ? resolution.org_id : null;
}
