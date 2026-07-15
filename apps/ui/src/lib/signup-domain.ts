/**
 * One-shot handoff of the domain a NEW user picked on the Signals self-signup
 * form (see pages/auth/login-page.tsx) to the profile-creation form
 * (pages/profile-form-page.tsx), so the domain isn't asked twice.
 *
 * Domain is confirmed at signup time (before any profile exists, so
 * profile-form-page's own "locked domain" derivation — based on the user's
 * existing items — has nothing to key off yet). This stores it for exactly
 * one subsequent read; profile-form-page clears it once consumed so it never
 * leaks into a later, unrelated profile-creation flow (e.g. a second profile
 * in another network).
 */
/** Signup-time domain + DOB (month/year only) captured for a brand-new
 * account on the Signals self-signup form. Threaded from login-page.tsx
 * through the OTP step's router state to otp-page.tsx, which uses it to
 * call submitU18Dob post-verify and, for a minor in a guardian-gated domain,
 * to drive the U18GuardianFlow. Undefined/null for returning users — they
 * never see these fields and never trigger this path. */
export interface SignupExtras {
  domain: string;
  birthMonth: number;
  birthYear: number;
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
