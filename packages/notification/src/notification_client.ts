import { createNotificationAuthHeaders } from './create_auth_headers';
import type { NotifyRequest } from './notification.types';

export interface NotificationClientConfig {
  baseUrl: string;
  keyId: string;
  secret: string;
}

/**
 * Client for communicating with the Notification Service.
 */
export class NotificationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly keyId: string,
    private readonly secret: string
  ) {}

  /**
   * Send a notification.
   *
   * The caller is responsible for:
   * - Fetching providers via `/providers`
   * - Selecting a valid `channel`
   * - Selecting a valid `template_id`
   * - Ensuring `variables` match the provider schema
   *
   * @typeParam TVariables - Variables schema for the selected channel
   *
   * @param payload - Notification request payload
   *
   * @example
   * ```ts
   * await notificationClient.notify({
   *   channel: 'email',
   *   template_id: 'basic_email',
   *   to: 'uja@dway.com',
   *   priority: 'realtime',
   *   variables: {
   *     fromName: 'Notification Service Demo',
   *     fromEmail: 'hello@bluedotseconomy.org',
   *     subject: 'Welcome!',
   *     html: '<h1>Hello</h1>',
   *   },
   * });
   * ```
   *
   * @throws Error if the notification service responds with a non-2xx status
   */
  async notify<TVariables extends Record<string, unknown>>(
    payload: NotifyRequest<TVariables>
  ): Promise<void> {
    const path = '/notify';
    const url = new URL(path, this.baseUrl);

    const headers = createNotificationAuthHeaders(
      { method: 'POST', path },
      { keyId: this.keyId, secret: this.secret }
    );

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(
        `Notification service error ${res.status}: ${await res.text()}`
      );
    }
  }

  /**
   * Fetch available notification providers and their schemas.
   */
  async getProviders(): Promise<unknown[]> {
    const path = '/providers';
    const url = new URL(path, this.baseUrl);

    const headers = createNotificationAuthHeaders(
      { method: 'GET', path },
      { keyId: this.keyId, secret: this.secret }
    );

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(
        `Notification service error ${res.status}: ${await res.text()}`
      );
    }

    return res.json() as Promise<unknown[]>;
  }
}

/**
 * Create a notification client with the given config.
 * Use this in apps, e.g. from env: createNotificationClient({ baseUrl: process.env.NOTIFICATION_SERVICE_ENDPOINT!, keyId: process.env.NOTIFICATION_SERVICE_KEY_ID!, secret: process.env.NOTIFICATION_SERVICE_SECRET! })
 */
export function createNotificationClient(config: NotificationClientConfig): NotificationClient {
  return new NotificationClient(
    config.baseUrl,
    config.keyId,
    config.secret
  );
}
