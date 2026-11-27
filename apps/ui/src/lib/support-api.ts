import { createApiClient } from './api-client';

const apiClient = createApiClient();

export type SupportType = 'complaint' | 'support_request';

/** One attachment, base64-encoded for the JSON body. */
export interface SupportAttachment {
  filename: string;
  contentType: string;
  /** Base64 without the `data:` prefix. */
  data: string;
}

export interface SupportSubmission {
  name: string;
  email?: string;
  phone?: string;
  type: SupportType;
  details: string;
  consent: true;
  attachments?: SupportAttachment[];
}

/**
 * What this instance's support form may submit. Served by the API so limits
 * change without a UI rebuild and the form cannot disagree with the server.
 */
export interface SupportConfig {
  enabled: boolean;
  maxTotalBytes: number;
  maxFiles: number;
  allowedTypes: string[];
  /**
   * Extensions for the picker's `accept`, because macOS will not match `.m4a`
   * against `audio/mp4`. Optional so the UI tolerates an API that omits it.
   */
  allowedExtensions?: string[];
}

export async function fetchSupportConfig(): Promise<SupportConfig> {
  const { data } = await apiClient.get<SupportConfig>('/api/v1/support/config');
  return data;
}

export async function submitSupport(input: SupportSubmission): Promise<void> {
  await apiClient.post('/api/v1/support', {
    name: input.name,
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    type: input.type,
    details: input.details,
    consent: input.consent,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
}
