/**
 * The only per-action-type knowledge in the notification module: a static,
 * typed copy map. Pure data, no I/O — this is the seam that a Phase-2
 * notification-service-owned registry would replace.
 */

export interface ActionCopy {
  /** Noun for the thing being exchanged, e.g. "connection request". */
  objectNoun: string;
  /** Verb phrase describing the inbound action, reads after the actor label. */
  inboundPhrase: string;
}

export const ACTION_COPY: Record<string, ActionCopy> = {
  connect: {
    objectNoun: 'connection request',
    inboundPhrase: 'wants to connect with you',
  },
  apply: {
    objectNoun: 'application',
    inboundPhrase: 'has applied for your opportunity',
  },
  shortlist: {
    objectNoun: 'shortlisting action',
    inboundPhrase: 'has shown interest in your profile',
  },
  pre_shortlist: {
    objectNoun: 'shortlisting action',
    inboundPhrase: 'has shown interest in your profile',
  },
};

/** Unknown action types degrade gracefully to neutral copy. */
export const FALLBACK_ACTION_COPY: ActionCopy = {
  objectNoun: 'interaction',
  inboundPhrase: 'has taken an action on your profile',
};

export function resolveActionCopy(actionType: string): ActionCopy {
  return ACTION_COPY[actionType] ?? FALLBACK_ACTION_COPY;
}

/**
 * Role-generic counterparty labels derived from the item domain on the action
 * record. Phase 1 uses role-generic labels only; the counterparty's actual
 * name is substituted by the renderer only where PII-reveal rules permit.
 */
export const DOMAIN_LABEL: Record<string, string> = {
  seeker: 'a seeker',
  provider: 'a service provider',
};

export const FALLBACK_DOMAIN_LABEL = 'another user';

export function resolveDomainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? FALLBACK_DOMAIN_LABEL;
}
