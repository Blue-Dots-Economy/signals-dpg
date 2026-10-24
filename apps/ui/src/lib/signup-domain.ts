/**
 * One-shot handoff of the domain a new user picked on the self-signup form to
 * the profile-creation form (pages/profile-form-page.tsx), so the domain is not
 * asked twice. At signup no profile exists yet for the form to derive a locked
 * domain from. Stored per network for one read; the form clears it once
 * consumed so it cannot leak into a later profile-creation flow.
 */
/**
 * Signup-time domain + age for a brand-new account. On the Keycloak path it is
 * parked by `pending-signup-extras.ts` and written by the OIDC callback (domain
 * and, when present, age via `submitU18Dob`). Absent for returning users.
 */
export interface SignupExtras {
  domain: string;
  // Age in years, from a separate birth-year step shown only when the chosen
  // domain is guardian-gated. Absent for an ungated domain.
  age?: number;
}

const STORAGE_KEY_PREFIX = 'signupDomain:';

function storageKey(network: string): string {
  return `${STORAGE_KEY_PREFIX}${network}`;
}

export function getStoredSignupDomain(network: string): string | null {
  return localStorage.getItem(storageKey(network));
}

export function setStoredSignupDomain(network: string, domain: string): void {
  localStorage.setItem(storageKey(network), domain);
}

export function clearStoredSignupDomain(network: string): void {
  localStorage.removeItem(storageKey(network));
}
