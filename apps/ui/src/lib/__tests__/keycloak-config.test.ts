import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthConfigResponse } from '../auth-api';

/**
 * The login-provider decision. The property that matters most is that **the
 * server decides**: this is what stopped a UI bundle built with `keycloak` from
 * redirecting users into an OIDC flow an API running `betterauth` knew nothing
 * about. `VITE_AUTH_PROVIDER` survives only as an explicit canary override.
 */

const env: Record<string, string | undefined> = {};

vi.mock('../runtime-env', () => ({
  getRuntimeEnv: (key: string) => env[key],
}));

const {
  getAuthProviderOverride,
  getKeycloakConfig,
  isKeycloakLoginEnabled,
  resolveUiAuthProvider,
  OIDC_CALLBACK_PATH,
} = await import('../keycloak-config.js');

const serverConfig = (overrides: Partial<AuthConfigResponse> = {}): AuthConfigResponse => ({
  selfSignupAllowed: true,
  loginChannels: ['phone', 'email'],
  authProvider: 'betterauth',
  keycloak: null,
  ...overrides,
});

const KC = { url: 'http://localhost:8080', realm: 'bluedots', clientId: 'signals-ui' };

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
});

describe('resolveUiAuthProvider — the server decides', () => {
  it('follows the server when it says betterauth', () => {
    expect(resolveUiAuthProvider(serverConfig())).toBe('betterauth');
  });

  it('follows the server when it says keycloak', () => {
    expect(resolveUiAuthProvider(serverConfig({ authProvider: 'keycloak' }))).toBe('keycloak');
  });


  it('defaults to betterauth before the config has loaded', () => {
    // Safe default: never strand a user on a redirect the server never asked for.
    expect(resolveUiAuthProvider(undefined)).toBe('betterauth');
    expect(resolveUiAuthProvider(null)).toBe('betterauth');
  });

  it('defaults to betterauth against an older API that omits authProvider', () => {
    expect(resolveUiAuthProvider(serverConfig({ authProvider: undefined }))).toBe('betterauth');
  });
});

describe('VITE_AUTH_PROVIDER override (R5 canary)', () => {
  it('is undefined when unset — the normal case', () => {
    expect(getAuthProviderOverride()).toBeUndefined();
  });

  it('can force keycloak ahead of the server', () => {
    env.VITE_AUTH_PROVIDER = 'keycloak';
    expect(resolveUiAuthProvider(serverConfig({ authProvider: 'betterauth' }))).toBe('keycloak');
  });

  it('can force betterauth even when the server says keycloak', () => {
    env.VITE_AUTH_PROVIDER = 'betterauth';
    expect(resolveUiAuthProvider(serverConfig({ authProvider: 'keycloak' }))).toBe('betterauth');
  });

  it('ignores an unrecognised or blank value and defers to the server', () => {
    env.VITE_AUTH_PROVIDER = 'oidc';
    expect(resolveUiAuthProvider(serverConfig({ authProvider: 'keycloak' }))).toBe('keycloak');
    env.VITE_AUTH_PROVIDER = '   ';
    expect(resolveUiAuthProvider(serverConfig())).toBe('betterauth');
  });
});

describe('getKeycloakConfig', () => {
  it('is null when the server advertises no Keycloak', () => {
    expect(getKeycloakConfig(serverConfig())).toBeNull();
  });

  it('derives the issuer and redirect from the server-advertised details', () => {
    const config = getKeycloakConfig(serverConfig({ authProvider: 'keycloak', keycloak: KC }));

    expect(config).not.toBeNull();
    // Derived from the same server config the API validates `iss` against, so
    // the two cannot drift.
    expect(config?.authority).toBe('http://localhost:8080/realms/bluedots');
    expect(config?.clientId).toBe('signals-ui');
    expect(config?.scope).toBe('openid profile email');
    expect(config?.redirectUri).toBe(`${window.location.origin}${OIDC_CALLBACK_PATH}`);
    expect(config?.postLogoutRedirectUri).toBe(`${window.location.origin}/`);
  });

  it('strips a trailing slash so the issuer has no double slash', () => {
    const config = getKeycloakConfig(
      serverConfig({ keycloak: { ...KC, url: 'http://localhost:8080/' } })
    );
    expect(config?.authority).toBe('http://localhost:8080/realms/bluedots');
  });

  it('keeps a relative path (Keycloak served behind /auth)', () => {
    const config = getKeycloakConfig(
      serverConfig({ keycloak: { ...KC, url: 'https://portal.example.org/auth' } })
    );
    expect(config?.authority).toBe('https://portal.example.org/auth/realms/bluedots');
  });

  it('lets VITE_KEYCLOAK_* override individual values for local experiments', () => {
    env.VITE_KEYCLOAK_URL = 'http://127.0.0.1:8089';
    env.VITE_KEYCLOAK_REALM = 'other';
    env.VITE_KEYCLOAK_CLIENT_ID = 'signals-ui-staging';
    env.VITE_KEYCLOAK_SCOPE = 'openid profile email phone';

    const config = getKeycloakConfig(serverConfig({ keycloak: KC }));

    expect(config?.authority).toBe('http://127.0.0.1:8089/realms/other');
    expect(config?.clientId).toBe('signals-ui-staging');
    expect(config?.scope).toBe('openid profile email phone');
  });

  it('works from an env override alone when the server advertises nothing', () => {
    env.VITE_KEYCLOAK_URL = 'http://localhost:8080';
    expect(getKeycloakConfig(serverConfig())?.authority).toBe(
      'http://localhost:8080/realms/bluedots'
    );
  });
});

describe('isKeycloakLoginEnabled', () => {
  it('is false for a plain betterauth instance', () => {
    expect(isKeycloakLoginEnabled(serverConfig())).toBe(false);
  });

  it('is false before the config loads', () => {
    expect(isKeycloakLoginEnabled(undefined)).toBe(false);
  });

  it('is false when the server says keycloak but advertises no details', () => {
    // Half-configured must keep the working OTP login rather than render a
    // button that cannot redirect anywhere.
    expect(isKeycloakLoginEnabled(serverConfig({ authProvider: 'keycloak' }))).toBe(false);
  });

  it('is false when details are advertised but the provider is not keycloak', () => {
    expect(
      isKeycloakLoginEnabled(serverConfig({ authProvider: 'betterauth', keycloak: KC }))
    ).toBe(false);
  });

  it('is true only when both hold', () => {
    expect(
      isKeycloakLoginEnabled(serverConfig({ authProvider: 'keycloak', keycloak: KC }))
    ).toBe(true);
  });

  it('cannot be enabled by a stale bundle alone — the regression this fixes', () => {
    // A UI built with VITE_AUTH_PROVIDER=keycloak against a betterauth API used
    // to redirect every user to Keycloak. The override still forces the screen,
    // but with no Keycloak details from either source there is nothing to
    // redirect to, so the OTP login is kept.
    env.VITE_AUTH_PROVIDER = 'keycloak';
    expect(isKeycloakLoginEnabled(serverConfig({ authProvider: 'betterauth' }))).toBe(false);
  });
});
