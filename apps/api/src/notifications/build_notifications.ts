import { normalizeInstanceUrl } from '@/utils/action_event_runtime';

import type { NotificationShape } from './types';

export interface OwnerSide {
  /** User id of the item owner; null when the owner has no user. */
  ownerUserId: string | null;
  /** Used to resolve a display/service name. */
  itemId: string;
  /** Item domain (role), e.g. "seeker" / "provider". */
  domain: string;
  network: string;
  /** Instance hosting this side's item, for the locality check. */
  instanceUrl: string;
}

export interface NotificationEvent {
  lifecycle: 'created' | 'status';
  actionType: string;
  actionId: string;
  /** Action status at the time of the event (e.g. "created", "accepted"). */
  status: string;
  updateCount: number;
  source: OwnerSide;
  target: OwnerSide;
  currentInstanceUrl: string;
}

export interface NotificationPlan {
  recipientUserId: string | null;
  recipientDomain: string;
  /** Used to resolve the provider's service name. */
  counterpartyItemId: string;
  counterpartyDomain: string;
  counterpartyNetwork: string;
  shape: NotificationShape;
  actionType: string;
  status: string;
  actionId: string;
  updateCount: number;
}

function planFor(
  event: NotificationEvent,
  recipient: OwnerSide,
  counterparty: OwnerSide,
  shape: NotificationShape,
): NotificationPlan {
  return {
    recipientUserId: recipient.ownerUserId,
    recipientDomain: recipient.domain,
    counterpartyItemId: counterparty.itemId,
    counterpartyDomain: counterparty.domain,
    counterpartyNetwork: counterparty.network,
    shape,
    actionType: event.actionType,
    status: event.status,
    actionId: event.actionId,
    updateCount: event.updateCount,
  };
}

/**
 * Derives the notification plans for an action event: one per owner side
 * hosted on this instance.
 *
 * - create  → INBOUND_REQUEST (target) + OUTBOUND_REQUEST (source)
 * - status  → INBOUND_STATUS (source)  + OUTBOUND_STATUS (target)
 */
export function buildNotifications(event: NotificationEvent): NotificationPlan[] {
  const current = normalizeInstanceUrl(event.currentInstanceUrl);
  const isLocal = (side: OwnerSide) =>
    normalizeInstanceUrl(side.instanceUrl) === current;

  const plans: NotificationPlan[] = [];

  if (event.lifecycle === 'created') {
    if (isLocal(event.target)) {
      plans.push(planFor(event, event.target, event.source, 'INBOUND_REQUEST'));
    }
    if (isLocal(event.source)) {
      plans.push(planFor(event, event.source, event.target, 'OUTBOUND_REQUEST'));
    }
  } else {
    if (isLocal(event.source)) {
      plans.push(planFor(event, event.source, event.target, 'INBOUND_STATUS'));
    }
    if (isLocal(event.target)) {
      plans.push(planFor(event, event.target, event.source, 'OUTBOUND_STATUS'));
    }
  }

  return plans;
}
