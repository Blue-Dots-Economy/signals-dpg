/**
 * Action-email copy classification, keyed by (group × recipient role):
 *   - group: connect | apply (apply covers apply / shortlist / pre_shortlist)
 *   - recipientRole: who receives the email (seeker | provider)
 *
 * The actual copy (subject / body / cta) lives in `email/messages.default.properties`
 * (#529), looked up by case id (`email/email_cases.ts`'s `actionCaseId`) — this
 * module only resolves which case a notification maps to.
 */

export type CopyGroup = 'connect' | 'apply';
export type RecipientRole = 'seeker' | 'provider';

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
