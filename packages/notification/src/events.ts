/**
 * Event names Signals sends to the notification service.
 *
 * This module is the single source of these names. The NS catalogue generator
 * emits a policy per (domain, event) from the same builders the senders use,
 * so a policy and the event that triggers it cannot drift apart.
 */

/** Which side of an action the recipient is on, and whether it is a request or a status change. */
export const ACTION_EVENT_SHAPES = [
  'inbound_request',
  'outbound_request',
  'inbound_status',
  'outbound_status',
] as const;
export type ActionEventShape = (typeof ACTION_EVENT_SHAPES)[number];

/**
 * `action.<actionType>.<shape>`, e.g. `action.connect.inbound_request`.
 *
 * `actionType` is the action type exactly as named in network.json (`connect`,
 * `apply`, `shortlist`, …). It must be a single non-empty segment.
 */
export function actionEvent(actionType: string, shape: ActionEventShape): string {
  if (actionType === '' || actionType.includes('.')) {
    throw new Error(`actionEvent: action type must be one non-empty segment, got "${actionType}"`);
  }
  if (!(ACTION_EVENT_SHAPES as readonly string[]).includes(shape)) {
    throw new Error(`actionEvent: unknown shape "${shape}"`);
  }
  return `action.${actionType}.${shape}`;
}

/** Item lifecycle events. */
export const ITEM_EVENT = {
  created: 'item.created',
  created_draft: 'item.created_draft',
  updated: 'item.updated',
  paused: 'item.paused',
  retired: 'item.retired',
} as const;
export type ItemEvent = (typeof ITEM_EVENT)[keyof typeof ITEM_EVENT];

/** An aggregator created the item on the participant's behalf. */
export const ITEM_ONBOARDED = 'item.onboarded_by_aggregator';

/** A pending action was cancelled because one of its items was retired. */
export const ACTION_CANCELLED_BY_RETIRE = 'action.cancelled_by_retire';

/** A new account was created. */
export const USER_WELCOME = 'user.welcome';

export const GUARDIAN_OTP_KINDS = ['account', 'profile', 'action', 'action_bulk'] as const;
export type GuardianOtpKind = (typeof GUARDIAN_OTP_KINDS)[number];

/** `guardian.otp.<kind>`; `generic` gives the copy-free `guardian.otp.generic`. */
export function guardianEvent(kind: GuardianOtpKind | 'generic'): string {
  if (kind !== 'generic' && !(GUARDIAN_OTP_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`guardianEvent: unknown kind "${kind}"`);
  }
  return `guardian.otp.${kind}`;
}

/** A support request submitted through the contact form. */
export const SUPPORT_REQUEST = 'support.request';
