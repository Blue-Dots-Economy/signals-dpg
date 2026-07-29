import { describe, it, expect } from 'vitest';
import {
  AuthSecretsSchema,
  KeycloakSecretsSchema,
  assertKeycloakConfigured,
  parseKeycloakAcceptedClientIds,
} from '../secrets.js';
import { ConfigError } from '../config_error.js';

const REQUIRED_AUTH = { AUTH_SECRET: 'a-secret-long-enough' };

describe('AUTH_PROVIDER', () => {
  it('defaults to betterauth so merging the build track changes nothing', () => {
    expect(AuthSecretsSchema.parse(REQUIRED_AUTH).AUTH_PROVIDER).toBe('betterauth');
  });

  it.each(['betterauth', 'dual', 'keycloak'] as const)('accepts %s', (mode) => {
    expect(
      AuthSecretsSchema.parse({ ...REQUIRED_AUTH, AUTH_PROVIDER: mode }).AUTH_PROVIDER
    ).toBe(mode);
  });

  it('rejects an unknown provider rather than silently falling back', () => {
    expect(() =>
      AuthSecretsSchema.parse({ ...REQUIRED_AUTH, AUTH_PROVIDER: 'oidc' })
    ).toThrow();
  });
});

describe('KeycloakSecretsSchema', () => {
  it('parses with nothing set, so the API still boots on better-auth', () => {
    const parsed = KeycloakSecretsSchema.parse({});
    expect(parsed.KEYCLOAK_BASE_URL).toBeUndefined();
    expect(parsed.KEYCLOAK_REALM).toBe('bluedots');
    expect(parsed.KEYCLOAK_UI_CLIENT_ID).toBe('signals-ui');
    expect(parsed.KEYCLOAK_API_CLIENT_ID).toBe('signals-api');
    expect(parsed.KEYCLOAK_ACCEPTED_CLIENT_IDS).toBe('signals-ui,signals-api');
    expect(parsed.KEYCLOAK_JWKS_CACHE_MAX_AGE_MS).toBe(600_000);
    expect(parsed.KEYCLOAK_CLOCK_TOLERANCE_SECONDS).toBe(30);
  });

  it('defaults the service-client allowlist to empty', () => {
    // Service auth stays on x-api-key until an operator explicitly names the
    // integrating DPGs' Keycloak clients.
    const parsed = KeycloakSecretsSchema.parse({});
    expect(parsed.KEYCLOAK_SERVICE_CLIENT_IDS).toBe('');
    expect(parseKeycloakAcceptedClientIds(parsed.KEYCLOAK_SERVICE_CLIENT_IDS)).toEqual([]);
  });

  it('coerces the numeric knobs from env strings', () => {
    const parsed = KeycloakSecretsSchema.parse({
      KEYCLOAK_JWKS_CACHE_MAX_AGE_MS: '60000',
      KEYCLOAK_CLOCK_TOLERANCE_SECONDS: '0',
    });
    expect(parsed.KEYCLOAK_JWKS_CACHE_MAX_AGE_MS).toBe(60_000);
    expect(parsed.KEYCLOAK_CLOCK_TOLERANCE_SECONDS).toBe(0);
  });

  it('rejects a non-positive JWKS cache age', () => {
    expect(() =>
      KeycloakSecretsSchema.parse({ KEYCLOAK_JWKS_CACHE_MAX_AGE_MS: '0' })
    ).toThrow();
  });
});

describe('parseKeycloakAcceptedClientIds', () => {
  it('splits, trims and de-duplicates', () => {
    expect(parseKeycloakAcceptedClientIds(' signals-ui , signals-api ,signals-ui')).toEqual(
      ['signals-ui', 'signals-api']
    );
  });

  it('returns an empty list for blank input', () => {
    expect(parseKeycloakAcceptedClientIds('')).toEqual([]);
    expect(parseKeycloakAcceptedClientIds(' , , ')).toEqual([]);
  });
});

describe('assertKeycloakConfigured', () => {
  const configured = {
    KEYCLOAK_BASE_URL: 'http://localhost:8080',
    KEYCLOAK_ACCEPTED_CLIENT_IDS: 'signals-ui,signals-api',
  };

  it('is a no-op on betterauth even with nothing configured', () => {
    expect(() =>
      assertKeycloakConfigured('betterauth', { KEYCLOAK_ACCEPTED_CLIENT_IDS: '' })
    ).not.toThrow();
  });

  it.each(['dual', 'keycloak'] as const)(
    'throws on %s when KEYCLOAK_BASE_URL is missing',
    (mode) => {
      expect(() =>
        assertKeycloakConfigured(mode, { KEYCLOAK_ACCEPTED_CLIENT_IDS: 'signals-ui' })
      ).toThrow(ConfigError);
      expect(() =>
        assertKeycloakConfigured(mode, { KEYCLOAK_ACCEPTED_CLIENT_IDS: 'signals-ui' })
      ).toThrow(/KEYCLOAK_BASE_URL/);
    }
  );

  it.each(['dual', 'keycloak'] as const)(
    'throws on %s when the accepted-client list is empty',
    (mode) => {
      expect(() =>
        assertKeycloakConfigured(mode, { ...configured, KEYCLOAK_ACCEPTED_CLIENT_IDS: '  ' })
      ).toThrow(/KEYCLOAK_ACCEPTED_CLIENT_IDS/);
    }
  );

  it.each(['dual', 'keycloak'] as const)('passes on %s when configured', (mode) => {
    expect(() => assertKeycloakConfigured(mode, configured)).not.toThrow();
  });
});
