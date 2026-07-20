import {
  assertCreateTestOtpSafe,
  parseServedDomains,
  parseLoginChannels,
} from '@dpg/config';
import { loadEnv } from '@/env';

export const {
  instance,
  api,
  auth,
  databases,
  matchScore,
  notification,
  networkRuntime,
  schemaRegistry,
  geocoding,
} = loadEnv();

// Startup guard (D7): fail hard in prod, warn in dev, if CREATE_TEST_OTP is on.
assertCreateTestOtpSafe(instance.INSTANCE_ENV, auth.CREATE_TEST_OTP);

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
  schema_registry_url: schemaRegistry.SCHEMA_REGISTRY_URL,
  peer_fetch_timeout_ms: networkRuntime.PEER_FETCH_TIMEOUT_MS,
};

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
  url:
    instance.INSTANCE_ENV === 'development'
      ? `${apiConfig.domain}:${apiConfig.port}/api/auth`
      : `${apiConfig.domain}/api/auth`,
  create_test_otp: auth.CREATE_TEST_OTP,
  allow_self_signup: auth.SELF_SIGNUP_MODE === 'allowed',
  login_channels: parseLoginChannels(auth.LOGIN_CHANNELS),
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
};

export const geocodingConfig = {
  google_api_key: geocoding.GOOGLE_GEOCODING_API_KEY,
  photon_url: geocoding.PHOTON_URL ?? 'https://photon.komoot.io',
  jitter_min_meters: geocoding.PII_LOCATION_JITTER_MIN_METERS,
  jitter_max_meters: geocoding.PII_LOCATION_JITTER_MAX_METERS,
};

export const matchScoreConfig = {
  provider: matchScore.MATCH_SCORE_PROVIDER,
  dpg_scoring: {
    endpoint: matchScore.DPG_SCORING_ENDPOINT,
    key_id: matchScore.DPG_SCORING_KEY_ID,
    secret: matchScore.DPG_SCORING_SECRET,
    path: matchScore.DPG_SCORING_PATH,
    version: matchScore.DPG_SCORING_VERSION,
    prompt_version: matchScore.DPG_SCORING_PROMPT_VERSION,
  },
};

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
