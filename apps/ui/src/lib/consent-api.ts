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
