import type { FastifyBaseLogger } from 'fastify';
import { ITEM_EVENT, ITEM_ONBOARDED } from '@dpg/notification';

import { resolveNetworkBrandName, resolveNotifierConfig } from './notify_actions';
import { resolveOwnerNameEmail } from './resolve_owner';
import { sendBestEffort } from './send_event';

/**
 * Owner-facing item-lifecycle events (#531/#534): `item.created`,
 * `item.created_draft`, `item.updated`, `item.paused`, `item.retired`, plus
 * `item.onboarded_by_aggregator`. The notification service's policy for the
 * item's domain picks the profile/offer copy.
 *
 * Design (agreed): the standard create/update notices are for SELF actions only.
 * When an aggregator onboards a participant (acting-org = aggregator) the create
 * sends `item.onboarded_by_aggregator` INSTEAD — the self create/welcome notices
 * are suppressed for that record so the participant gets exactly one email.
 * Welcome suppression on the aggregator path lives in `provisioning.ts`.
 *
 * Fire-and-forget, best-effort: never throws, never blocks the triggering route.
 * No-op when notifications aren't configured (see resolveNotifierConfig).
 */

export type ItemLifecycleOp = 'create' | 'update' | 'pause' | 'retire';

export interface ItemLifecycleEvent {
  op: ItemLifecycleOp;
  /** Item owner (better-auth user id) — the email recipient. */
  ownerId: string;
  /** Item domain — sent as the event's `domain`; NS picks profile vs offer copy from it. */
  domain: string;
  /** Item network — names the network in the aggregator-onboarding notice. */
  network: string;
  /**
   * Item id — folded into the `idempotency_key` so the send is deduped per
   * (event, owner, item) rather than per-recipient. Without an explicit key,
   * NS falls back to a 5 s content-duplicate guard, which can drop this email
   * when another email fires to the same address milliseconds earlier (#592
   * Blocker 1). Optional: the aggregator-onboarding notice is already unique
   * per owner.
   */
  itemId?: string;
  /**
   * The acting org for the create, when the item was created on someone's
   * behalf. `org_type === 'aggregator'` turns a create into
   * `item.onboarded_by_aggregator` instead of the self `item.created`.
   */
  actingOrgType?: string | null;
  /** Onboarding org display name — sent as `aggregatorOrg`. */
  aggregatorOrgName?: string | null;
  /**
   * The committed lifecycle status of the item, for `create` only. A create can
   * commit `draft` (incomplete profile / gated minor) while still returning 201,
   * so a `draft` create must NOT claim "your profile is live" — it sends
   * `item.created_draft` ("complete your profile") instead. Absent/`live` →
   * `item.created`.
   */
  lifecycleStatus?: string | null;
}

/**
 * The event for a lifecycle op. Signals picks only the event; the copy for the
 * item's domain is the notification service's choice. Two decisions stay here
 * because they change *what happened*: an aggregator create is
 * `item.onboarded_by_aggregator`, and a create that committed `draft` is
 * `item.created_draft`.
 */
export function itemLifecycleEventType(event: ItemLifecycleEvent): string | null {
  if (event.op === 'create' && event.actingOrgType === 'aggregator') {
    return ITEM_ONBOARDED;
  }
  switch (event.op) {
    case 'create':
      // A create that committed `draft` (incomplete / gated minor) is not
      // live/discoverable. Absent status ⇒ assume live.
      return event.lifecycleStatus && event.lifecycleStatus !== 'live'
        ? ITEM_EVENT.created_draft
        : ITEM_EVENT.created;
    case 'update':
      return ITEM_EVENT.updated;
    case 'pause':
      return ITEM_EVENT.paused;
    case 'retire':
      return ITEM_EVENT.retired;
    default:
      return null;
  }
}

/**
 * Fire-and-forget entry point for the item-lifecycle route seams (create_item,
 * update_item, lifecycle pause/retire, admin participant onboarding). Resolves
 * the owner and sends one event to the notification service. Awaiting is
 * optional — callers use `void`.
 */
export async function dispatchItemLifecycleNotification(
  event: ItemLifecycleEvent,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const config = resolveNotifierConfig();
    if (!config) return;

    const eventType = itemLifecycleEventType(event);
    if (!eventType) {
      // No mapping for this op — make it observable rather than a silent drop
      // (guards a future op added without an event).
      log.warn({ op: event.op, domain: event.domain }, 'item-lifecycle: no event for op');
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

    // The recipient IS the item owner, so their own item domain decides which
    // portal this links to — a split deployment serves seeker and provider from
    // different hosts (#569). A missing URL would leave the only call to action
    // broken, so send nothing.
    const ctaUrl = config.resolveCtaUrl(event.domain);
    if (!ctaUrl) {
      log.warn(
        { event_type: eventType, op: event.op, network: event.network, domain: event.domain },
        'item-lifecycle email skipped: no CTA url for the item domain',
      );
      return;
    }

    let variables: Record<string, string>;
    if (eventType === ITEM_ONBOARDED) {
      // <Aggregator Name> — who onboarded them; <Dot Network> — the network brand.
      const networkName = await resolveNetworkBrandName(event.network);
      variables = {
        aggregatorOrg: event.aggregatorOrgName || networkName,
        networkName,
        ctaUrl,
        teamName: config.teamName,
      };
    } else {
      variables = { name: name || 'there', ctaUrl, teamName: config.teamName };
    }

    // Per (event, owner, item) key so this send is not deduped against a
    // different email to the same recipient (#592 Blocker 1). The onboarding
    // notice has no itemId but is already unique per owner.
    const itemSegment = event.itemId ? `:${event.itemId}` : '';
    await sendBestEffort(
      config.send,
      {
        event_type: eventType,
        domain: event.domain,
        to: { email },
        variables,
        priority: 'normal',
        idempotency_key: `item_lifecycle:${eventType}:${event.ownerId}${itemSegment}`,
      },
      (message, meta) => log.warn(meta, message),
      { op: event.op, network: event.network, ownerId: event.ownerId },
    );
  } catch (err) {
    // Best-effort: a lifecycle email must never fail the create/update/retire.
    log.warn({ err, op: event.op }, 'item-lifecycle notification failed');
  }
}
