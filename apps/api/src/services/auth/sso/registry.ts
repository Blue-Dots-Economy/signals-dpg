import { ssoConfig } from '@/config';
import { createNcsClient } from '@/services/auth/sso/ncs_client';
import { createNcsProvider, NCS_PROVIDER_ID } from '@/services/auth/sso/providers/ncs';
import { createOidcKeys, type OidcKeys } from '@/services/auth/sso/oidc_keys';
import type { SsoProfileMapping } from '@/services/auth/sso/sso_profile_bootstrap';
import type { SsoProvider } from '@/services/auth/sso/types';

/**
 * The SSO provider this instance serves, or null when SSO is off.
 *
 * One provider per instance: the entry URL (`/api/v1/auth/sso/login`) names no
 * partner, so the instance's configuration decides who it is for. Supporting
 * several partners on one instance would add an opaque per-partner key to the
 * URL; nothing needs that yet.
 */
let active: SsoProvider | null | undefined;

export function getActiveSsoProvider(): SsoProvider | null {
  if (active !== undefined) return active;
  active = null;
  if (!ssoConfig.enabled) return active;

  if (ssoConfig.providers[0] === NCS_PROVIDER_ID) {
    active = createNcsProvider({
      clientSecret: ssoConfig.ncs.client_secret,
      mapping: ssoConfig.ncs.mapping,
      client: createNcsClient({
        baseUrl: ssoConfig.ncs.base_url,
        clientId: ssoConfig.ncs.client_id,
        clientSecret: ssoConfig.ncs.client_secret,
        timeoutMs: ssoConfig.ncs.timeout_ms,
      }),
    });
  }
  return active;
}

/** Profile-bootstrap mapping for a provider, or null when it has none. */
export function getSsoProfileMapping(providerId: string): SsoProfileMapping | null {
  return providerId === NCS_PROVIDER_ID ? ssoConfig.ncs.mapping : null;
}

let oidcKeys: OidcKeys | null = null;

/** The id_token signing key. Only called once SSO is known to be enabled. */
export function getSsoOidcKeys(): OidcKeys {
  oidcKeys ??= createOidcKeys(ssoConfig.oidc.signing_key_pem);
  return oidcKeys;
}

/** Test seam. */
export function resetSsoProviderRegistry(): void {
  active = undefined;
  oidcKeys = null;
}
