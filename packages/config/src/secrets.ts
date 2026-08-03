import z from '@dpg/schemas';
import { ConfigError } from './config_error.js';

export const InstanceSecretsSchema = z.object({
  INSTANCE_NAME: z.string(),
  INSTANCE_ENV: z.enum(['development', 'production']),
});

export const ApiSecretsSchema = z.object({
  API_DOMAIN: z.string(),
  API_PORT: z.coerce.number().default(2742),
  // Serve the OpenAPI spec + Scalar reference UI at /api/reference. Default
  // on; apps/api/src/config.ts's apiReferenceEnabled force-disables it in
  // production unless API_REFERENCE_FORCE opts back in.
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
  // Coerces the env string to a boolean. The `.transform` cannot enforce
  // environment safety (it only parses) — assertCreateTestOtpSafe below does.
  CREATE_TEST_OTP: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  // Self-signup gate (#105). Default 'gated': the public OTP flow will not
  // create new accounts (participants are onboarded via /admin/participant).
  // Set to 'allowed' to keep self-service registration.
  SELF_SIGNUP_MODE: z.enum(['gated', 'allowed']).default('gated'),
  // Allowed login identifier channels, comma-separated (email / phone).
  // Parsed by parseLoginChannels(). Default: both.
  LOGIN_CHANNELS: z.string().default('phone,email'),
  // Identity provider. Single rollback lever:
  //   'betterauth' — better-auth only; every Keycloak path stays dormant.
  //   'keycloak'   — Keycloak only; better-auth is not involved in any step.
  // Default 'betterauth'.
  //
  // `dual` was removed: it existed so Keycloak tokens could be accepted
  // alongside better-auth sessions during cutover, and it was the only thing
  // that kept `backfillKeycloakShell` alive (the JIT straggler safety net, which
  // only fired on a better-auth *login*). With it gone, running
  // `scripts/migrate_users_to_keycloak.ts --apply` to completion is a hard
  // prerequisite for flipping an instance to `keycloak` — see
  // docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md §2.1.
  // Rollback is still per-instance: better-auth's code remains, and its
  // passwordless OTP login needs no `account` row, so a Keycloak-created user can
  // sign in again after a flip back.
  AUTH_PROVIDER: z.enum(['betterauth', 'keycloak']).default('betterauth'),
  // Where the acting-org authorisation comes from (§5.1 of the Keycloak
  // migration design). The `x-acting-org-id` header is unchanged in every mode —
  // this only controls whether the asserted value has to be inside a grant the
  // token carries:
  //   'header'          — today's behaviour: the header authorises itself.
  //   'claim_preferred' — enforce `signals_acting_orgs` WHEN the token has it;
  //                       fall back to the header when it doesn't. The
  //                       compatibility window while partners adopt the claim.
  //   'claim_required'  — a token with no grant is refused on acting-org routes.
  // Default 'header' so this lands inert.
  ACTING_ORG_SOURCE: z
    .enum(['header', 'claim_preferred', 'claim_required'])
    .default('header'),
});

/**
 * Keycloak connection + token-validation settings. Every field is optional or
 * defaulted so the API still boots with AUTH_PROVIDER=betterauth and nothing
 * Keycloak-related configured; assertKeycloakConfigured below is what makes
 * the required ones required once the flag moves off 'betterauth'.
 */
export const KeycloakSecretsSchema = z.object({
  // Browser-facing base URL, including any relative path Keycloak is served
  // under (aggregator runs it at /auth via KC_HTTP_RELATIVE_PATH). The `iss`
  // claim is derived from this, so it must match what Keycloak actually mints.
  KEYCLOAK_BASE_URL: z.string().optional(),
  // Server-to-server base URL for JWKS + Admin REST, when the API reaches
  // Keycloak on an internal address (e.g. http://keycloak:8080/auth) that
  // differs from the public issuer. Defaults to KEYCLOAK_BASE_URL.
  KEYCLOAK_INTERNAL_BASE_URL: z.string().optional(),
  // One shared realm per instance, holding both DPGs' clients (§3.1).
  KEYCLOAK_REALM: z.string().default('bluedots'),
  KEYCLOAK_UI_CLIENT_ID: z.string().default('signals-ui'),
  KEYCLOAK_API_CLIENT_ID: z.string().default('signals-api'),
  // Confidential client secret for signals-api (service account used for the
  // provisioning sync + Admin REST user creation). Not needed to *validate*
  // tokens, only to obtain them.
  KEYCLOAK_API_CLIENT_SECRET: z.string().optional(),
  // Comma-separated client ids whose tokens signals accepts on the HUMAN
  // session path. Load-bearing: the realm is shared with aggregator, so an
  // aggregator-issued token is realm-valid and signature/`iss` checks alone
  // would let it through (R9). Parsed by parseKeycloakAcceptedClientIds().
  KEYCLOAK_ACCEPTED_CLIENT_IDS: z.string().default('signals-ui,signals-api'),
  // Comma-separated client ids of integrating DPGs allowed on the SERVICE
  // path via client-credentials (§5). Kept separate from the list above, not
  // merged into it, so the two populations cannot be confused: a token from
  // the public `signals-ui` client must never be honoured as a service
  // account, and an integrating DPG's token must never be provisioned as a
  // human user. Empty by default — service auth stays on `x-api-key` until an
  // operator names the clients.
  //
  // Each id must match the `organization.slug` of that DPG's service org in
  // signals; that convention is how a client resolves to its service user.
  KEYCLOAK_SERVICE_CLIENT_IDS: z.string().default(''),
  // JWKS cache lifetime. jose refetches on an unknown `kid` regardless, so
  // this only bounds how long a rotated-out key stays cached.
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
 * Startup guard for the removed `dual` provider.
 *
 * `AUTH_PROVIDER` no longer accepts `dual`, so an instance still configured with
 * it would fail on the Zod enum with "Invalid input" and no indication of what to
 * do. This runs *before* the schema parse so the operator gets an actionable
 * message and a pointer at the prerequisite they now have to satisfy.
 *
 * Pure, so it is directly unit-testable.
 */
export function assertAuthProviderSupported(rawAuthProvider: string | undefined): void {
  if (rawAuthProvider !== 'dual') return;
  throw new ConfigError(
    "AUTH_PROVIDER='dual' has been removed. Use 'betterauth' or 'keycloak'.\n" +
      'dual existed so Keycloak tokens could be accepted alongside better-auth ' +
      'sessions during cutover, and it was the only mode in which the ' +
      'just-in-time Keycloak shell backfill ran.\n' +
      'Before setting AUTH_PROVIDER=keycloak, migrate every existing user into ' +
      'the realm — `pnpm keycloak:migrate:users --apply` then `--reconcile` until ' +
      'it reports 1:1. Without that, any user with no Keycloak identity is locked ' +
      'out at the flip, because nothing creates one for them on the fly any more.'
  );
}

/**
 * Startup guard: AUTH_PROVIDER=keycloak without a Keycloak base URL would boot
 * fine and then fail every login at runtime. Fail at boot instead.
 *
 * Pure, so it is directly unit-testable. Invoked once from
 * apps/api/src/config.ts at module load, next to assertCreateTestOtpSafe.
 */
export function assertKeycloakConfigured(
  authProvider: 'betterauth' | 'keycloak',
  keycloak: { KEYCLOAK_BASE_URL?: string; KEYCLOAK_ACCEPTED_CLIENT_IDS: string }
): void {
  if (authProvider === 'betterauth') return;

  if (!keycloak.KEYCLOAK_BASE_URL) {
    throw new ConfigError(
      `AUTH_PROVIDER=${authProvider} requires KEYCLOAK_BASE_URL (the ` +
        "browser-facing Keycloak base URL, e.g. 'http://localhost:8080/auth'). " +
        "Set it, or set AUTH_PROVIDER=betterauth to stay on the old provider."
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
 * Startup guard (D7): CREATE_TEST_OTP makes generateOtp() return the fixed
 * value "000000" for every account, so it must never be enabled in production.
 *
 * - production + enabled     -> throw ConfigError (boot fails, non-zero exit)
 * - non-production + enabled -> loud warning, continue
 * - disabled                 -> no-op
 *
 * Pure apart from the dev warning, so it is directly unit-testable. Invoked
 * once from apps/api/src/config.ts at module load.
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
  // Action-notification config (Phase 1 event notifications).
  // From address for action emails. Under Gmail SMTP the notification-service
  // forces the authenticated account as sender, so this is mainly the SES/prod
  // sender and the address shown to recipients.
  NOTIFICATION_FROM_EMAIL: z.string().optional(),
  // Reply-to for action emails; honoured by all transports. Defaults to
  // NOTIFICATION_FROM_EMAIL when unset.
  NOTIFICATION_REPLY_TO: z.string().optional(),
  // Base URL for the generic /auth/login CTA in action emails.
  FRONTEND_BASE_URL: z.string().optional(),
  // Recipient for support/contact-form submissions (#120). Optional so the API
  // still boots without it; the feature is gated on its presence (the endpoint
  // returns 503 and the UI hides/toasts when unset). Treated as a
  // comma-separated list by the consumer (multiple recipients allowed).
  SUPPORT_EMAIL: z.string().optional(),
  // Optional comma-separated CC list for support/contact-form submissions
  // (#283). Forwarded to nodemailer via the notification variables.
  SUPPORT_CC_EMAIL: z.string().optional(),
});

export const MatchScoreSecretsSchema = z.object({
  // signals_search provider: the in-network relevance service (POST /v1/relevance).
  // ENDPOINT is the signals-search base URL; API_KEY is an x-api-key valid in the
  // shared Signals apikey store; PATH optionally overrides 'v1/relevance'.
  MATCH_SCORE_PROVIDER: z.enum(['signals_search']).optional(),
  SIGNALS_SEARCH_ENDPOINT: z.string().optional(),
  SIGNALS_SEARCH_API_KEY: z.string().optional(),
  SIGNALS_SEARCH_RELEVANCE_PATH: z.string().optional(),
});

export const SignalsSearchSecretsSchema = z.object({
  // Discover BFF -> signals-search (#203). Both optional: when either is
  // unset, the discover BFF always falls back to the native (in-repo) search
  // path, so absence must never crash boot.
  SIGNALS_SEARCH_URL: z.string().optional(),
  SIGNALS_SEARCH_API_KEY: z.string().optional(),
  // Optional spatial radius (meters) the discover BFF sends to signals-search
  // as `distance_meters` (#394). Unset -> the BFF sends nothing and
  // signals-search's own ~30km `s_dwithin` default applies; the BFF still
  // reports that default via DEFAULT_SEARCH_DISTANCE_METERS so the UI's
  // "within X km" note stays accurate either way.
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
  // Resolved relative to process.cwd() by network_config_loader.ts. The
  // API process runs from apps/api/ (via turbo / pnpm dev:api), so the
  // default points up two levels into the repo-root `examples/` tree.
  NETWORK_CONFIG_LOCAL_FILE: z.string().default(
    '../../examples/schemas/yellow_dot/network.json'
  ),
  NETWORK_CONFIG_URLS: z.string().optional(),
  CONSENT_CONFIG_SOURCE: z.enum(['local', 'remote']).default('local'),
  // Support/grievance email rendered into consent copy in place of the
  // `__SUPPORT_EMAIL__` placeholder canonical consent files ship, so the email
  // is configurable without editing consent content.
  CONSENT_SUPPORT_EMAIL: z.string().min(1).default('hello@bluedotseconomy.org'),
  ALLOW_EXTRA_SCHEMA_DATA: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  BULK_MAX_ITEMS: z.coerce.number().int().positive().default(100),
  // Max wards that may share one guardian contact (U18). Best-effort cap.
  MAX_WARDS_PER_GUARDIAN: z.coerce.number().int().positive().default(6),
  // Global default cap on profiles a single user may own per (network, domain,
  // item_type). A network.json domain's `max_profiles_per_user` overrides this.
  MAX_PROFILES_PER_USER: z.coerce.number().int().positive().default(5),
  // Per-peer fetch budget for inter-instance count/page fan-out. One slow
  // peer must not stall the aggregate; see inter_instance_fetch.ts.
  PEER_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // D6 inter-instance peer auth. MUST be identical across every instance of a
  // network (shared HMAC material). Distributed via SOPS (D1).
  INSTANCE_SHARED_SECRET: z.string().min(32),
  // Rollout gate. 'permissive' (default): verify a token if present, reject a
  // bad/expired one, but allow a missing token (for peers not yet upgraded).
  // 'enforced': a valid token is required on every peer call.
  PEER_AUTH_MODE: z.enum(['permissive', 'enforced']).default('permissive'),
  // In NETWORK_CONFIG_SOURCE=local mode, apps/api/src/app.ts wipes and
  // rebuilds the on-disk network-schema cache at boot (see
  // network_schema_cache.ts's refreshConsumedSchemas -> cacheReferencedItemSchemas),
  // which queries the `items` table for every distinct item_schema_url on
  // record. That query needs a reachable Postgres. Default true preserves
  // that real-boot behavior unchanged. Callers that build the app without a
  // database — the OpenAPI dump script (apps/api/scripts/dump_openapi.env)
  // and any future boot-only smoke test — set this to false: route
  // registration is fully static and never reads the schema cache at
  // registration time (only a request-time handler, fetch_schemas.ts, reads
  // it, lazily rebuilding on a cache miss), so skipping the warmup has no
  // effect on the generated OpenAPI spec.
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
  // Approximate cap on the item-events stream length. The publisher trims with
  // `XADD MAXLEN ~` so the stream cannot grow unbounded in the shared Redis
  // (which runs `noeviction` in prod — an untrimmed stream would eventually
  // reject writes). Sized for consumer lag on signals-search; the sweep is the
  // backstop for anything trimmed before it is consumed.
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
    // Radius of the random offset applied to a PRIVATE (PII) primary location
    // before it is stored, so the exact address is never persisted. See
    // docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
    // Hard bounds are enforced (not just defaults) so config can't silently
    // defeat the control: a 50m floor keeps the offset above door precision,
    // a 1000m ceiling keeps the point useful for proximity.
    PII_LOCATION_JITTER_MIN_METERS: z.coerce.number().min(50).max(1000).default(100),
    PII_LOCATION_JITTER_MAX_METERS: z.coerce.number().min(50).max(1000).default(250),
    // Places cache TTLs (#196). Positive results are stable → long TTL;
    // unresolvable strings cache briefly so they don't hammer the paid API.
    GEO_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
    GEO_CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // A geocode is retried on a TRANSIENT provider failure only (HTTP/network
    // error or a soft rate-limit status such as OVER_QUERY_LIMIT) — a definitive
    // not-found is never retried. This targets the 429 bursts a large bulk
    // upload can trigger. Best-effort one-shot retry, not durable recovery:
    // GEO_RETRY_ATTEMPTS is the TOTAL number of tries (2 = one initial + one
    // retry); GEO_RETRY_BACKOFF_MS is the fixed pause between tries.
    GEO_RETRY_ATTEMPTS: z.coerce.number().int().min(1).default(2),
    GEO_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(300),
  })
  .refine((c) => c.PII_LOCATION_JITTER_MIN_METERS <= c.PII_LOCATION_JITTER_MAX_METERS, {
    message: 'PII_LOCATION_JITTER_MIN_METERS must be <= PII_LOCATION_JITTER_MAX_METERS',
    path: ['PII_LOCATION_JITTER_MIN_METERS'],
  });
