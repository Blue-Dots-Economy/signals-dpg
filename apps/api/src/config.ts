import { parseServedDomains } from '@dpg/config';
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
} = loadEnv();

export const apiConfig = {
  domain: api.API_DOMAIN,
  port: api.API_PORT,
  served_domains: parseServedDomains(networkRuntime.SERVED_DOMAINS),
  network_config_source: networkRuntime.NETWORK_CONFIG_SOURCE,
  network_config_local_file: networkRuntime.NETWORK_CONFIG_LOCAL_FILE,
  network_config_urls: networkRuntime.NETWORK_CONFIG_URLS,
  allow_extra_schema_data: networkRuntime.ALLOW_EXTRA_SCHEMA_DATA,
  schema_registry_url: schemaRegistry.SCHEMA_REGISTRY_URL,
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
};
