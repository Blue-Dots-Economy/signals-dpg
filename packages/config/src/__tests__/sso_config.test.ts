import { describe, it, expect } from 'vitest';
import { SsoSecretsSchema } from '../secrets.js';
import {
  assertSsoConfigured,
  parseSsoNcsMapping,
  parseSsoProviders,
} from '../sso_config.js';
import { ConfigError } from '../config_error.js';

const NCS_READY = {
  SSO_PROVIDERS: 'ncs',
  SSO_OIDC_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  SSO_OIDC_CLIENT_SECRET: 'kc-broker-secret-kc-broker-secret',
  SSO_NCS_BASE_URL: 'https://ncs.example.gov.in',
  SSO_NCS_CLIENT_ID: 'bluedots-abc',
  SSO_NCS_CLIENT_SECRET: 'x'.repeat(64),
};

describe('SsoSecretsSchema', () => {
  it('is fully optional so SSO lands inert', () => {
    const parsed = SsoSecretsSchema.parse({});
    expect(parsed.SSO_PROVIDERS).toBe('');
    expect(parsed.SSO_OIDC_CLIENT_ID).toBe('signals-sso');
    expect(parsed.SSO_NCS_TIMEOUT_MS).toBe(5000);
    expect(parsed.SSO_NCS_MAPPING).toBe('{}');
  });
});

describe('parseSsoProviders', () => {
  it('returns [] for an empty value', () => {
    expect(parseSsoProviders('')).toEqual([]);
  });

  it('trims, lowercases and de-duplicates', () => {
    expect(parseSsoProviders(' NCS, ncs ')).toEqual(['ncs']);
  });

  it('rejects an unknown provider rather than silently ignoring it', () => {
    expect(() => parseSsoProviders('ncs,google')).toThrow(ConfigError);
  });
});

describe('parseSsoNcsMapping', () => {
  it('applies defaults to an empty object', () => {
    const m = parseSsoNcsMapping('{}');
    expect(m.item_type).toBe('profile_1.0');
    expect(m.role_to_domain).toEqual({});
    expect(m.fields).toEqual({});
    expect(m.feature_routes).toEqual({});
  });

  it('rejects invalid JSON with a ConfigError', () => {
    expect(() => parseSsoNcsMapping('{nope')).toThrow(ConfigError);
  });

  it('accepts a full mapping', () => {
    const m = parseSsoNcsMapping(
      JSON.stringify({
        network: 'blue_dot',
        role_to_domain: { JOBSEEKER: 'seeker' },
        fields: { fullName: 'name' },
        feature_routes: { 'placement-prep': '/discover' },
        app_origin: 'https://app.example.org',
      })
    );
    expect(m.role_to_domain.JOBSEEKER).toBe('seeker');
    expect(m.feature_routes['placement-prep']).toBe('/discover');
  });
});

describe('assertSsoConfigured', () => {
  it('is a no-op when no provider is enabled', () => {
    expect(() =>
      assertSsoConfigured('betterauth', SsoSecretsSchema.parse({}))
    ).not.toThrow();
  });

  it('requires AUTH_PROVIDER=keycloak', () => {
    expect(() =>
      assertSsoConfigured('betterauth', SsoSecretsSchema.parse(NCS_READY))
    ).toThrow(/AUTH_PROVIDER=keycloak/);
  });

  it('passes when every NCS secret is set', () => {
    expect(() =>
      assertSsoConfigured('keycloak', SsoSecretsSchema.parse(NCS_READY))
    ).not.toThrow();
  });

  it.each([
    'SSO_OIDC_SIGNING_KEY',
    'SSO_OIDC_CLIENT_SECRET',
    'SSO_NCS_BASE_URL',
    'SSO_NCS_CLIENT_ID',
    'SSO_NCS_CLIENT_SECRET',
  ] as const)('fails boot when %s is missing', (key) => {
    const env = { ...NCS_READY, [key]: undefined };
    expect(() => assertSsoConfigured('keycloak', SsoSecretsSchema.parse(env))).toThrow(
      new RegExp(key)
    );
  });

  it('rejects a short OIDC client secret', () => {
    const env = { ...NCS_READY, SSO_OIDC_CLIENT_SECRET: 'short' };
    expect(() => assertSsoConfigured('keycloak', SsoSecretsSchema.parse(env))).toThrow(
      /SSO_OIDC_CLIENT_SECRET/
    );
  });

  it('rejects an invalid mapping at boot', () => {
    const env = { ...NCS_READY, SSO_NCS_MAPPING: '{nope' };
    expect(() => assertSsoConfigured('keycloak', SsoSecretsSchema.parse(env))).toThrow(
      ConfigError
    );
  });
});
