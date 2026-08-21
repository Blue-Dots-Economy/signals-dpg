import type { FastifyBaseLogger } from 'fastify';

import { resolveRecipientRole } from './action_copy';
import { resolveNetworkBrandName, resolveNotifierConfig } from './notify_actions';
import { resolveOwnerNameEmail } from './resolve_owner';

/**
 * Owner-facing item-lifecycle emails (#531/#534): profile/offer create, update,
 * pause, retire, plus the aggregator-onboarding initiation email.
 *
 * Design (agreed): the standard create/update emails are for SELF actions only.
 * When an aggregator onboards a participant (acting-org = aggregator) the create
 * fires `account.aggregator_init` INSTEAD — the self create/welcome emails are
 * suppressed for that record so the participant gets exactly one email. Welcome
 * suppression on the aggregator path lives in `provisioning.ts`.
 *
 * Fire-and-forget, best-effort: never throws, never blocks the triggering route.
 * No-op when notifications aren't configured (see resolveNotifierConfig).
 */

export type ItemLifecycleOp = 'create' | 'update' | 'pause' | 'retire';

export interface ItemLifecycleEvent {
  op: ItemLifecycleOp;
  /** Item owner (better-auth user id) — the email recipient. */
  ownerId: string;
  /** Item domain — decides profile (seeker) vs offer (provider) copy. */
  domain: string;
  /** Item network — selects the copy layer + branded sign-off. */
  network: string;
  /**
   * The acting org for the create, when the item was created on someone's
   * behalf. `org_type === 'aggregator'` routes a create to the aggregator
   * initiation email instead of the self profile/offer create email.
   */
  actingOrgType?: string | null;
  /** Onboarding org display name — substituted into the aggregator email. */
  aggregatorOrgName?: string | null;
}

/**
 * Maps an event to its email case id. `create` under an aggregator acting-org
 * becomes the initiation email; every other op is the owner's profile/offer
 * email keyed by role (seeker → profile, provider/service_provider → offer).
 */
export function itemLifecycleCaseId(event: ItemLifecycleEvent): string | null {
  if (event.op === 'create' && event.actingOrgType === 'aggregator') {
    return 'account.aggregator_init';
  }
  // Offer = provider-like domains. `service_provider` (purple_dot/up-gzb) isn't
  // in the shared PROVIDER_LIKE_DOMAINS set (a latent gap for its action emails
  // too — flagged separately), so map it explicitly here.
  const isOffer =
    resolveRecipientRole(event.domain) === 'provider' || event.domain === 'service_provider';
  const noun = isOffer ? 'offer' : 'profile';
  switch (event.op) {
    case 'create':
      return `${noun}.create`;
    case 'update':
      return `${noun}.update`;
    case 'pause':
      return `${noun}.pause`;
    case 'retire':
      return `${noun}.retire`;
    default:
      return null;
  }
}

/**
 * Fire-and-forget entry point for the item-lifecycle route seams (create_item,
 * update_item, lifecycle pause/retire). Resolves the owner + copy and hands off
 * to the central #529 sender. Awaiting is optional — callers use `void`.
 */
export async function dispatchItemLifecycleNotification(
  event: ItemLifecycleEvent,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const config = resolveNotifierConfig();
    if (!config) return;

    const caseId = itemLifecycleCaseId(event);
    if (!caseId) return;

    const { name, email } = await resolveOwnerNameEmail(event.ownerId);
    if (!email) return; // phone-only owner — no email to send to.

    const brandName = await resolveNetworkBrandName(event.network);

    const variables: Record<string, string> = { name: name || 'there' };
    if (caseId === 'account.aggregator_init') {
      variables.aggregatorOrg = event.aggregatorOrgName || brandName;
    }

    await config.sender.dispatchEmail({
      caseId,
      to: email,
      fromName: brandName,
      network: event.network,
      ctaUrl: config.ctaUrl,
      variables,
    });
  } catch (err) {
    // Best-effort: a lifecycle email must never fail the create/update/retire.
    log.warn({ err, op: event.op }, 'item-lifecycle notification failed');
  }
}
