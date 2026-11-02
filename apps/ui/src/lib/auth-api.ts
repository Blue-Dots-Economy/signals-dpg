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
  /** First browser session in the app (from `/auth/me`); plays the welcome
   * tours. Absent when not known. */
  firstLogin?: boolean;
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
  // Strip whitespace, dashes and parens first so "+91 9876543210" and
  // "+919876543210" normalize to one canonical shape (no duplicate rows).
  const cleaned = phoneNumber.replace(/[\s\-()]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (cleaned.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

/**
 * Accepts a 10-digit Indian mobile (first digit 6-9), the same with +91, or any
 * other E.164 number ("+" and 8-15 digits, first digit 1-9). Whitespace,
 * dashes and parens are stripped first, as in normalizePhoneNumber.
 */
export function isValidPhoneNumber(phoneNumber: string): boolean {
  const cleaned = phoneNumber.replace(/[\s\-()]/g, '');
  if (!cleaned) return false;
  const digits = cleaned.replace(/\D/g, '');
  // Indian-without-country-code shorthand kept for input convenience.
  if (!cleaned.startsWith('+') && digits.length === 10) {
    return /^[6-9]\d{9}$/.test(digits);
  }
  // +91 must be followed by exactly a 10-digit mobile; the generic E.164 rule
  // would accept a too-long number like "+919620421129333".
  if (cleaned.startsWith('+91')) {
    return /^91[6-9]\d{9}$/.test(digits);
  }
  // Any other "+": generic E.164.
  if (cleaned.startsWith('+')) {
    return /^[1-9]\d{7,14}$/.test(digits);
  }
  return false;
}

/**
 * Identifier params for the pre-login consent status check. The phone must be
 * normalized like the stored value (`normalizePhoneNumber`), or the
 * exact-match lookup in `/consent/status-by-identifier` misses a returning user
 * and the gate re-prompts every login.
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
 * Public pre-OTP check: does this existing user still need to give their age
 * (they hold a gated-domain profile and `user.age` is unset)? Decides whether
 * the login flow shows the birth-year and guardian steps before the user's OTP.
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

/** `GET /api/v1/auth/me`: the local `user` mirror's view. */
export interface MeResponse {
  id: string;
  email: string;
  name: string;
  role: string | null;
  /** True only in the person's first browser session in the app. */
  first_login: boolean;
}

/**
 * "Who am I" after the Keycloak redirect. The request also provisions the local
 * user mirror on a first login, which is when a new Keycloak subject becomes a
 * signals user.
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
   * The instance's identity provider, read at runtime to pick the login screen
   * (see lib/keycloak-config.ts). The API always sends `keycloak`; an absent
   * value is treated as `betterauth`, the legacy OTP screen.
   */
  authProvider?: 'betterauth' | 'keycloak';
  keycloak?: KeycloakPublicConfig | null;
}

export interface SignupResponse {
  ok: true;
  /** The identifier already belongs to someone — send them to sign in. */
  alreadyRegistered: boolean;
}

/**
 * Self-signup: creates the Keycloak identity only. The local signals user
 * appears at the first successful login, once the person has proved they own
 * the identifier via OTP. Needed because the OTP authenticator SPI cannot
 * create users and Keycloak's own registration form is password-based.
 */
export async function signupWithKeycloak(
  body: { name: string; domain?: string; age?: number } & AuthIdentifier
): Promise<SignupResponse> {
  const response = await apiClient.post<SignupResponse>('/api/v1/auth/signup', {
    name: body.name,
    ...normalizeIdentifier(body),
    ...(body.domain ? { domain: body.domain } : {}),
    ...(body.age !== undefined ? { age: body.age } : {}),
  });
  return response.data;
}

export async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  const response = await apiClient.get<AuthConfigResponse>('/api/v1/auth/config');
  return response.data;
}
