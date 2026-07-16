import { createApiClient } from './api-client';

const apiClient = createApiClient();

export interface AuthIdentifier {
  email?: string;
  phoneNumber?: string;
}

export interface CheckUserResponse {
  userExists: boolean;
}

export interface RequestOtpResponse {
  ok: boolean;
  user: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  image: string;
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerifyOtpResponse {
  redirect: boolean;
  token: string;
  user: User;
}

export interface SessionResponse {
  user: User | null;
  token: string | null;
  session: {
    id: string;
    expiresAt: string;
  } | null;
}

export function normalizePhoneNumber(phoneNumber: string): string {
  // Always strip whitespace + dashes + parens first — historical data was
  // stored as "+91 9876543210" (with a space) so a later lookup against
  // the cleaner "+919876543210" missed. One canonical shape kills the
  // duplicate-row class of bugs.
  const cleaned = phoneNumber.replace(/[\s\-()]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (cleaned.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

/**
 * Validates a phone number. Accepts:
 *   - Indian shorthand: 10 digits starting with 6-9 (e.g. "9876543210")
 *     and the same with +91 prefix.
 *   - Any other E.164 number: leading "+" followed by 8-15 digits where
 *     the first digit is 1-9 (country code rule).
 *
 * Whitespace, dashes and parens are stripped before the check, matching
 * normalizePhoneNumber's behaviour.
 */
export function isValidPhoneNumber(phoneNumber: string): boolean {
  const cleaned = phoneNumber.replace(/[\s\-()]/g, '');
  if (!cleaned) return false;
  const digits = cleaned.replace(/\D/g, '');
  // Indian-without-country-code shorthand kept for input convenience.
  if (!cleaned.startsWith('+') && digits.length === 10) {
    return /^[6-9]\d{9}$/.test(digits);
  }
  // Indian numbers with the country code: exactly "+91" + a 10-digit mobile
  // (first subscriber digit 6-9). Rejects too-long inputs like
  // "+919620421129333" that the generic E.164 rule below would otherwise
  // wave through on length alone.
  if (cleaned.startsWith('+91')) {
    return /^91[6-9]\d{9}$/.test(digits);
  }
  // Any other explicit "+" — accept generic E.164. 8-15 digits total; the
  // leading digit (the country code's first digit) must be 1-9.
  if (cleaned.startsWith('+')) {
    return /^[1-9]\d{7,14}$/.test(digits);
  }
  // No "+" and not the 10-digit Indian shape — reject.
  return false;
}

/**
 * Build the identifier params for the pre-login consent status check. The phone
 * MUST be normalized to the same canonical E.164 form the auth path stores
 * (`normalizePhoneNumber`), or the exact-match lookup in
 * `/consent/status-by-identifier` misses a returning user and the T&C gate
 * re-prompts on every login.
 */
export function consentStatusIdentifier(
  identifier: AuthIdentifier,
): { phone?: string; email?: string } {
  const param: { phone?: string; email?: string } = {};
  if (identifier.email) param.email = identifier.email;
  if (identifier.phoneNumber) param.phone = normalizePhoneNumber(identifier.phoneNumber);
  return param;
}

function normalizeIdentifier(identifier: AuthIdentifier): AuthIdentifier {
  const email = identifier.email?.trim().toLowerCase();
  const phoneNumber = identifier.phoneNumber?.trim();

  return {
    ...(email ? { email } : {}),
    ...(phoneNumber ? { phoneNumber: normalizePhoneNumber(phoneNumber) } : {}),
  };
}

export async function checkUser(identifier: AuthIdentifier): Promise<CheckUserResponse> {
  const response = await apiClient.post<CheckUserResponse>('/api/auth/unified-otp/check-user', {
    ...normalizeIdentifier(identifier),
  });
  return response.data;
}

export interface U18PrecheckResponse {
  /** Existing user on a guardian-gated domain with no stored DOB. */
  requiresDob: boolean;
}

/**
 * Public pre-OTP check: does this EXISTING user still need a DOB (they hold a
 * gated-domain profile and `date_of_birth` is unset)? Drives whether the login
 * flow shows the DOB → guardian steps BEFORE the user's own OTP.
 */
export async function u18Precheck(
  network: string,
  identifier: AuthIdentifier,
): Promise<U18PrecheckResponse> {
  const response = await apiClient.post<U18PrecheckResponse>('/api/v1/auth/u18-precheck', {
    network,
    ...normalizeIdentifier(identifier),
  });
  return response.data;
}

export async function requestOtp(identifier: AuthIdentifier): Promise<RequestOtpResponse> {
  const response = await apiClient.post<RequestOtpResponse>('/api/auth/unified-otp/request', {
    ...normalizeIdentifier(identifier),
  });
  return response.data;
}

export async function verifyOtp(
  identifier: AuthIdentifier,
  otp: string,
  name?: string
): Promise<VerifyOtpResponse> {
  const response = await apiClient.post<VerifyOtpResponse>('/api/auth/unified-otp/verify', {
    ...normalizeIdentifier(identifier),
    otp,
    name: name || 'user',
  });
  return response.data;
}

export async function signOut(): Promise<void> {
  await apiClient.post('/api/auth/sign-out');
}

export async function getSession(): Promise<SessionResponse> {
  const response = await apiClient.get<SessionResponse>('/api/auth/get-session');
  return response.data;
}

export type LoginChannel = 'email' | 'phone';

export interface AuthConfigResponse {
  selfSignupAllowed: boolean;
  loginChannels: LoginChannel[];
}

export async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  const response = await apiClient.get<AuthConfigResponse>('/api/v1/auth/config');
  return response.data;
}
