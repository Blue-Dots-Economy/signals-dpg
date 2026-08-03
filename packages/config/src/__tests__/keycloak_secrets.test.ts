import { describe, it, expect } from 'vitest';
import {
  AuthSecretsSchema,
  KeycloakSecretsSchema,
  assertAuthProviderSupported,
  assertKeycloakConfigured,
  parseKeycloakAcceptedClientIds,
} from '../secrets.js';
import { ConfigError } from '../config_error.js';

const REQUIRED_AUTH = { AUTH_SECRET: 'a-secret-long-enough' };

describe('AUTH_PROVIDER', () => {
  it('defaults to betterauth so merging the build track changes nothing', () => {
    expect(AuthSecretsSchema.parse(REQUIRED_AUTH).AUTH_PROVIDER).toBe('betterauth');
  });

  it.each(['betterauth', 'keycloak'] as const)('accepts %s', (mode) => {
    expect(
      AuthSecretsSchema.parse({ ...REQUIRED_AUTH, AUTH_PROVIDER: mode }).AUTH_PROVIDER
    ).toBe(mode);
  });

  it('rejects the removed dual mode', () => {
    // Not merely unsupported — it used to be valid, so an instance may still be
    // configured with it. The schema must refuse it rather than coerce.
    expect(() =>
      AuthSecretsSchema.parse({ ...REQUIRED_AUTH, AUTH_PROVIDER: 'dual' })
    ).toThrow();
  });

  it('explains what to do when an instance is still set to dual', () => {
    // Zod's own enum error says only "Invalid input", which tells an operator
    // nothing about the user migration that is now a prerequisite.
    expect(() => assertAuthProviderSupported('dual')).toThrow(ConfigError);
    expect(() => assertAuthProviderSupported('dual')).toThrow(/has been removed/);
    expect(() => assertAuthProviderSupported('dual')).toThrow(/keycloak:migrate:users/);
  });

  it.each([undefined, 'betterauth', 'keycloak'])('allows %s through', (value) => {
    expect(() => assertAuthProviderSupported(value)).not.toThrow();
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
    expect(parsed.KEYCLOAK_ACCEPTED_CLIENT_IDS).toBe('signals-ui');
    expect(parsed.KEYCLOAK_JWKS_CACHE_MAX_AGE_MS).toBe(600_000);
    expect(parsed.KEYCLOAK_CLOCK_TOLERANCE_SECONDS).toBe(30);
  });

  it('keeps signals-api off the human session allowlist by default', () => {
    // signals-api is the API's own Admin-REST service client. It is rejected on
    // the service path (not an integrating DPG), so listing it here would have
    // made the one client that can mint its own token a valid human session too.
    const parsed = KeycloakSecretsSchema.parse({});
    expect(parseKeycloakAcceptedClientIds(parsed.KEYCLOAK_ACCEPTED_CLIENT_IDS)).toEqual([
      'signals-ui',
    ]);
  });

  it('requires a signals realm role on the human path by default', () => {
    // Defence in depth for the shared realm: the client allowlist rests on
    // azp/aud, which an aggregator client with an aud mapper could satisfy.
    const parsed = KeycloakSecretsSchema.parse({});
    expect(parseKeycloakAcceptedClientIds(parsed.KEYCLOAK_REQUIRED_REALM_ROLES)).toEqual([
      'signals_participant',
      'signals_admin',
    ]);
  });

  it('treats an empty required-roles list as the documented opt-out', () => {
    const parsed = KeycloakSecretsSchema.parse({ KEYCLOAK_REQUIRED_REALM_ROLES: '' });
    expect(parseKeycloakAcceptedClientIds(parsed.KEYCLOAK_REQUIRED_REALM_ROLES)).toEqual([]);
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

  it.each(['keycloak'] as const)(
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

  it.each(['keycloak'] as const)(
    'throws on %s when the accepted-client list is empty',
    (mode) => {
      expect(() =>
        assertKeycloakConfigured(mode, { ...configured, KEYCLOAK_ACCEPTED_CLIENT_IDS: '  ' })
      ).toThrow(/KEYCLOAK_ACCEPTED_CLIENT_IDS/);
    }
  );

  it.each(['keycloak'] as const)('passes on %s when configured', (mode) => {
    expect(() => assertKeycloakConfigured(mode, configured)).not.toThrow();
  });
});
