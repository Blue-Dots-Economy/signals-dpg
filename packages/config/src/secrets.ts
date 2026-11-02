import z, { EXPORT_ACTION_IDS_MAX } from '@dpg/schemas';
import { isValidTimeZone } from './time_zone';
import { ConfigError } from './config_error.js';

export const InstanceSecretsSchema = z.object({
  INSTANCE_NAME: z.string(),
  INSTANCE_ENV: z.enum(['development', 'production']),
});

export const ApiSecretsSchema = z.object({
  API_DOMAIN: z.string(),
  API_PORT: z.coerce.number().default(2742),
  // Serves the OpenAPI spec and Scalar UI at /api/reference. apps/api/src/config.ts
  // disables it in production unless API_REFERENCE_FORCE is set.
  API_REFERENCE_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
  // Opt back into serving the docs surface when INSTANCE_ENV=production.
  API_REFERENCE_FORCE: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
});

export const AuthSecretsSchema = z.object({
  AUTH_SECRET: z.string().min(8),
  AUTH_MIDDLEWARE_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
  // Only parses; assertCreateTestOtpSafe enforces that it is off in production.
  CREATE_TEST_OTP: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  // 'gated': neither self-signup nor first-login provisioning creates an account;
  // participants are onboarded via /admin/participant. 'allowed': both are open.
  SELF_SIGNUP_MODE: z.enum(['gated', 'allowed']).default('gated'),
  // Comma-separated login identifier channels (phone, email). Parsed by parseLoginChannels().
  LOGIN_CHANNELS: z.string().default('phone,email'),
  // Keycloak is the only provider. Kept as an enum so assertAuthProviderSupported
  // can give a removed value ('dual', 'betterauth') an actionable error instead
  // of Zod's bare "Invalid input".
  AUTH_PROVIDER: z.enum(['keycloak']).default('keycloak'),
  // Whether the `x-acting-org-id` header must fall inside the token's
  // `signals_acting_orgs` grant:
  //   'header'          — the header authorises itself.
  //   'claim_preferred' — enforce the grant when the token carries one, else
  //                       fall back to the header.
  //   'claim_required'  — a token with no grant is refused on acting-org routes.
  ACTING_ORG_SOURCE: z
    .enum(['header', 'claim_preferred', 'claim_required'])
    .default('header'),
});

/**
 * Keycloak connection and token-validation settings. Every field is optional or
 * defaulted; assertKeycloakConfigured enforces the required ones at boot.
 */
export const KeycloakSecretsSchema = z.object({
  // Browser-facing base URL, including any relative path (e.g. /auth). The
  // expected `iss` is derived from it, so it must match what Keycloak mints.
  KEYCLOAK_BASE_URL: z.string().optional(),
  // Server-to-server base URL for JWKS and Admin REST when it differs from the
  // public issuer (e.g. http://keycloak:8080/auth). Defaults to KEYCLOAK_BASE_URL.
  KEYCLOAK_INTERNAL_BASE_URL: z.string().optional(),
  // One realm per instance, shared with aggregator.
  KEYCLOAK_REALM: z.string().default('bluedots'),
  KEYCLOAK_UI_CLIENT_ID: z.string().default('signals-ui'),
  KEYCLOAK_API_CLIENT_ID: z.string().default('signals-api'),
  // Confidential secret for the signals-api service account (Admin REST user
  // creation). Needed only to obtain tokens, not to validate them.
  KEYCLOAK_API_CLIENT_SECRET: z.string().optional(),
  // Comma-separated client ids accepted on the human session path. Required
  // because the realm is shared: an aggregator-issued token passes signature
  // and `iss` checks. Parsed by parseKeycloakAcceptedClientIds().
  // `signals-api` must not be listed: it can mint its own tokens, which would
  // then be valid human sessions.
  KEYCLOAK_ACCEPTED_CLIENT_IDS: z.string().default('signals-ui'),
  // Realm roles a human token must carry at least one of, checked after the
  // client allowlist as defence in depth for the shared realm.
  // user_to_keycloak.ts assigns one of these roles to each user it creates.
  // Empty disables the check (for a realm whose tokens carry no
  // `realm_access.roles`); the client allowlist is then the only cross-DPG gate.
  KEYCLOAK_REQUIRED_REALM_ROLES: z
    .string()
    .default('signals_participant,signals_admin'),
  // Comma-separated client ids of integrating DPGs allowed on the service path
  // via client credentials. Kept separate from KEYCLOAK_ACCEPTED_CLIENT_IDS so a
  // UI token is never a service account and a DPG token is never a human user.
  // Empty means service auth is `x-api-key` only.
  // Each id must equal the `organization.slug` of that DPG's service org; that
  // is how a client resolves to its service user.
  KEYCLOAK_SERVICE_CLIENT_IDS: z.string().default(''),
  // jose refetches on an unknown `kid` anyway, so this only bounds how long a
  // rotated-out key stays cached.
  KEYCLOAK_JWKS_CACHE_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(600_000),
  KEYCLOAK_CLOCK_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30),
});

/**
 * Startup guard for removed AUTH_PROVIDER values ('dual', 'betterauth'). Runs
 * before the schema parse so the operator gets an actionable message instead
 * of Zod's "Invalid input".
 */
export function assertAuthProviderSupported(rawAuthProvider: string | undefined): void {
  if (rawAuthProvider === 'dual') {
    throw new ConfigError(
      "AUTH_PROVIDER='dual' has been removed. Keycloak is now the only provider.\n" +
        'dual existed so Keycloak tokens could be accepted alongside better-auth ' +
        'sessions during cutover, and it was the only mode in which the ' +
        'just-in-time Keycloak shell backfill ran.\n' +
        'Before setting AUTH_PROVIDER=keycloak, migrate every existing user into ' +
        'the realm — `pnpm keycloak:migrate:users --apply` then `--reconcile` until ' +
        'it reports 1:1. Without that, any user with no Keycloak identity is locked ' +
        'out at the flip, because nothing creates one for them on the fly any more.'
    );
  }

  // Fail at boot rather than silently treating it as keycloak: users without a
  // Keycloak identity would otherwise be locked out with no signal why.
  if (rawAuthProvider === 'betterauth') {
    throw new ConfigError(
      "AUTH_PROVIDER='betterauth' has been removed — Keycloak is the only provider.\n" +
        'The better-auth library, its /api/auth/* mount and its OTP login flow are ' +
        'gone; only the `apikey` table it used to own remains, and `x-api-key` auth ' +
        'is unaffected (it is verified in-process now).\n' +
        'Before setting AUTH_PROVIDER=keycloak, migrate every existing user into ' +
        'the realm — `pnpm keycloak:migrate:users --apply` then `--reconcile` until ' +
        'it reports 1:1. There is no longer any fallback login path for a user who ' +
        'has no Keycloak identity.'
    );
  }
}

/**
 * Startup guard: AUTH_PROVIDER=keycloak without a Keycloak base URL would boot
 * fine and then fail every login at runtime. Fail at boot instead. Called from
 * apps/api/src/config.ts at module load.
 */
export function assertKeycloakConfigured(
  authProvider: 'keycloak',
  keycloak: { KEYCLOAK_BASE_URL?: string; KEYCLOAK_ACCEPTED_CLIENT_IDS: string }
): void {
  if (!keycloak.KEYCLOAK_BASE_URL) {
    throw new ConfigError(
      `AUTH_PROVIDER=${authProvider} requires KEYCLOAK_BASE_URL (the ` +
        "browser-facing Keycloak base URL, e.g. 'http://localhost:8080/auth')."
    );
  }

  if (parseKeycloakAcceptedClientIds(keycloak.KEYCLOAK_ACCEPTED_CLIENT_IDS).length === 0) {
    throw new ConfigError(
      `AUTH_PROVIDER=${authProvider} requires a non-empty ` +
        'KEYCLOAK_ACCEPTED_CLIENT_IDS. The realm is shared with aggregator, so ' +
        'signals must reject tokens issued to clients it does not serve — an ' +
        'empty list would accept none, and removing the check would accept all.'
    );
  }
}

/** Split, trim and de-duplicate the comma-separated accepted-client list. */
export function parseKeycloakAcceptedClientIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Startup guard: CREATE_TEST_OTP makes every guardian OTP the fixed value
 * "000000" and skips its dispatch (services/guardian_otp.ts), so it must never
 * be enabled in production. Throws ConfigError in production, warns otherwise.
 * Called from apps/api/src/config.ts at module load.
 */
export function assertCreateTestOtpSafe(
  instanceEnv: 'development' | 'production',
  createTestOtp: boolean
): void {
  if (!createTestOtp) return;

  if (instanceEnv === 'production') {
    throw new ConfigError(
      'CREATE_TEST_OTP must not be enabled when INSTANCE_ENV=production: it ' +
        'forces every OTP to the fixed value "000000", allowing anyone to sign ' +
        'in as any account. Unset CREATE_TEST_OTP (or set it to "false").'
    );
  }

  process.emitWarning(
    'CREATE_TEST_OTP is enabled: all OTPs are the fixed value "000000". ' +
      'This is for local development only and must never reach production.',
    { code: 'CREATE_TEST_OTP_ENABLED' }
  );
}

export const NotificationSecretsSchema = z.object({
  NOTIFICATION_SERVICE_ENDPOINT: z.string().optional(),
  NOTIFICATION_SERVICE_KEY_ID: z.string().optional(),
  NOTIFICATION_SERVICE_SECRET: z.string().optional(),
  SMS_TEMPLATE_ID: z.string().optional(),
  // Mounted sms.properties override, layered over the bundled defaults and
  // under the network/brand files.
  SMS_MESSAGES_PATH: z.string().optional(),
  // Sender for API emails. Under Gmail SMTP the notification-service sends as
  // the authenticated account instead, so this mainly applies to SES.
  NOTIFICATION_FROM_EMAIL: z.string().optional(),
  // Defaults to NOTIFICATION_FROM_EMAIL.
  NOTIFICATION_REPLY_TO: z.string().optional(),
  // Base URL for email CTA links when UI_HOST_BINDINGS has no host for the
  // recipient's domain.
  FRONTEND_BASE_URL: z.string().optional(),
  // Host -> "network/domain" map; must be identical to the string the UI
  // ingress uses for VITE_SERVED_BINDINGS. Inverted at boot so an email CTA
  // points at the recipient's own portal. Empty = single-host install.
  UI_HOST_BINDINGS: z.string().default(''),
  // Comma-separated support-form recipients. Unset disables the feature: the
  // endpoint returns 503 and the UI hides the form.
  SUPPORT_EMAIL: z.string().optional(),
  // Comma-separated CC list for support-form emails.
  SUPPORT_CC_EMAIL: z.string().optional(),
  // Support-form attachment budget: total decoded bytes per submission, and
  // file count. Served to the UI by GET /api/v1/support/config. The
  // notification-service enforces its own NOTIFY_ATTACHMENT_* caps, so raise
  // those alongside.
  SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  SUPPORT_ATTACHMENT_MAX_FILES: z.coerce.number().int().positive().default(3),
  // Mounted override of the bundled email messages file. A bad or missing file
  // never breaks email: the loader falls back per key with warnings.
  EMAIL_MESSAGES_PATH: z.string().optional(),
});

export const MatchScoreSecretsSchema = z.object({
  // signals_search provider calls POST /v1/relevance. ENDPOINT is the
  // signals-search base URL; API_KEY is an x-api-key from the shared Signals
  // apikey store; PATH overrides 'v1/relevance'.
  MATCH_SCORE_PROVIDER: z.enum(['signals_search']).optional(),
  SIGNALS_SEARCH_ENDPOINT: z.string().optional(),
  SIGNALS_SEARCH_API_KEY: z.string().optional(),
  SIGNALS_SEARCH_RELEVANCE_PATH: z.string().optional(),
});

export const SignalsSearchSecretsSchema = z.object({
  // Discover BFF -> signals-search. When either is unset the BFF uses the
  // native in-repo search path.
  SIGNALS_SEARCH_URL: z.string().optional(),
  SIGNALS_SEARCH_API_KEY: z.string().optional(),
  // Radius in meters sent to signals-search as `distance_meters`. Unset sends
  // none and signals-search applies its own ~30 km default.
  SIGNALS_SEARCH_DISTANCE_METERS: z.coerce.number().int().positive().optional(),
});

export const SchemaRegistrySecretsSchema = z.object({
  SCHEMA_REGISTRY_URL: z.string().min(1),
});

export const OptionalSchemaRegistrySecretsSchema = z.object({
  SCHEMA_REGISTRY_URL: z.string().optional(),
});

export const NetworkRuntimeSecretsSchema = z.object({
  SERVED_DOMAINS: z.string().min(1),
  NETWORK_CONFIG_SOURCE: z.enum(['local', 'remote']).default('local'),
  // Resolved relative to process.cwd(); the API runs from apps/api/, so the
  // default points at the repo-root `examples/` tree.
  NETWORK_CONFIG_LOCAL_FILE: z.string().default(
    '../../examples/schemas/yellow_dot/network.json'
  ),
  NETWORK_CONFIG_URLS: z.string().optional(),
  CONSENT_CONFIG_SOURCE: z.enum(['local', 'remote']).default('local'),
  // Replaces the `__SUPPORT_EMAIL__` placeholder in consent copy.
  CONSENT_SUPPORT_EMAIL: z.string().min(1).default('hello@bluedotseconomy.org'),
  ALLOW_EXTRA_SCHEMA_DATA: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  BULK_MAX_ITEMS: z.coerce.number().int().positive().default(100),
  // Row cap for one bulk export; above it the endpoint returns 413 rather than
  // streaming an unbounded decrypt. Bounded by EXPORT_ACTION_IDS_MAX so a larger
  // value fails at boot instead of silently not applying.
  EXPORT_MAX_ROWS: z.coerce.number().int().positive().max(EXPORT_ACTION_IDS_MAX).default(10000),
  // Per-user bulk exports per rolling hour, counted in Redis across pods.
  // Bulk decrypt is the obvious scraping route.
  EXPORT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
  // IANA zone for bulk-export timestamps (filename, file dates, generated-at).
  // The filename and generated-at carry the offset; date cells are wall-clock
  // times in this zone, named in their column heading.
  EXPORT_TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine(isValidTimeZone, {
      message: 'EXPORT_TIMEZONE must be an IANA time zone, e.g. Asia/Kolkata',
    }),
  // Max wards that may share one guardian contact (U18). Best-effort cap.
  MAX_WARDS_PER_GUARDIAN: z.coerce.number().int().positive().default(6),
  // Global default cap on profiles a single user may own per (network, domain,
  // item_type). A network.json domain's `max_profiles_per_user` overrides this.
  MAX_PROFILES_PER_USER: z.coerce.number().int().positive().default(5),
  // Per-peer timeout for inter-instance fan-out, so one slow peer cannot stall
  // the aggregate.
  PEER_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // HMAC key for inter-instance peer auth. Must be identical on every instance
  // of a network.
  INSTANCE_SHARED_SECRET: z.string().min(32),
  // 'permissive': verify a token if present and reject a bad one, but allow a
  // missing one. 'enforced': every peer call needs a valid token.
  PEER_AUTH_MODE: z.enum(['permissive', 'enforced']).default('permissive'),
  // In local config mode the boot-time schema-cache rebuild queries `items`,
  // which needs Postgres. Set false to build the app without a database (the
  // OpenAPI dump does); route registration never reads the schema cache.
  SCHEMA_CACHE_WARMUP_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
});

export const DatabaseSecretsSchema = z.object({
  POSTGRES_URL: z.string().optional(),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string().min(8),
  POSTGRES_DB: z.string(),
  POSTGRES_HOST: z.string().default('127.0.0.1'),
  POSTGRES_PORT: z.coerce.number().optional(),
  DATABASE_PORT: z.coerce.number().default(5432),
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PASSWORD: z.string(),
  REDIS_PORT: z.coerce.number().default(6370),
  INGEST_STREAM: z.string().default('signals:item-events'),
  // Approximate stream cap applied with `XADD MAXLEN ~`. Prod Redis runs
  // `noeviction`, so an untrimmed stream would eventually reject writes. Sized
  // for signals-search consumer lag; its reconciliation sweep catches anything
  // trimmed before it is consumed.
  INGEST_STREAM_MAXLEN: z.coerce.number().int().positive().default(100_000),
});

export const PiiCryptoSecretsSchema = z.object({
  SIGNALS_PII_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/=]+$/, 'SIGNALS_PII_KEY must be base64')
    .refine(
      (s) => Buffer.from(s, 'base64').length === 32,
      'SIGNALS_PII_KEY must be base64-encoded 32 bytes (AES-256)'
    ),
});

export const GeocodingSecretsSchema = z
  .object({
    GOOGLE_GEOCODING_API_KEY: z.string().optional(),
    PHOTON_URL: z.string().optional(),
    // ISO 3166-1 alpha-2 country (e.g. `IN`) that geocodes and caller-supplied
    // coordinates are restricted to. Unset or blank (Helm renders unset as "")
    // means worldwide.
    GEOCODING_COUNTRY: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/, 'GEOCODING_COUNTRY must be an ISO 3166-1 alpha-2 code, e.g. IN')
        .transform((s) => s.toUpperCase())
        .optional(),
    ),
    // GeoJSON boundary of GEOCODING_COUNTRY, mounted from a ConfigMap. A
    // caller-supplied coordinate outside it is rejected. Unset skips that check;
    // the geocoder restriction still applies.
    GEOCODING_BOUNDARY_PATH: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().trim().optional(),
    ),
    // Offset radius applied to a private (PII) location before storage, so the
    // exact address is never persisted. Hard bounds stop config from defeating
    // the control: the 50 m floor stays above door precision, the 1000 m
    // ceiling keeps the point useful for proximity.
    PII_LOCATION_JITTER_MIN_METERS: z.coerce.number().min(50).max(1000).default(100),
    PII_LOCATION_JITTER_MAX_METERS: z.coerce.number().min(50).max(1000).default(250),
    // Geocode cache TTLs. Hits are stable, so long; misses are cached briefly
    // so unresolvable strings don't hammer the paid API.
    GEO_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
    GEO_CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // Retries apply to transient provider failures only (network/HTTP error or
    // a rate-limit status such as OVER_QUERY_LIMIT), never to a not-found.
    // GEO_RETRY_ATTEMPTS is the total number of tries (2 = one retry);
    // GEO_RETRY_BACKOFF_MS is the fixed pause between tries.
    GEO_RETRY_ATTEMPTS: z.coerce.number().int().min(1).default(2),
    GEO_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(300),
  })
  .refine((c) => c.PII_LOCATION_JITTER_MIN_METERS <= c.PII_LOCATION_JITTER_MAX_METERS, {
    message: 'PII_LOCATION_JITTER_MIN_METERS must be <= PII_LOCATION_JITTER_MAX_METERS',
    path: ['PII_LOCATION_JITTER_MIN_METERS'],
  });
