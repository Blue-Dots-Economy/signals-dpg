/**
 * Action-email copy classification by group (connect | apply) and recipient
 * role (seeker | provider). The copy itself is in the email messages files,
 * looked up via `actionCaseId`.
 */

export type CopyGroup = 'connect' | 'apply';
export type RecipientRole = 'seeker' | 'provider';

export function resolveCopyGroup(actionType: string): CopyGroup {
  // Every non-connect action type uses the "apply" copy.
  return actionType === 'connect' ? 'connect' : 'apply';
}

/**
 * Domains that get "provider" copy across networks; every other domain gets
 * "seeker" copy. Extend as networks are onboarded.
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
