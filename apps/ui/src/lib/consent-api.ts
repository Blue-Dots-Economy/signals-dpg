import { createApiClient } from './api-client';
import type { ConsentConfigDocument } from '@dpg/schemas';
import type { ConsentAcceptBody, ConsentStatusResponse } from '@dpg/schemas';
import type { ProfileConsentAcceptBody, ProfileConsentStatusResponse } from '@dpg/schemas';

const apiClient = createApiClient();

interface ConsentConfigEntry {
  brand: string | null;
  schema: ConsentConfigDocument;
}

interface ConsentAcceptResponse {
  recorded: number;
}

interface RawSchemaEntry {
  kind: string;
  brand?: string;
  schema: unknown;
}

export interface ConsentStatusByIdentifierParams {
  network: string;
  phone?: string;
  email?: string;
}

export async function fetchConsentConfigs(networkId: string): Promise<ConsentConfigEntry[]> {
  const response = await apiClient.get<RawSchemaEntry[]>('/api/v1/network/schemas', {
    params: { network: networkId },
  });
  return response.data
    .filter((e) => e.kind === 'consent_config')
    .map((e) => ({ brand: e.brand ?? null, schema: e.schema as ConsentConfigDocument }));
}

export async function getConsentStatus(networkId: string): Promise<ConsentStatusResponse> {
  const response = await apiClient.get<ConsentStatusResponse>('/api/v1/consent/status', {
    params: { network: networkId },
  });
  return response.data;
}

export async function getConsentStatusByIdentifier(
  params: ConsentStatusByIdentifierParams,
): Promise<ConsentStatusResponse> {
  const response = await apiClient.get<ConsentStatusResponse>(
    '/api/v1/consent/status-by-identifier',
    { params },
  );
  return response.data;
}

export async function acceptConsent(body: ConsentAcceptBody): Promise<ConsentAcceptResponse> {
  const response = await apiClient.post<ConsentAcceptResponse>('/api/v1/consent/accept', body);
  return response.data;
}

export async function getProfileConsentStatus(
  networkId: string,
): Promise<ProfileConsentStatusResponse> {
  const response = await apiClient.get<ProfileConsentStatusResponse>(
    '/api/v1/consent/profile-status',
    { params: { network: networkId } },
  );
  return response.data;
}

export async function acceptProfileConsent(
  body: ProfileConsentAcceptBody,
): Promise<{ recorded: number }> {
  const response = await apiClient.post<{ recorded: number }>(
    '/api/v1/consent/profile-accept',
    body,
  );
  return response.data;
}

// ─── U18 guardian consent flow ──────────────────────────────────────

export interface SubmitU18DobBody {
  network: string;
  birthYear: number;
  birthMonth: number;
}

export interface SubmitU18DobResponse {
  isMinor: boolean;
}

export type GuardianContactType = 'phone' | 'email';

export interface SubmitGuardianBody {
  network: string;
  brand?: string | null;
  guardianName: string;
  guardianContact: string;
  guardianContactType: GuardianContactType;
  guardianDeclarationAccepted: true;
  sameContactAcknowledged?: boolean;
}

export interface SubmitGuardianResponse {
  otpSent: boolean;
}

export interface VerifyGuardianBody {
  network: string;
  brand?: string | null;
  otp: string;
}

export interface VerifyGuardianResponse {
  verified: boolean;
}

export interface ProfileConsentOtpItemRef {
  network: string;
  brand?: string | null;
  item_domain: string;
  item_type: string;
  item_id: string;
}

export interface IssueProfileConsentOtpResponse {
  otpSent: boolean;
}

export interface VerifyProfileConsentOtpBody extends ProfileConsentOtpItemRef {
  otp: string;
}

export interface VerifyProfileConsentOtpResponse {
  verified: boolean;
  promoted: boolean;
}

export async function submitU18Dob(body: SubmitU18DobBody): Promise<SubmitU18DobResponse> {
  const response = await apiClient.post<SubmitU18DobResponse>('/api/v1/consent/u18/dob', body);
  return response.data;
}

export async function submitGuardian(body: SubmitGuardianBody): Promise<SubmitGuardianResponse> {
  const response = await apiClient.post<SubmitGuardianResponse>(
    '/api/v1/consent/u18/guardian',
    body,
  );
  return response.data;
}

export async function verifyGuardian(body: VerifyGuardianBody): Promise<VerifyGuardianResponse> {
  const response = await apiClient.post<VerifyGuardianResponse>(
    '/api/v1/consent/u18/guardian/verify',
    body,
  );
  return response.data;
}

// --- Pre-auth, signup-scoped guardian consent (no session yet) ---
//
// Mirrors the authenticated submit/verify pair, but the account doesn't exist
// yet: the body carries the ward's own signup identifier (email OR phone) plus
// the network/domain and birth month/year the server needs to (re-)confirm the
// ward is a gated minor. Backed by public routes POST /u18/signup/guardian
// and /u18/signup/guardian/verify (services/signup_guardian.ts).

export interface StartSignupGuardianBody {
  network: string;
  domain: string;
  email?: string;
  phoneNumber?: string;
  birthYear: number;
  birthMonth: number;
  guardianName: string;
  guardianContact: string;
  guardianContactType: GuardianContactType;
  guardianDeclarationAccepted: true;
  sameContactAcknowledged?: boolean;
}

export interface VerifySignupGuardianBody {
  network?: string;
  email?: string;
  phoneNumber?: string;
  otp: string;
}

export async function startSignupGuardian(
  body: StartSignupGuardianBody,
): Promise<SubmitGuardianResponse> {
  const response = await apiClient.post<SubmitGuardianResponse>(
    '/api/v1/consent/u18/signup/guardian',
    body,
  );
  return response.data;
}

export async function verifySignupGuardian(
  body: VerifySignupGuardianBody,
): Promise<VerifyGuardianResponse> {
  const response = await apiClient.post<VerifyGuardianResponse>(
    '/api/v1/consent/u18/signup/guardian/verify',
    body,
  );
  return response.data;
}

export async function issueProfileConsentOtp(
  body: ProfileConsentOtpItemRef,
): Promise<IssueProfileConsentOtpResponse> {
  const response = await apiClient.post<IssueProfileConsentOtpResponse>(
    '/api/v1/consent/u18/profile-consent/issue',
    body,
  );
  return response.data;
}

export async function verifyProfileConsentOtp(
  body: VerifyProfileConsentOtpBody,
): Promise<VerifyProfileConsentOtpResponse> {
  const response = await apiClient.post<VerifyProfileConsentOtpResponse>(
    '/api/v1/consent/u18/profile-consent/verify',
    body,
  );
  return response.data;
}
