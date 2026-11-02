import type { FastifyBaseLogger } from 'fastify';

import { resolveRecipientRole } from './action_copy';
import { resolveNetworkBrandName, resolveNotifierConfig } from './notify_actions';
import { resolveOwnerNameEmail } from './resolve_owner';

/**
 * Owner-facing item-lifecycle emails: profile/offer create, update, pause,
 * retire, plus the aggregator-onboarding initiation email.
 *
 * A create under an aggregator acting org sends `account.aggregator_init.*`
 * instead of the create email, so the participant gets one email.
 *
 * Best-effort: never throws. No-op when notifications are not configured.
 */

export type ItemLifecycleOp = 'create' | 'update' | 'pause' | 'retire';

export interface ItemLifecycleEvent {
  op: ItemLifecycleOp;
  /** Item owner's user id; the email recipient. */
  ownerId: string;
  /** Item domain — decides profile (seeker) vs offer (provider) copy. */
  domain: string;
  /** Item network — selects the copy layer + branded sign-off. */
  network: string;
  /**
   * Folded into the notification-service `dedupe_id`, so dedupe is per
   * (case, owner, item). Optional: `account.aggregator_init` is unique per owner.
   */
  itemId?: string;
  /** Acting org type; `'aggregator'` routes a create to the initiation email. */
  actingOrgType?: string | null;
  /** Onboarding org display name — substituted into the aggregator email. */
  aggregatorOrgName?: string | null;
  /**
   * Committed lifecycle status, for `create` only. A create can commit `draft`
   * (incomplete profile / gated minor), which gets the `*.create_incomplete`
   * copy. Absent or `live` gets the standard create copy.
   */
  lifecycleStatus?: string | null;
}

/**
 * Maps an event to its email case id: seeker domains use `profile.*`,
 * provider/service_provider use `offer.*`.
 */
export function itemLifecycleCaseId(event: ItemLifecycleEvent): string | null {
  if (event.op === 'create' && event.actingOrgType === 'aggregator') {
    return `account.aggregator_init.${resolveRecipientRole(event.domain)}`;
  }
  const noun = resolveRecipientRole(event.domain) === 'provider' ? 'offer' : 'profile';
  switch (event.op) {
    case 'create':
      return event.lifecycleStatus && event.lifecycleStatus !== 'live'
        ? `${noun}.create_incomplete`
        : `${noun}.create`;
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

/** Entry point for item create/update/pause/retire. Never throws; callers may `void` it. */
export async function dispatchItemLifecycleNotification(
  event: ItemLifecycleEvent,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const config = resolveNotifierConfig();
    if (!config) return;

    const caseId = itemLifecycleCaseId(event);
    if (!caseId) {
      log.warn({ op: event.op, domain: event.domain }, 'item-lifecycle: no email case for op');
      return;
    }

    const { found, name, email } = await resolveOwnerNameEmail(event.ownerId);
    if (!found) {
      // A missing user row for an owner id is a defect, not a benign skip.
      log.warn({ ownerId: event.ownerId, op: event.op }, 'item-lifecycle: owner user row not found — email skipped');
      return;
    }
    if (!email) {
      // Phone-only owner. Log ownerId and op only (no PII).
      log.info({ ownerId: event.ownerId, op: event.op }, 'item-lifecycle: owner has no email — skipped');
      return;
    }

    const brandName = await resolveNetworkBrandName(event.network);

    // notification-service suppresses a repeat of an explicit dedupe_id for 1 hour.
    const itemSegment = event.itemId ? `:${event.itemId}` : '';
    const dedupeId = `item_lifecycle:${caseId}:${event.ownerId}${itemSegment}`;

    const variables: Record<string, string> = { name: name || 'there' };
    if (caseId.startsWith('account.aggregator_init')) {
      variables.aggregatorOrg = event.aggregatorOrgName || brandName;
      variables.networkName = brandName;
    }

    // The item domain picks the portal (split deployments host seeker and
    // provider separately). Without a URL the CTA would be `<a href="">`, so skip.
    const ctaUrl = config.resolveCtaUrl(event.domain);
    if (!ctaUrl) {
      log.warn(
        { caseId, op: event.op, network: event.network, domain: event.domain },
        'item-lifecycle email skipped: no CTA url for the item domain',
      );
      return;
    }

    const { ok } = await config.sender.dispatchEmail({
      caseId,
      to: email,
      fromName: brandName,
      network: event.network,
      ctaUrl,
      variables,
      dedupeId,
      log: (message, meta) =>
        log.warn({ ...meta, op: event.op, network: event.network, ownerId: event.ownerId }, message),
    });
    // Best-effort sends return `{ ok: false }` instead of throwing; log it.
    if (!ok) {
      log.warn(
        { caseId, op: event.op, network: event.network, ownerId: event.ownerId },
        'item-lifecycle email send failed (best_effort)',
      );
    }
  } catch (err) {
    log.warn({ err, op: event.op }, 'item-lifecycle notification failed');
  }
}
