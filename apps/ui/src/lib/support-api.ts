import { createApiClient } from './api-client';

const apiClient = createApiClient();

export interface SupportSubmission {
  subject?: string;
  message: string;
}

export async function submitSupport(input: SupportSubmission): Promise<void> {
  await apiClient.post('/api/v1/support', {
    ...(input.subject ? { subject: input.subject } : {}),
    message: input.message,
  });
}
