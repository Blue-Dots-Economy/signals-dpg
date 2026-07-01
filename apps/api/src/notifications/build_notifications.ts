import { normalizeInstanceUrl } from '@/utils/action_event_runtime';

import type { NotificationShape } from './types';

export interface OwnerSide {
  /** Better-auth user id of the item owner; null when the owner has no user. */
  ownerUserId: string | null;
  /** Item id of this side's item — used to resolve a display/service name. */
  itemId: string;
  /** Item domain (role) for this side, e.g. "seeker" / "provider". */
  domain: string;
  /** Network the item belongs to. */
  network: string;
  /** Instance URL hosting this side's item — used for the locality check. */
  instanceUrl: string;
}

export interface NotificationEvent {
  lifecycle: 'created' | 'status';
  /**
   * True when this status change is a source-initiated cancellation (the
   * applicant withdrawing). Routes a single WITHDRAWN email to the receiver
   * instead of the INBOUND/OUTBOUND_STATUS pair, whose copy assumes the
   * receiver responded.
   */
  isCancellation?: boolean;
  actionType: string;
  actionId: string;
  /** Action status at the time of the event (e.g. "created", "accepted"). */
  status: string;
  updateCount: number;
  source: OwnerSide;
  target: OwnerSide;
  /** Base URL of the instance handling this event. */
  currentInstanceUrl: string;
}

export interface NotificationPlan {
  recipientUserId: string | null;
  recipientDomain: string;
  /** Counterparty item id — used to resolve the provider's service name. */
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
 * Pure: derives the notification plans for an action event. Emits one plan per
 * owner side hosted on the current instance (the locality check), so that the
 * Phase-2 cross-instance trigger site can reuse this unchanged.
 *
 * - create             → INBOUND_REQUEST (target) + OUTBOUND_REQUEST (source)
 * - status             → INBOUND_STATUS (source)  + OUTBOUND_STATUS (target)
 * - status+cancellation → WITHDRAWN (target only)
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
  } else if (event.isCancellation) {
    // Source withdrew their own request: only the receiver (target) needs to
    // know. The canceller gets no email, and the receiver-response copy
    // (INBOUND/OUTBOUND_STATUS) is skipped since no response occurred.
    if (isLocal(event.target)) {
      plans.push(planFor(event, event.target, event.source, 'WITHDRAWN'));
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
