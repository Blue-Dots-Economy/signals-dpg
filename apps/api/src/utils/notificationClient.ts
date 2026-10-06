import {
  NotificationClient,
  createClientCredentialsTokenSource,
  type TokenSource,
} from '@dpg/notification';
import { keycloakConfig, notification } from '@/config';

/**
 * Transitional: the senders still call the legacy `notify(payload)` until they
 * move to `send(event)` (Plan F2, Tasks 4–5), which deletes this subclass. It
 * keeps those call sites compiling; calling it fails loudly rather than
 * silently dropping a notification.
 *
 * @deprecated Use `send(event)`.
 */
export class TransitionalNotificationClient extends NotificationClient {
  /** @deprecated Use `send(event)`. */
  notify(_payload: unknown): Promise<never> {
    return Promise.reject(
      new Error(
        'NotificationClient.notify() was removed: senders move to send(event) in Plan F2 Tasks 4–5'
      )
    );
  }
}

let tokens: TokenSource | undefined;
let client: TransitionalNotificationClient | undefined;

/**
 * The notification-service client, or undefined when it is not configured.
 *
 * Required configuration:
 * - NOTIFICATION_SERVICE_ENDPOINT
 * - KEYCLOAK_API_CLIENT_SECRET (with KEYCLOAK_API_CLIENT_ID, KEYCLOAK_REALM and
 *   the Keycloak base URL), for the `client_credentials` bearer token
 *
 * The client and its token source are built once per process, so every sender
 * shares one cached token.
 */
export const getNotificationClient = (): TransitionalNotificationClient | undefined => {
  if (client) return client;

  const endpoint = notification.NOTIFICATION_SERVICE_ENDPOINT;
  const clientSecret = keycloakConfig.api_client_secret;
  if (!endpoint || !clientSecret) return undefined;

  tokens ??= createClientCredentialsTokenSource({
    tokenUrl: `${keycloakConfig.internal_base_url}/realms/${keycloakConfig.realm}/protocol/openid-connect/token`,
    clientId: keycloakConfig.api_client_id,
    clientSecret,
  });
  client = new TransitionalNotificationClient({ baseUrl: endpoint, tokens });
  return client;
};
