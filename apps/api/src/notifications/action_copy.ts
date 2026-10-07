/**
 * Recipient-role classification for action notifications (seeker | provider).
 * The copy itself is notification-service template content; Signals sends the
 * true action type and the recipient's domain id, and NS policies choose the
 * template. This role feeds the counterparty-name lookup.
 */

export type RecipientRole = 'seeker' | 'provider';

/**
 * Domains that play the "provider" (offering / responder) archetype across
 * networks. Everything else maps to the "seeker" archetype. This classifies
 * other networks' roles into the two Phase-1 copy variants without per-network
 * copy (which is Phase 2). Extend as networks are onboarded.
 */
const PROVIDER_LIKE_DOMAINS = new Set([
  'provider',
  'service_provider',
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
