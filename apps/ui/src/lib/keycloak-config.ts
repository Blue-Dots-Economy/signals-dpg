/**
 * Keycloak / OIDC configuration for the UI login flow (Build 2 of
 * docs/superpowers/plans/2026-07-23-keycloak-migration-design.md).
 *
 * **The server decides which login screen to show.** These values come from
 * `GET /api/v1/auth/config` at runtime, not from `VITE_*` build args.
 *
 * They used to be build args, and that was a footgun: the login screen was
 * compiled into the image, so flipping providers needed a rebuild — and a
 * bundle built with `keycloak` against an API running `betterauth` sent every
 * user into an OIDC redirect the API knew nothing about, while the OTP
 * endpoints were never called at all. Reading the API's own config makes that
 * disagreement impossible and removes the rebuild.
 *
 * `VITE_AUTH_PROVIDER` survives only as a deliberate **override** for a UI-side
 * canary (rollout step R5), where the API runs `dual` and you want a subset of
 * traffic on the new screen. It is read through `getRuntimeEnv`, so it can be
 * set per-deployment in `window.__DPG_UI_CONFIG__` without a rebuild either.
 * Unset — the normal case — the server wins.
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
  /** OIDC issuer — matches the API's expected issuer, since both derive from
   *  the same server config. */
  authority: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  /** Extra scopes beyond `openid profile email`, space-separated. */
  scope: string;
}

/** Path the Keycloak redirect lands on. Must be registered on the client. */
export const OIDC_CALLBACK_PATH = '/auth/callback';

/**
 * Explicit UI-side override, if a deployment set one. Returns undefined in the
 * normal case, meaning "follow the server".
 */
export function getAuthProviderOverride(): UiAuthProvider | undefined {
  const raw = readEnv('VITE_AUTH_PROVIDER');
  if (raw === 'keycloak') return 'keycloak';
  if (raw === 'betterauth') return 'betterauth';
  return undefined;
}

/**
 * Which login screen to render, given the server's auth config.
 *
 * `dual` maps to the OTP screen deliberately: it means the API accepts Keycloak
 * tokens *alongside* better-auth sessions, which is the transition state where
 * existing users must keep logging in the old way. Only `keycloak` — the
 * terminal state — switches the screen. A canary can force it sooner with the
 * override above.
 */
export function resolveUiAuthProvider(
  config: AuthConfigResponse | null | undefined
): UiAuthProvider {
  const override = getAuthProviderOverride();
  if (override) return override;
  return config?.authProvider === 'keycloak' ? 'keycloak' : 'betterauth';
}

/**
 * Build the OIDC client config from the server's advertised Keycloak details.
 *
 * Returns null when the server isn't advertising Keycloak — a deployment that
 * has not configured it must keep the working OTP login rather than render a
 * button that redirects nowhere. `VITE_KEYCLOAK_*` still override individual
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

  // window is always present in the app, but this module is imported by tests
  // and by the tourist entry point, so don't assume it.
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

/**
 * True only when the resolved provider is Keycloak AND there is a usable OIDC
 * config to redirect to. A half-configured deployment keeps the OTP login.
 */
export function isKeycloakLoginEnabled(
  config: AuthConfigResponse | null | undefined
): boolean {
  return resolveUiAuthProvider(config) === 'keycloak' && getKeycloakConfig(config) !== null;
}
