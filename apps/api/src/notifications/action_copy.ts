import type { NotificationShape } from './types';

/**
 * Action-email copy, transcribed verbatim from the "Standard Events &
 * Notifications" doc. Keyed by (group × recipient role × shape):
 *   - group: connect | apply (apply covers apply / shortlist / pre_shortlist)
 *   - recipientRole: who receives the email (seeker | provider)
 *   - shape: INBOUND_REQUEST | OUTBOUND_REQUEST | INBOUND_STATUS | OUTBOUND_STATUS
 *
 * `{name}` is the counterparty's service name — substituted only in
 * seeker-facing copy (the provider's Service Name). Provider-facing copy keeps
 * the seeker generic ("the seeker") per the doc / PII rules.
 */

export type CopyGroup = 'connect' | 'apply';
export type RecipientRole = 'seeker' | 'provider';

export interface ActionEmailCopy {
  subject: string;
  body: string;
  ctaLabel: string;
}

export function resolveCopyGroup(actionType: string): CopyGroup {
  // apply / shortlist / pre_shortlist share the "apply" family copy.
  return actionType === 'connect' ? 'connect' : 'apply';
}

/**
 * Domains that play the "provider" (offering / responder) archetype across
 * networks. Everything else maps to the "seeker" archetype. This classifies
 * other networks' roles into the two Phase-1 copy variants without per-network
 * copy (which is Phase 2). Extend as networks are onboarded.
 */
const PROVIDER_LIKE_DOMAINS = new Set([
  'provider',
  'coaching_center',
  'tutor',
  'individual_tutor_weera_counsellor',
  'practitioner',
]);

export function resolveRecipientRole(domain: string): RecipientRole {
  return PROVIDER_LIKE_DOMAINS.has(domain) ? 'provider' : 'seeker';
}

/** Fallback name when a provider's service name can't be resolved. */
export const FALLBACK_SERVICE_NAME = 'the service provider';

const COPY: Record<
  CopyGroup,
  Record<RecipientRole, Record<NotificationShape, ActionEmailCopy>>
> = {
  connect: {
    // Connect – Seeker to Provider (recipient = seeker; counterparty = provider)
    seeker: {
      INBOUND_REQUEST: {
        subject: 'A service provider wants to connect with you',
        body: '{name} has expressed interest in connecting with you. They may have an opportunity or service that matches what you’re looking for. Click below to view the details and respond.',
        ctaLabel: 'View the details and respond',
      },
      OUTBOUND_REQUEST: {
        subject: 'Your connection request has been sent to {name}',
        body: 'Your request for service has been successfully sent to {name}. They will be notified and will respond shortly. Click below to track your request.',
        ctaLabel: 'Track your request',
      },
      INBOUND_STATUS: {
        subject: '{name} has responded to your connection request',
        body: '{name} has responded to your connection request. Check the latest update and take the next step. Click below to view their response.',
        ctaLabel: 'View their response',
      },
      OUTBOUND_STATUS: {
        subject: 'Your response has been sent to {name}',
        body: 'Your response to {name}’s connection request has been sent successfully. They will be notified. Click below to view the details.',
        ctaLabel: 'View the details',
      },
    },
    // Connect – Provider to Seeker (recipient = provider; counterparty = seeker)
    provider: {
      INBOUND_REQUEST: {
        subject: 'A seeker wants to avail your service',
        body: 'A seeker has shown interest in the service you’re offering and wants to connect with you. Click below to view their details and respond.',
        ctaLabel: 'View their details and respond',
      },
      OUTBOUND_REQUEST: {
        subject: 'Your request has been sent to the seeker',
        body: 'Your connection request has been successfully sent to the seeker. They will be notified and will respond shortly. Click below to track your request.',
        ctaLabel: 'Track your request',
      },
      INBOUND_STATUS: {
        subject: 'The seeker has responded to your connection request',
        body: 'The seeker has responded to your connection request. Check the latest update and take the next step. Click below to view their response.',
        ctaLabel: 'View their response',
      },
      OUTBOUND_STATUS: {
        subject: 'Your response has been sent to the seeker',
        body: 'Your response to the seeker’s connection request has been sent successfully. They will be notified. Click below to view the details.',
        ctaLabel: 'View the details',
      },
    },
  },
  apply: {
    // Apply / Shortlist / Pre-Shortlist – Seeker to Provider (recipient = seeker)
    seeker: {
      INBOUND_REQUEST: {
        subject: '{name} has shown interest in your profile',
        body: '{name} has reviewed your profile and taken an action. This could be an important step towards your next opportunity. Click below to view what they’ve done and respond.',
        ctaLabel: 'View what they’ve done and respond',
      },
      OUTBOUND_REQUEST: {
        subject: 'Your application has been sent to {name}',
        body: 'Your application has been successfully sent to {name}. They will review it and get back to you. Click below to track your application.',
        ctaLabel: 'Track your application',
      },
      INBOUND_STATUS: {
        subject: '{name} has updated the status of your application',
        body: '{name} has responded to your application. Check the latest update to know your next step. Click below to view the response.',
        ctaLabel: 'View the response',
      },
      OUTBOUND_STATUS: {
        subject: 'Your response has been sent to {name}',
        body: 'Your response to {name}’s action has been sent successfully. They will be notified. Click below to view the details.',
        ctaLabel: 'View the details',
      },
    },
    // Apply / Shortlist / Pre-Shortlist – Provider to Seeker (recipient = provider)
    provider: {
      INBOUND_REQUEST: {
        subject: 'A seeker has applied for your opportunity',
        body: 'A seeker has applied for the opportunity you are offering. Review their profile and take the next step. Click below to view the application.',
        ctaLabel: 'View the application',
      },
      OUTBOUND_REQUEST: {
        subject: 'Your shortlisting action has been sent to the seeker',
        body: 'Your shortlisting action has been successfully sent to the seeker. They will be notified and can now respond. Click below to track this action.',
        ctaLabel: 'Track this action',
      },
      INBOUND_STATUS: {
        subject: 'The seeker has responded to your shortlisting action',
        body: 'The seeker has responded to your shortlisting action. Check the latest update to take the next step. Click below to view their response.',
        ctaLabel: 'View their response',
      },
      OUTBOUND_STATUS: {
        subject: 'Your response has been sent to the seeker',
        body: 'Your response to the seeker’s application has been sent successfully. They will be notified. Click below to view the details.',
        ctaLabel: 'View the details',
      },
    },
  },
};

export function resolveActionEmailCopy(
  group: CopyGroup,
  role: RecipientRole,
  shape: NotificationShape,
): ActionEmailCopy {
  return COPY[group][role][shape];
}

/**
 * Copy for the retire → counterparty notification (#418). Deliberately NOT part
 * of the (group × role × shape) table above: those status shapes are worded as
 * "the other party responded", which is misleading for a retire auto-cancel
 * (nobody responded). This is a single, role-agnostic, PII-safe message — the
 * retired profile's name is already wiped, so it names nothing about that user.
 * No `{name}` token.
 */
export const RETIRE_CANCEL_COPY: ActionEmailCopy = {
  subject: 'A connection has been cancelled',
  body: 'A profile you were connected with has been retired and is no longer available, so your active connection with it has been cancelled. No action is needed on your part.',
  ctaLabel: 'View your connections',
};
