import {
  assertCreateTestOtpSafe,
  assertKeycloakConfigured,
  parseKeycloakAcceptedClientIds,
  parseServedDomains,
  parseLoginChannels,
  parseUiHostBindings,
} from '@dpg/config';
import { loadEnv } from '@/env';

export const {
  instance,
  api,
  auth,
  keycloak,
  databases,
  matchScore,
  notification,
  networkRuntime,
  schemaRegistry,
  geocoding,
  signalsSearch,
} = loadEnv();

// Startup guard (D7): fail hard in prod, warn in dev, if CREATE_TEST_OTP is on.
assertCreateTestOtpSafe(instance.INSTANCE_ENV, auth.CREATE_TEST_OTP);

// Startup guard: don't boot into a Keycloak mode we aren't configured for.
assertKeycloakConfigured(auth.AUTH_PROVIDER, keycloak);

export const apiConfig = {
  domain: api.API_DOMAIN,
  port: api.API_PORT,
  served_domains: parseServedDomains(networkRuntime.SERVED_DOMAINS),
  network_config_source: networkRuntime.NETWORK_CONFIG_SOURCE,
  network_config_local_file: networkRuntime.NETWORK_CONFIG_LOCAL_FILE,
  network_config_urls: networkRuntime.NETWORK_CONFIG_URLS,
  consent_config_source: networkRuntime.CONSENT_CONFIG_SOURCE,
  consent_support_email: networkRuntime.CONSENT_SUPPORT_EMAIL,
  allow_extra_schema_data: networkRuntime.ALLOW_EXTRA_SCHEMA_DATA,
  bulk_max_items: networkRuntime.BULK_MAX_ITEMS,
  max_wards_per_guardian: networkRuntime.MAX_WARDS_PER_GUARDIAN,
  max_profiles_per_user: networkRuntime.MAX_PROFILES_PER_USER,
  schema_registry_url: schemaRegistry.SCHEMA_REGISTRY_URL,
  peer_fetch_timeout_ms: networkRuntime.PEER_FETCH_TIMEOUT_MS,
  schema_cache_warmup_enabled: networkRuntime.SCHEMA_CACHE_WARMUP_ENABLED,
};

/**
 * Inverted host bindings (domain -> portal origin), parsed once at boot. The
 * warnings are logged by `buildApp`, which is the first point a logger exists.
 */
export const uiHostBindings = parseUiHostBindings(notification.UI_HOST_BINDINGS);

export const peerConfig = {
  shared_secret: networkRuntime.INSTANCE_SHARED_SECRET,
  auth_mode: networkRuntime.PEER_AUTH_MODE,
  token_window_seconds: 300,
};

export const authConfig = {
  secret: auth.AUTH_SECRET,
  middleware_enabled:
    instance.INSTANCE_ENV === 'development'
      ? auth.AUTH_MIDDLEWARE_ENABLED
      : true,
  create_test_otp: auth.CREATE_TEST_OTP,
  allow_self_signup: auth.SELF_SIGNUP_MODE === 'allowed',
  login_channels: parseLoginChannels(auth.LOGIN_CHANNELS),
  // Identity provider. Read this — never re-parse process.env.
  provider: auth.AUTH_PROVIDER,
  /**
   * Convenience predicates so call sites read as intent, not string compares.
   *
   * Exact complements now that `dual` is gone. Both are kept rather than
   * collapsed to one, because the two names carry opposite intent at their call
   * sites — `keycloak_enabled` guards Keycloak work, `betterauth_enabled` guards
   * the legacy surface — and reading `!betterauth_enabled` to mean "Keycloak" was
   * exactly the kind of double negative that made the three-mode code hard to
   * follow.
   */
  keycloak_enabled: auth.AUTH_PROVIDER === 'keycloak',
  betterauth_enabled: auth.AUTH_PROVIDER === 'betterauth',
  /**
   * Acting-org authorisation source (§5.1). The header is sent in every mode;
   * this only decides whether it must fall inside the token's grant.
   */
  acting_org_source: auth.ACTING_ORG_SOURCE,
  /** Check the grant when the token carries one. */
  acting_org_claim_enforced: auth.ACTING_ORG_SOURCE !== 'header',
  /** Refuse acting-org routes for a token with no grant at all. */
  acting_org_claim_required: auth.ACTING_ORG_SOURCE === 'claim_required',
};

/**
 * Keycloak connection settings, with the two derived URLs the rest of the code
 * actually wants:
 *
 * - `issuer` is browser-facing and must equal the `iss` claim byte-for-byte.
 * - `internal_base_url` is what *this process* dials for JWKS / Admin REST; in
 *   containerised setups that is a service name, not the public hostname.
 *
 * Empty strings when AUTH_PROVIDER=betterauth — assertKeycloakConfigured above
 * has already rejected the combination of a Keycloak mode and a missing URL,
 * so any consumer running under `dual`/`keycloak` sees real values.
 */
const keycloakBaseUrl = (keycloak.KEYCLOAK_BASE_URL ?? '').replace(/\/$/, '');
const keycloakInternalBaseUrl = (
  keycloak.KEYCLOAK_INTERNAL_BASE_URL ?? keycloak.KEYCLOAK_BASE_URL ?? ''
).replace(/\/$/, '');

export const keycloakConfig = {
  base_url: keycloakBaseUrl,
  internal_base_url: keycloakInternalBaseUrl,
  realm: keycloak.KEYCLOAK_REALM,
  issuer: keycloakBaseUrl
    ? `${keycloakBaseUrl}/realms/${keycloak.KEYCLOAK_REALM}`
    : '',
  jwks_uri: keycloakInternalBaseUrl
    ? `${keycloakInternalBaseUrl}/realms/${keycloak.KEYCLOAK_REALM}/protocol/openid-connect/certs`
    : '',
  ui_client_id: keycloak.KEYCLOAK_UI_CLIENT_ID,
  api_client_id: keycloak.KEYCLOAK_API_CLIENT_ID,
  api_client_secret: keycloak.KEYCLOAK_API_CLIENT_SECRET,
  /**
   * Every client whose tokens pass the audience gate — the union of the human
   * and service lists. `verifyKeycloakToken` checks membership here; which of
   * the two lists a client is in then decides whether it may take the human
   * path or the service path (see resolve_session.ts).
   */
  accepted_client_ids: [
    ...new Set([
      ...parseKeycloakAcceptedClientIds(keycloak.KEYCLOAK_ACCEPTED_CLIENT_IDS),
      ...parseKeycloakAcceptedClientIds(keycloak.KEYCLOAK_SERVICE_CLIENT_IDS),
    ]),
  ],
  /** Human/session clients only. */
  session_client_ids: parseKeycloakAcceptedClientIds(
    keycloak.KEYCLOAK_ACCEPTED_CLIENT_IDS
  ),
  /** Integrating-DPG clients allowed to use client-credentials service auth. */
  service_client_ids: parseKeycloakAcceptedClientIds(
    keycloak.KEYCLOAK_SERVICE_CLIENT_IDS
  ),
  /**
   * Realm roles a human token must carry one of, on top of the client
   * allowlist. Empty disables the check (see the env comment).
   */
  required_realm_roles: parseKeycloakAcceptedClientIds(
    keycloak.KEYCLOAK_REQUIRED_REALM_ROLES
  ),
  jwks_cache_max_age_ms: keycloak.KEYCLOAK_JWKS_CACHE_MAX_AGE_MS,
  clock_tolerance_seconds: keycloak.KEYCLOAK_CLOCK_TOLERANCE_SECONDS,
};

/**
 * Normalize a comma-separated email list: split on commas, trim, drop empties
 * and rejoin with ", " (a form nodemailer accepts for multiple addresses).
 * Returns undefined when nothing usable remains.
 */
function normalizeEmailList(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const list = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length ? list.join(', ') : undefined;
}

export const supportConfig = {
  recipients: normalizeEmailList(notification.SUPPORT_EMAIL),
  cc: normalizeEmailList(notification.SUPPORT_CC_EMAIL),
  fromEmail: notification.NOTIFICATION_FROM_EMAIL,
  // "Sub-domain link" surfaced in the support subject line.
  linkBaseUrl: notification.FRONTEND_BASE_URL,
  // Display name for the "Team <name>" sign-off. No brand short-name is
  // available synchronously in config (ServedDomainBinding carries only
  // network/domain/key), so we use the instance name — no new env (#283).
  teamName: instance.INSTANCE_NAME,
  // Attachment budget (#551). Also served to the UI so the form's own
  // validation matches the server's.
  attachmentMaxTotalBytes: notification.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentMaxFiles: notification.SUPPORT_ATTACHMENT_MAX_FILES,
};

export const geocodingConfig = {
  google_api_key: geocoding.GOOGLE_GEOCODING_API_KEY,
  photon_url: geocoding.PHOTON_URL ?? 'https://photon.komoot.io',
  jitter_min_meters: geocoding.PII_LOCATION_JITTER_MIN_METERS,
  jitter_max_meters: geocoding.PII_LOCATION_JITTER_MAX_METERS,
  cache_ttl_seconds: geocoding.GEO_CACHE_TTL_SECONDS,
  cache_negative_ttl_seconds: geocoding.GEO_CACHE_NEGATIVE_TTL_SECONDS,
  retry_attempts: geocoding.GEO_RETRY_ATTEMPTS,
  retry_backoff_ms: geocoding.GEO_RETRY_BACKOFF_MS,
};

export const matchScoreConfig = {
  provider: matchScore.MATCH_SCORE_PROVIDER,
  signals_search: {
    endpoint: matchScore.SIGNALS_SEARCH_ENDPOINT,
    api_key: matchScore.SIGNALS_SEARCH_API_KEY,
    path: matchScore.SIGNALS_SEARCH_RELEVANCE_PATH,
  },
};

/**
 * Discover BFF -> signals-search (#203). Both fields optional and undefined
 * when unset — no consumer yet (Task 2); the eventual BFF falls back to the
 * native search path whenever either is missing, so absence must not crash
 * boot.
 */
export const signalsSearchConfig = {
  url: signalsSearch.SIGNALS_SEARCH_URL,
  api_key: signalsSearch.SIGNALS_SEARCH_API_KEY,
  // Optional configured spatial radius (meters, #394). Undefined -> the
  // discover BFF sends no distance_meters to signals-search (its own default
  // applies) but still reports DEFAULT_SEARCH_DISTANCE_METERS.
  distanceMeters: signalsSearch.SIGNALS_SEARCH_DISTANCE_METERS,
};

/**
 * Serve the OpenAPI spec + Scalar reference UI at /api/reference. Secure by
 * default: force-disabled when INSTANCE_ENV=production unless
 * API_REFERENCE_FORCE opts back in. The always-available reference is the
 * bluedots-docs site.
 */
export const apiReferenceEnabled: boolean =
  api.API_REFERENCE_ENABLED &&
  (instance.INSTANCE_ENV !== 'production' || api.API_REFERENCE_FORCE);

export function getCurrentApiBaseUrl(): string {
  const parsedUrl = new URL(api.API_DOMAIN);

  if (instance.INSTANCE_ENV === 'development' && !parsedUrl.port) {
    parsedUrl.port = String(api.API_PORT);
  }

  return parsedUrl.toString().replace(/\/$/, '');
}

const postgresPort = databases.POSTGRES_PORT ?? databases.DATABASE_PORT;
const pg_url =
  databases.POSTGRES_URL ??
  `postgres://${databases.POSTGRES_USER}:${databases.POSTGRES_PASSWORD}@${databases.POSTGRES_HOST}:${postgresPort}/${databases.POSTGRES_DB}`;

const redis_url =
  databases.REDIS_URL ??
  `redis://:${databases.REDIS_PASSWORD}@${databases.REDIS_HOST}:${databases.REDIS_PORT}`;

export const databasesConfig = {
  pg_url,
  redis_url,
  redis_password: databases.REDIS_PASSWORD,
  redis_port: databases.REDIS_PORT,
  ingest_stream: databases.INGEST_STREAM,
  ingest_stream_maxlen: databases.INGEST_STREAM_MAXLEN,
};
