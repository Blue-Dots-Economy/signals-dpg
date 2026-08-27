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
   * Item id — folded into the notification-service `dedupe_id` so the send is
   * deduped per (case, owner, item) rather than per-recipient. Without an
   * explicit `dedupe_id`, NS keys on `email:<recipient>:basic_email` for 5s,
   * which silently drops this email when another email (e.g. the better-auth
   * `welcome`) fires to the same address milliseconds earlier (#592 Blocker 1).
   * Optional: `account.aggregator_init` is already unique per owner.
   */
  itemId?: string;
  /**
   * The acting org for the create, when the item was created on someone's
   * behalf. `org_type === 'aggregator'` routes a create to the aggregator
   * initiation email instead of the self profile/offer create email.
   */
  actingOrgType?: string | null;
  /** Onboarding org display name — substituted into the aggregator email. */
  aggregatorOrgName?: string | null;
  /**
   * The committed lifecycle status of the item, for `create` only. A create can
   * commit `draft` (incomplete profile / gated minor) while still returning 201,
   * so a `draft` create must NOT claim "your profile is live" — it routes to the
   * `*.create_incomplete` ("complete your profile") copy instead. Absent/`live`
   * → the standard create copy.
   */
  lifecycleStatus?: string | null;
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
  // Offer = provider-like domains (incl. service_provider), profile otherwise.
  const noun = resolveRecipientRole(event.domain) === 'provider' ? 'offer' : 'profile';
  switch (event.op) {
    case 'create':
      // A create that committed `draft` (incomplete / gated minor) is not
      // live/discoverable, so it gets the "complete your profile" copy rather
      // than the "you're live" create copy. Absent status ⇒ assume live.
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
    if (!caseId) {
      // No mapping for this op — make it observable rather than a silent drop
      // (guards a future op added without a case).
      log.warn({ op: event.op, domain: event.domain }, 'item-lifecycle: no email case for op');
      return;
    }

    const { found, name, email } = await resolveOwnerNameEmail(event.ownerId);
    if (!found) {
      // Missing user row for a supposedly-valid owner id is a defect signal
      // (broken created_by / wrong threaded id), not a benign skip.
      log.warn({ ownerId: event.ownerId, op: event.op }, 'item-lifecycle: owner user row not found — email skipped');
      return;
    }
    if (!email) {
      // Phone-only owner — benign, but record it so a "missed email" is never
      // fully silent. Non-PII: ownerId + op only.
      log.info({ ownerId: event.ownerId, op: event.op }, 'item-lifecycle: owner has no email — skipped');
      return;
    }

    const brandName = await resolveNetworkBrandName(event.network);

    // Per (case, owner, item) dedupe key so this send is not deduped against a
    // different email to the same recipient within NS's 5s window (#592 Blocker
    // 1). `account.aggregator_init` has no itemId but is already unique per owner.
    const itemSegment = event.itemId ? `:${event.itemId}` : '';
    const dedupeId = `item_lifecycle:${caseId}:${event.ownerId}${itemSegment}`;

    const variables: Record<string, string> = { name: name || 'there' };
    if (caseId === 'account.aggregator_init') {
      variables.aggregatorOrg = event.aggregatorOrgName || brandName;
    }

    // These cases are best_effort: dispatchEmail catches internally and returns
    // `{ ok: false }` rather than throwing, so a send failure would otherwise be
    // invisible here. Pass the structured request logger through, and act on the
    // result so a bulk-onboarding NS outage is logged (with op/network/ownerId),
    // not a silent 200.
    // The recipient IS the item owner, so their own item domain decides which
    // portal this links to — a split deployment serves seeker and provider from
    // different hosts (#569). `dispatch_email` renders `args.ctaUrl ?? ''` into
    // the shell, so an unresolved URL would ship `<a href="">`; send nothing
    // rather than a mail whose only call to action is broken.
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
    if (!ok) {
      log.warn(
        { caseId, op: event.op, network: event.network, ownerId: event.ownerId },
        'item-lifecycle email send failed (best_effort)',
      );
    }
  } catch (err) {
    // Best-effort: a lifecycle email must never fail the create/update/retire.
    log.warn({ err, op: event.op }, 'item-lifecycle notification failed');
  }
}
