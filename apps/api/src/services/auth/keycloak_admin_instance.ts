import { keycloakConfig } from '@/config';
import { KeycloakAdminClient } from '@/services/auth/keycloak_admin';

/**
 * The process-wide Keycloak Admin-REST client, authenticated as the
 * `signals-api` service account.
 *
 * One instance so its cached admin token is shared by every caller (self
 * signup, participant onboarding, SSO account linking) rather than each
 * module minting its own.
 */
let adminClient: KeycloakAdminClient | null = null;

/** Null when the API has no Admin-REST credentials configured. */
export function getKeycloakAdminClient(): KeycloakAdminClient | null {
  if (adminClient) return adminClient;
  if (!keycloakConfig.internal_base_url || !keycloakConfig.api_client_secret) {
    return null;
  }
  adminClient = new KeycloakAdminClient({
    baseUrl: keycloakConfig.internal_base_url,
    realm: keycloakConfig.realm,
    clientId: keycloakConfig.api_client_id,
    clientSecret: keycloakConfig.api_client_secret,
  });
  return adminClient;
}

/** Test seam: forget the memoised client. */
export function resetKeycloakAdminClient(): void {
  adminClient = null;
}
