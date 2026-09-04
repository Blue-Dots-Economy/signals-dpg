import { describe, it, expect } from 'vitest';
import {
  ApiSecretsSchema,
  AuthSecretsSchema,
  DatabaseSecretsSchema,
  InstanceSecretsSchema,
  MatchScoreSecretsSchema,
  NetworkRuntimeSecretsSchema,
  NotificationSecretsSchema,
  OptionalSchemaRegistrySecretsSchema,
  PiiCryptoSecretsSchema,
  SchemaRegistrySecretsSchema,
  SignalsSearchSecretsSchema,
} from '../secrets.js';

describe('InstanceSecretsSchema', () => {
  it('accepts the two known environments', () => {
    expect(
      InstanceSecretsSchema.parse({ INSTANCE_NAME: 'local', INSTANCE_ENV: 'development' })
        .INSTANCE_ENV
    ).toBe('development');
    expect(
      InstanceSecretsSchema.parse({ INSTANCE_NAME: 'prod', INSTANCE_ENV: 'production' })
        .INSTANCE_ENV
    ).toBe('production');
  });

  it('rejects an unknown environment and a missing instance name', () => {
    expect(() =>
      InstanceSecretsSchema.parse({ INSTANCE_NAME: 'x', INSTANCE_ENV: 'staging' })
    ).toThrow();
    expect(() => InstanceSecretsSchema.parse({ INSTANCE_ENV: 'development' })).toThrow();
  });
});

describe('ApiSecretsSchema', () => {
  it('defaults the port to 2742 and coerces a numeric string override', () => {
    expect(ApiSecretsSchema.parse({ API_DOMAIN: 'localhost' }).API_PORT).toBe(2742);
    expect(
      ApiSecretsSchema.parse({ API_DOMAIN: 'localhost', API_PORT: '8080' }).API_PORT
    ).toBe(8080);
  });

  it('requires API_DOMAIN', () => {
    expect(() => ApiSecretsSchema.parse({})).toThrow();
  });

  it('serves the API reference by default and honours an explicit "false"', () => {
    expect(ApiSecretsSchema.parse({ API_DOMAIN: 'd' }).API_REFERENCE_ENABLED).toBe(true);
    expect(
      ApiSecretsSchema.parse({ API_DOMAIN: 'd', API_REFERENCE_ENABLED: 'false' })
        .API_REFERENCE_ENABLED
    ).toBe(false);
  });

  it('treats any value other than the exact string "true" as false', () => {
    // The transform is a strict === 'true' comparison, so casing matters.
    expect(
      ApiSecretsSchema.parse({ API_DOMAIN: 'd', API_REFERENCE_ENABLED: 'TRUE' })
        .API_REFERENCE_ENABLED
    ).toBe(false);
    expect(
      ApiSecretsSchema.parse({ API_DOMAIN: 'd', API_REFERENCE_ENABLED: '1' })
        .API_REFERENCE_ENABLED
    ).toBe(false);
  });

  it('keeps the production force-opt-in off unless explicitly enabled', () => {
    expect(ApiSecretsSchema.parse({ API_DOMAIN: 'd' }).API_REFERENCE_FORCE).toBe(false);
    expect(
      ApiSecretsSchema.parse({ API_DOMAIN: 'd', API_REFERENCE_FORCE: 'true' })
        .API_REFERENCE_FORCE
    ).toBe(true);
  });
});

describe('AuthSecretsSchema', () => {
  const base = { AUTH_SECRET: 'supersecret' };

  it('rejects an auth secret shorter than 8 characters', () => {
    expect(() => AuthSecretsSchema.parse({ AUTH_SECRET: '1234567' })).toThrow();
    expect(AuthSecretsSchema.parse({ AUTH_SECRET: '12345678' }).AUTH_SECRET).toBe('12345678');
  });

  it('enables the auth middleware by default', () => {
    expect(AuthSecretsSchema.parse(base).AUTH_MIDDLEWARE_ENABLED).toBe(true);
    expect(
      AuthSecretsSchema.parse({ ...base, AUTH_MIDDLEWARE_ENABLED: 'false' })
        .AUTH_MIDDLEWARE_ENABLED
    ).toBe(false);
  });

  it('keeps the fixed-OTP test hook off by default', () => {
    expect(AuthSecretsSchema.parse(base).CREATE_TEST_OTP).toBe(false);
    expect(
      AuthSecretsSchema.parse({ ...base, CREATE_TEST_OTP: 'true' }).CREATE_TEST_OTP
    ).toBe(true);
  });

  it('gates self-signup by default and accepts an explicit "allowed"', () => {
    expect(AuthSecretsSchema.parse(base).SELF_SIGNUP_MODE).toBe('gated');
    expect(
      AuthSecretsSchema.parse({ ...base, SELF_SIGNUP_MODE: 'allowed' }).SELF_SIGNUP_MODE
    ).toBe('allowed');
  });

  it('rejects an unknown self-signup mode', () => {
    expect(() => AuthSecretsSchema.parse({ ...base, SELF_SIGNUP_MODE: 'open' })).toThrow();
  });

  it('defaults LOGIN_CHANNELS to both channels', () => {
    expect(AuthSecretsSchema.parse(base).LOGIN_CHANNELS).toBe('phone,email');
    expect(
      AuthSecretsSchema.parse({ ...base, LOGIN_CHANNELS: 'email' }).LOGIN_CHANNELS
    ).toBe('email');
  });

  // These three replaced hardcoded constants in services/auth/self_signup.ts.
  // The defaults ARE the previous behaviour, so pin them: a changed default is a
  // silent change to the public signup abuse ceiling.
  it('defaults the signup rate limit to the previously hardcoded constants', () => {
    const parsed = AuthSecretsSchema.parse(base);
    expect(parsed.SIGNUP_MAX_PER_IDENTIFIER).toBe(3);
    expect(parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS).toBe(3600);
  });

  it('coerces the signup rate limit overrides from strings', () => {
    const parsed = AuthSecretsSchema.parse({
      ...base,
      SIGNUP_MAX_PER_IDENTIFIER: '50',
      SIGNUP_RATE_LIMIT_WINDOW_SECONDS: '300',
    });
    expect(parsed.SIGNUP_MAX_PER_IDENTIFIER).toBe(50);
    expect(parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS).toBe(300);
  });

  // Per-IP is Kong's apiRateLimit at the ingress (#669), never an app env var.
  // Guards a well-meaning re-add: the schema is strict about nothing, so an
  // unknown key would be silently dropped rather than rejected — this asserts
  // the parsed config exposes no per-IP knob to read.
  it('exposes no SIGNUP_MAX_PER_IP — per-IP limiting is Kong\'s job', () => {
    const parsed = AuthSecretsSchema.parse({ ...base, SIGNUP_MAX_PER_IP: '10' });
    expect('SIGNUP_MAX_PER_IP' in parsed).toBe(false);
  });

  // Both of these reach the schema in practice: the chart renders env from a
  // generic `config:` passthrough, so a key left blank in a cluster values file
  // arrives as "". loadEnv() parses bare, so either one crash-loops the pod —
  // asserted here so the sharp edge is at least documented by a test.
  it.each([['0'], ['']])('rejects %j for a signup rate limit', (value) => {
    expect(() =>
      AuthSecretsSchema.parse({ ...base, SIGNUP_MAX_PER_IDENTIFIER: value })
    ).toThrow();
  });

  it('rejects a non-integer signup rate limit', () => {
    expect(() =>
      AuthSecretsSchema.parse({ ...base, SIGNUP_MAX_PER_IDENTIFIER: '2.5' })
    ).toThrow();
  });
});

describe('NotificationSecretsSchema', () => {
  it('parses an entirely empty environment (every field optional)', () => {
    const parsed = NotificationSecretsSchema.parse({});
    expect(parsed.SUPPORT_EMAIL).toBeUndefined();
    expect(parsed.NOTIFICATION_FROM_EMAIL).toBeUndefined();
    expect(parsed.NOTIFICATION_REPLY_TO).toBeUndefined();
  });

  it('passes values through unchanged', () => {
    const parsed = NotificationSecretsSchema.parse({
      NOTIFICATION_SERVICE_ENDPOINT: 'https://notify.example.test',
      NOTIFICATION_SERVICE_KEY_ID: 'kid',
      NOTIFICATION_SERVICE_SECRET: 'shh',
      SMS_TEMPLATE_ID: 'tpl-1',
      NOTIFICATION_FROM_EMAIL: 'no-reply@example.test',
      NOTIFICATION_REPLY_TO: 'reply@example.test',
      FRONTEND_BASE_URL: 'https://ui.example.test',
      SUPPORT_EMAIL: 'a@example.test,b@example.test',
      SUPPORT_CC_EMAIL: 'cc@example.test',
    });

    expect(parsed.SUPPORT_EMAIL).toBe('a@example.test,b@example.test');
    expect(parsed.SUPPORT_CC_EMAIL).toBe('cc@example.test');
    expect(parsed.FRONTEND_BASE_URL).toBe('https://ui.example.test');
  });
});

describe('MatchScoreSecretsSchema', () => {
  it('accepts the only supported provider', () => {
    const parsed = MatchScoreSecretsSchema.parse({
      MATCH_SCORE_PROVIDER: 'signals_search',
      SIGNALS_SEARCH_ENDPOINT: 'https://search.example.test',
      SIGNALS_SEARCH_API_KEY: 'k',
      SIGNALS_SEARCH_RELEVANCE_PATH: 'v2/relevance',
    });

    expect(parsed.MATCH_SCORE_PROVIDER).toBe('signals_search');
    expect(parsed.SIGNALS_SEARCH_RELEVANCE_PATH).toBe('v2/relevance');
  });

  it('leaves the provider unset when absent (match scoring is opt-in)', () => {
    expect(MatchScoreSecretsSchema.parse({}).MATCH_SCORE_PROVIDER).toBeUndefined();
  });

  it('rejects an unknown provider', () => {
    expect(() => MatchScoreSecretsSchema.parse({ MATCH_SCORE_PROVIDER: 'elastic' })).toThrow();
  });
});

describe('SignalsSearchSecretsSchema distance override', () => {
  it('is unset by default so signals-search applies its own default radius', () => {
    expect(SignalsSearchSecretsSchema.parse({}).SIGNALS_SEARCH_DISTANCE_METERS).toBeUndefined();
  });

  it('coerces a numeric string to a positive integer', () => {
    expect(
      SignalsSearchSecretsSchema.parse({ SIGNALS_SEARCH_DISTANCE_METERS: '50000' })
        .SIGNALS_SEARCH_DISTANCE_METERS
    ).toBe(50000);
  });

  it('rejects zero, negative and fractional radii', () => {
    expect(() =>
      SignalsSearchSecretsSchema.parse({ SIGNALS_SEARCH_DISTANCE_METERS: '0' })
    ).toThrow();
    expect(() =>
      SignalsSearchSecretsSchema.parse({ SIGNALS_SEARCH_DISTANCE_METERS: '-10' })
    ).toThrow();
    expect(() =>
      SignalsSearchSecretsSchema.parse({ SIGNALS_SEARCH_DISTANCE_METERS: '1.5' })
    ).toThrow();
  });
});

describe('schema-registry secrets', () => {
  it('requires a non-empty SCHEMA_REGISTRY_URL in the strict schema', () => {
    expect(
      SchemaRegistrySecretsSchema.parse({ SCHEMA_REGISTRY_URL: 'https://reg.example.test' })
        .SCHEMA_REGISTRY_URL
    ).toBe('https://reg.example.test');
    expect(() => SchemaRegistrySecretsSchema.parse({ SCHEMA_REGISTRY_URL: '' })).toThrow();
    expect(() => SchemaRegistrySecretsSchema.parse({})).toThrow();
  });

  it('allows the registry URL to be absent in the optional schema', () => {
    expect(OptionalSchemaRegistrySecretsSchema.parse({}).SCHEMA_REGISTRY_URL).toBeUndefined();
  });
});

describe('NetworkRuntimeSecretsSchema', () => {
  const base = {
    SERVED_DOMAINS: 'yellow_dot/student',
    INSTANCE_SHARED_SECRET: 'x'.repeat(32),
  };

  it('applies every documented default', () => {
    const parsed = NetworkRuntimeSecretsSchema.parse(base);

    expect(parsed.NETWORK_CONFIG_SOURCE).toBe('local');
    expect(parsed.NETWORK_CONFIG_LOCAL_FILE).toBe(
      '../../examples/schemas/yellow_dot/network.json'
    );
    expect(parsed.NETWORK_CONFIG_URLS).toBeUndefined();
    expect(parsed.CONSENT_CONFIG_SOURCE).toBe('local');
    expect(parsed.CONSENT_SUPPORT_EMAIL).toBe('hello@bluedotseconomy.org');
    expect(parsed.ALLOW_EXTRA_SCHEMA_DATA).toBe(false);
    expect(parsed.BULK_MAX_ITEMS).toBe(100);
    expect(parsed.MAX_WARDS_PER_GUARDIAN).toBe(6);
    expect(parsed.MAX_PROFILES_PER_USER).toBe(5);
    expect(parsed.PEER_FETCH_TIMEOUT_MS).toBe(10000);
    expect(parsed.PEER_AUTH_MODE).toBe('permissive');
    expect(parsed.SCHEMA_CACHE_WARMUP_ENABLED).toBe(true);
  });

  it('coerces the numeric caps from env strings', () => {
    const parsed = NetworkRuntimeSecretsSchema.parse({
      ...base,
      BULK_MAX_ITEMS: '250',
      MAX_WARDS_PER_GUARDIAN: '3',
      MAX_PROFILES_PER_USER: '10',
      PEER_FETCH_TIMEOUT_MS: '2500',
    });

    expect(parsed.BULK_MAX_ITEMS).toBe(250);
    expect(parsed.MAX_WARDS_PER_GUARDIAN).toBe(3);
    expect(parsed.MAX_PROFILES_PER_USER).toBe(10);
    expect(parsed.PEER_FETCH_TIMEOUT_MS).toBe(2500);
  });

  it('rejects non-positive or fractional caps', () => {
    expect(() => NetworkRuntimeSecretsSchema.parse({ ...base, BULK_MAX_ITEMS: '0' })).toThrow();
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, MAX_PROFILES_PER_USER: '-1' })
    ).toThrow();
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, PEER_FETCH_TIMEOUT_MS: '1.5' })
    ).toThrow();
  });

  it('transforms the boolean-ish flags off the exact string "true"', () => {
    const parsed = NetworkRuntimeSecretsSchema.parse({
      ...base,
      ALLOW_EXTRA_SCHEMA_DATA: 'true',
      SCHEMA_CACHE_WARMUP_ENABLED: 'false',
    });

    expect(parsed.ALLOW_EXTRA_SCHEMA_DATA).toBe(true);
    expect(parsed.SCHEMA_CACHE_WARMUP_ENABLED).toBe(false);
  });

  it('requires SERVED_DOMAINS to be non-empty', () => {
    expect(() => NetworkRuntimeSecretsSchema.parse({ ...base, SERVED_DOMAINS: '' })).toThrow();
  });

  it('requires at least 32 characters of shared HMAC material for peer auth', () => {
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, INSTANCE_SHARED_SECRET: 'x'.repeat(31) })
    ).toThrow();
    expect(
      NetworkRuntimeSecretsSchema.parse({ ...base, INSTANCE_SHARED_SECRET: 'y'.repeat(32) })
        .INSTANCE_SHARED_SECRET
    ).toBe('y'.repeat(32));
  });

  it('accepts the enforced peer-auth mode and rejects anything else', () => {
    expect(
      NetworkRuntimeSecretsSchema.parse({ ...base, PEER_AUTH_MODE: 'enforced' }).PEER_AUTH_MODE
    ).toBe('enforced');
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, PEER_AUTH_MODE: 'strict' })
    ).toThrow();
  });

  it('rejects an unknown config source for network or consent', () => {
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, NETWORK_CONFIG_SOURCE: 'hybrid' })
    ).toThrow();
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, CONSENT_CONFIG_SOURCE: 'hybrid' })
    ).toThrow();
    expect(
      NetworkRuntimeSecretsSchema.parse({ ...base, CONSENT_CONFIG_SOURCE: 'remote' })
        .CONSENT_CONFIG_SOURCE
    ).toBe('remote');
  });

  it('rejects a blank CONSENT_SUPPORT_EMAIL rather than falling back to the default', () => {
    expect(() =>
      NetworkRuntimeSecretsSchema.parse({ ...base, CONSENT_SUPPORT_EMAIL: '' })
    ).toThrow();
    expect(
      NetworkRuntimeSecretsSchema.parse({ ...base, CONSENT_SUPPORT_EMAIL: 'ops@example.test' })
        .CONSENT_SUPPORT_EMAIL
    ).toBe('ops@example.test');
  });
});

describe('DatabaseSecretsSchema', () => {
  const base = {
    POSTGRES_USER: 'dpg',
    POSTGRES_PASSWORD: 'password12',
    POSTGRES_DB: 'dpg',
    REDIS_PASSWORD: 'redispw',
  };

  it('applies host/port defaults and leaves the URLs optional', () => {
    const parsed = DatabaseSecretsSchema.parse(base);

    expect(parsed.POSTGRES_HOST).toBe('127.0.0.1');
    expect(parsed.POSTGRES_PORT).toBeUndefined();
    expect(parsed.DATABASE_PORT).toBe(5432);
    expect(parsed.REDIS_HOST).toBe('127.0.0.1');
    expect(parsed.REDIS_PORT).toBe(6370);
    expect(parsed.POSTGRES_URL).toBeUndefined();
    expect(parsed.REDIS_URL).toBeUndefined();
  });

  it('coerces port overrides from env strings', () => {
    const parsed = DatabaseSecretsSchema.parse({
      ...base,
      POSTGRES_PORT: '5433',
      DATABASE_PORT: '6543',
      REDIS_PORT: '6379',
    });

    expect(parsed.POSTGRES_PORT).toBe(5433);
    expect(parsed.DATABASE_PORT).toBe(6543);
    expect(parsed.REDIS_PORT).toBe(6379);
  });

  it('rejects a Postgres password shorter than 8 characters', () => {
    expect(() =>
      DatabaseSecretsSchema.parse({ ...base, POSTGRES_PASSWORD: 'short' })
    ).toThrow();
  });

  it('requires the core Postgres and Redis credentials', () => {
    expect(() => DatabaseSecretsSchema.parse({})).toThrow();
  });
});

describe('PiiCryptoSecretsSchema', () => {
  it('accepts a base64-encoded 32-byte AES-256 key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(PiiCryptoSecretsSchema.parse({ SIGNALS_PII_KEY: key }).SIGNALS_PII_KEY).toBe(key);
  });

  it('rejects a key that is not base64 at all', () => {
    expect(() => PiiCryptoSecretsSchema.parse({ SIGNALS_PII_KEY: 'not a key!' })).toThrow(
      /must be base64/
    );
  });

  it('rejects a well-formed base64 key of the wrong length', () => {
    expect(() =>
      PiiCryptoSecretsSchema.parse({ SIGNALS_PII_KEY: Buffer.alloc(16).toString('base64') })
    ).toThrow(/32 bytes/);
    expect(() =>
      PiiCryptoSecretsSchema.parse({ SIGNALS_PII_KEY: Buffer.alloc(64).toString('base64') })
    ).toThrow(/32 bytes/);
  });

  it('requires the key to be present', () => {
    expect(() => PiiCryptoSecretsSchema.parse({})).toThrow();
  });
});
