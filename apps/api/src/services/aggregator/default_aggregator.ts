import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { organization, user } from '@api/db/postgres/schema/auth';

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
 * Until one is nominated there is simply no default, and inbound users stay
 * untagged. That is the expected state at launch (#640 Q1) and is not an error.
 */

// Local rather than imported from item_service: that module imports the
// go-live classifier, which needs this one for the `owner_required` gate.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

/** Canonical served-domain binding key, matching `binding.key` in `served_domain_guard.ts`. */
export const bindingKey = (network: string, domain: string): string => `${network}/${domain}`;

export interface DefaultAggregatorResolution {
  /** The default aggregator's org id, or null when there is none to use. */
  org_id: string | null;
  /**
   * Whether a usable default is configured for this binding. Drives guard 1 of
   * the `owner_required` go-live gate: while no default exists the gate must be
   * inert, or every self-signup profile would be frozen in `draft` from launch
   * until an aggregator is nominated (#640 Q1 vs Q4).
   */
  configured: boolean;
}

const NONE: DefaultAggregatorResolution = { org_id: null, configured: false };

/**
 * The default aggregator for a served-domain binding, or `NONE`.
 *
 * Fails closed on ambiguity. Postgres cannot unique-index an array element, so
 * "one default per binding" is enforced by the set endpoint clearing the
 * binding off every other org in one transaction — this is the second line of
 * defence if a row is ever edited directly. Two claimants are reported as *no*
 * default rather than an arbitrary pick: an arbitrary pick would hand PII
 * decrypt rights to a coin flip, and treating it as "not configured" keeps the
 * go-live gate inert instead of freezing a whole domain on a misconfiguration.
 *
 * Not cached. It runs at most once per user (and only for domains that
 * configure the gate), inside a transaction that is already writing an item —
 * and the value is changed by an operator, so a cache would introduce a stale
 * window with nothing to invalidate it.
 */
export async function resolveDefaultAggregator(
  exec: Exec,
  network: string,
  domain: string,
  log?: FastifyBaseLogger,
): Promise<DefaultAggregatorResolution> {
  const binding = bindingKey(network, domain);

  const rows = await exec
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        sql`${organization.defaultForBindings} && ARRAY[${binding}]::text[]`,
        eq(organization.type, 'aggregator'),
      ),
    )
    .limit(2);

  if (rows.length === 0) return NONE;

  if (rows.length > 1) {
    log?.error(
      { binding, org_ids: rows.map((r) => r.id) },
      'default_aggregator: more than one org claims this binding — refusing to pick one',
    );
    return NONE;
  }

  return { org_id: rows[0].id, configured: true };
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
 * @returns the org id written, or null when nothing was written.
 */
export async function tagUserWithDefaultAggregator(
  exec: Exec,
  userId: string,
  network: string,
  domain: string,
  log?: FastifyBaseLogger,
): Promise<string | null> {
  const { org_id } = await resolveDefaultAggregator(exec, network, domain, log);
  if (!org_id) return null;

  const updated = await exec
    .update(user)
    .set({
      onboardedByOrgId: org_id,
      onboardedByDefault: true,
      onboardedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(user.id, userId), isNull(user.onboardedByOrgId)))
    .returning({ id: user.id });

  return updated.length > 0 ? org_id : null;
}

export interface OwnerGateContext {
  has_owner: boolean;
  default_configured: boolean;
}

/**
 * The two signals the `owner_required` go-live gate needs: whether the profile
 * owner has an owning aggregator, and whether a default exists for this binding
 * at all.
 *
 * Only called when a domain actually configures `owner_required`, so a domain
 * that hasn't opted in pays nothing.
 */
export async function resolveOwnerGateContext(
  exec: Exec,
  ownerUserId: string,
  network: string,
  domain: string,
  log?: FastifyBaseLogger,
): Promise<OwnerGateContext> {
  const [owner] = await exec
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, ownerUserId))
    .limit(1);

  const { configured } = await resolveDefaultAggregator(exec, network, domain, log);

  return {
    // A missing user row counts as "no owner" — fail closed. It should not
    // happen (items FK to `user`), and treating it as owned would be the
    // wrong direction on a gate that exists to guarantee an owner.
    has_owner: Boolean(owner?.onboardedByOrgId),
    default_configured: configured,
  };
}
