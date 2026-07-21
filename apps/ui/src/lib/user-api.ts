import { createApiClient } from './api-client';

const apiClient = createApiClient();

/** Domain roles the user may create profiles in (persisted at signup). */
export async function getUserDomains(): Promise<string[]> {
  const response = await apiClient.get<{ domains: string[] }>('/api/v1/user/domains');
  return response.data.domains;
}

export async function setUserDomains(domains: string[]): Promise<string[]> {
  const response = await apiClient.post<{ domains: string[] }>('/api/v1/user/domains', { domains });
  return response.data.domains;
}
