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

function normalizePhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  if (phoneNumber.startsWith('+')) return phoneNumber;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
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

export async function requestOtp(identifier: AuthIdentifier): Promise<RequestOtpResponse> {
  const response = await apiClient.post<RequestOtpResponse>('/api/auth/unified-otp/request', {
    ...normalizeIdentifier(identifier),
  });
  return response.data;
}

export async function verifyOtp(
  identifier: AuthIdentifier,
  otp: string,
  name?: string,
  network?: string,
  domain?: string,
): Promise<VerifyOtpResponse> {
  const response = await apiClient.post<VerifyOtpResponse>('/api/auth/unified-otp/verify', {
    ...normalizeIdentifier(identifier),
    otp,
    name: name || 'user',
    ...(network ? { network } : {}),
    ...(domain ? { domain } : {}),
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
