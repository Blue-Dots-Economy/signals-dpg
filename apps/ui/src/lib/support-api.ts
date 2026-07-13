import { createApiClient } from './api-client';

const apiClient = createApiClient();

export type SupportType = 'complaint' | 'support_request';

export interface SupportSubmission {
  name: string;
  email?: string;
  phone?: string;
  type: SupportType;
  details: string;
  consent: true;
}

export async function submitSupport(input: SupportSubmission): Promise<void> {
  await apiClient.post('/api/v1/support', {
    name: input.name,
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    type: input.type,
    details: input.details,
    consent: input.consent,
  });
}
