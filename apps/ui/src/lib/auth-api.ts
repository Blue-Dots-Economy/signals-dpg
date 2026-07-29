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
 * Public pre-OTP check: does this EXISTING user still need to give their age
 * (they hold a gated-domain profile and `user.age` is unset)? Drives whether the
 * login flow shows the birth-year → guardian steps BEFORE the user's own OTP.
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

/** What `GET /api/v1/auth/me` returns — the local `user` mirror's view. */
export interface MeResponse {
  id: string;
  email: string;
  name: string;
  role: string | null;
}

/**
 * "Who am I", for the Keycloak login path. better-auth's `/get-session` does
 * not serve OIDC sessions, so after the redirect the UI resolves its user this
 * way instead. The request also triggers first-login provisioning of the local
 * mirror on the API side, so it is the point at which a brand-new Keycloak
 * subject becomes a signals user.
 */
export async function fetchMe(): Promise<MeResponse> {
  const response = await apiClient.get<MeResponse>('/api/v1/auth/me');
  return response.data;
}

export type LoginChannel = 'email' | 'phone';

/** OIDC details the API advertises. Null when Keycloak isn't configured. */
export interface KeycloakPublicConfig {
  url: string;
  realm: string;
  clientId: string;
}

export interface AuthConfigResponse {
  selfSignupAllowed: boolean;
  loginChannels: LoginChannel[];
  /**
   * The instance's identity provider, per server env. The UI reads this to pick
   * a login screen at runtime rather than having it compiled into the bundle —
   * see lib/keycloak-config.ts for why.
   *
   * Optional on the type so a UI build can talk to an older API that doesn't
   * send it yet; absent is treated as `betterauth`.
   */
  authProvider?: 'betterauth' | 'dual' | 'keycloak';
  keycloak?: KeycloakPublicConfig | null;
}

export interface SignupResponse {
  ok: true;
  /** The identifier already belongs to someone — send them to sign in. */
  alreadyRegistered: boolean;
}

/**
 * Self-signup for Keycloak instances: creates the Keycloak identity only.
 *
 * The local signals user appears at first successful login, so nothing exists
 * server-side until the person proves they own the identifier via OTP. Needed
 * because the OTP authenticator SPI cannot create users and Keycloak's own
 * registration form is password-based.
 */
export async function signupWithKeycloak(
  body: { name: string; domain?: string; dateOfBirth?: string } & AuthIdentifier
): Promise<SignupResponse> {
  const response = await apiClient.post<SignupResponse>('/api/v1/auth/signup', {
    name: body.name,
    ...normalizeIdentifier(body),
    ...(body.domain ? { domain: body.domain } : {}),
    ...(body.dateOfBirth ? { dateOfBirth: body.dateOfBirth } : {}),
  });
  return response.data;
}

export async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  const response = await apiClient.get<AuthConfigResponse>('/api/v1/auth/config');
  return response.data;
}
