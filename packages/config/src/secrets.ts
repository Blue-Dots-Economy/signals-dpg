import z from '@dpg/schemas';

export const InstanceSecretsSchema = z.object({
  INSTANCE_NAME: z.string(),
  INSTANCE_ENV: z.enum(['development', 'production']),
});

export const ApiSecretsSchema = z.object({
  API_DOMAIN: z.string(),
  API_PORT: z.coerce.number().default(2742),
});

export const AuthSecretsSchema = z.object({
  AUTH_SECRET: z.string().min(8),
  AUTH_MIDDLEWARE_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
  CREATE_TEST_OTP: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
});

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
});

export const MatchScoreSecretsSchema = z.object({
  MATCH_SCORE_PROVIDER: z.enum(['dpg_scoring']).optional(),
  DPG_SCORING_ENDPOINT: z.string().optional(),
  DPG_SCORING_KEY_ID: z.string().optional(),
  DPG_SCORING_SECRET: z.string().optional(),
  DPG_SCORING_PATH: z.string().optional(),
  DPG_SCORING_VERSION: z.string().optional(),
  DPG_SCORING_PROMPT_VERSION: z.string().optional(),
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
  ALLOW_EXTRA_SCHEMA_DATA: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  BULK_MAX_ITEMS: z.coerce.number().int().positive().default(100),
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
  })
  .refine((c) => c.PII_LOCATION_JITTER_MIN_METERS <= c.PII_LOCATION_JITTER_MAX_METERS, {
    message: 'PII_LOCATION_JITTER_MIN_METERS must be <= PII_LOCATION_JITTER_MAX_METERS',
    path: ['PII_LOCATION_JITTER_MIN_METERS'],
  });
