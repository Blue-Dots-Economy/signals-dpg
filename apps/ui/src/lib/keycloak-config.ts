/**
 * Keycloak / OIDC configuration for the UI login flow.
 *
 * The server decides which login screen to show: these values come from
 * `GET /api/v1/auth/config` at runtime, not from `VITE_*` build args, so the
 * bundle can never disagree with the API's provider. The API only advertises
 * `keycloak`. `VITE_AUTH_PROVIDER` (read through `getRuntimeEnv`) is an
 * override; set to `betterauth` it forces the legacy OTP screen, whose
 * `/api/auth/*` endpoints the API no longer serves.
 */

import { getRuntimeEnv } from './runtime-env';
import type { AuthConfigResponse } from './auth-api';

export type UiAuthProvider = 'betterauth' | 'keycloak';

function readEnv(key: keyof ImportMetaEnv): string | undefined {
  const value = getRuntimeEnv(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface KeycloakUiConfig {
  /** Browser-facing Keycloak base URL, e.g. http://localhost:8080 (or …/auth). */
  baseUrl: string;
  realm: string;
  clientId: string;
  /** OIDC issuer; matches the API's expected issuer since both derive from the same config. */
  authority: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  /** Extra scopes beyond `openid profile email`, space-separated. */
  scope: string;
}

/** Path the Keycloak redirect lands on. Must be registered on the client. */
export const OIDC_CALLBACK_PATH = '/auth/callback';

/** Explicit UI-side override, or undefined to follow the server. */
export function getAuthProviderOverride(): UiAuthProvider | undefined {
  const raw = readEnv('VITE_AUTH_PROVIDER');
  if (raw === 'keycloak') return 'keycloak';
  if (raw === 'betterauth') return 'betterauth';
  return undefined;
}

/**
 * Which login screen to render. Anything other than `keycloak` from the server
 * (or an absent config) maps to the legacy OTP screen; the override wins.
 */
export function resolveUiAuthProvider(
  config: AuthConfigResponse | null | undefined
): UiAuthProvider {
  const override = getAuthProviderOverride();
  if (override) return override;
  return config?.authProvider === 'keycloak' ? 'keycloak' : 'betterauth';
}

/**
 * Builds the OIDC client config from the server's advertised Keycloak details.
 * Returns null when the server advertises none, in which case the login page
 * falls back to the legacy OTP screen. `VITE_KEYCLOAK_*` override individual
 * values for local experiments.
 */
export function getKeycloakConfig(
  config: AuthConfigResponse | null | undefined
): KeycloakUiConfig | null {
  const baseUrl = (readEnv('VITE_KEYCLOAK_URL') ?? config?.keycloak?.url)?.replace(/\/$/, '');
  if (!baseUrl) return null;

  const realm = readEnv('VITE_KEYCLOAK_REALM') ?? config?.keycloak?.realm ?? 'bluedots';
  const clientId =
    readEnv('VITE_KEYCLOAK_CLIENT_ID') ?? config?.keycloak?.clientId ?? 'signals-ui';

  // This module is also imported by tests and the tourist entry, so `window` may be absent.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return {
    baseUrl,
    realm,
    clientId,
    authority: `${baseUrl}/realms/${realm}`,
    redirectUri: `${origin}${OIDC_CALLBACK_PATH}`,
    postLogoutRedirectUri: `${origin}/`,
    scope: readEnv('VITE_KEYCLOAK_SCOPE') ?? 'openid profile email',
  };
}

/** True only when the resolved provider is Keycloak and an OIDC config exists. */
export function isKeycloakLoginEnabled(
  config: AuthConfigResponse | null | undefined
): boolean {
  return resolveUiAuthProvider(config) === 'keycloak' && getKeycloakConfig(config) !== null;
}
