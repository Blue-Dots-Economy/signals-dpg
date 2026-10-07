import {
  NotificationClient,
  createClientCredentialsTokenSource,
  type TokenSource,
} from '@dpg/notification';
import { keycloakConfig, notification } from '@/config';

let tokens: TokenSource | undefined;
let client: NotificationClient | undefined;

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
export const getNotificationClient = (): NotificationClient | undefined => {
  if (client) return client;

  const endpoint = notification.NOTIFICATION_SERVICE_ENDPOINT;
  const clientSecret = keycloakConfig.api_client_secret;
  if (!endpoint || !clientSecret) return undefined;

  tokens ??= createClientCredentialsTokenSource({
    tokenUrl: `${keycloakConfig.internal_base_url}/realms/${keycloakConfig.realm}/protocol/openid-connect/token`,
    clientId: keycloakConfig.api_client_id,
    clientSecret,
  });
  client = new NotificationClient({ baseUrl: endpoint, tokens });
  return client;
};
