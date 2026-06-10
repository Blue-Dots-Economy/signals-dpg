import {
  ApiSecretsSchema,
  AuthSecretsSchema,
  DatabaseSecretsSchema,
  GeocodingSecretsSchema,
  InstanceSecretsSchema,
  MatchScoreSecretsSchema,
  NetworkRuntimeSecretsSchema,
  NotificationSecretsSchema,
  OptionalSchemaRegistrySecretsSchema,
  PiiCryptoSecretsSchema,
} from '@dpg/config';

export function loadEnv() {
  const instance = InstanceSecretsSchema.parse(process.env);
  const api = ApiSecretsSchema.parse(process.env);
  const auth = AuthSecretsSchema.parse(process.env);
  const databases = DatabaseSecretsSchema.parse(process.env);
  const notification = NotificationSecretsSchema.parse(process.env);
  const matchScore = MatchScoreSecretsSchema.parse(process.env);
  const networkRuntime = NetworkRuntimeSecretsSchema.parse(process.env);
  const schemaRegistry = OptionalSchemaRegistrySecretsSchema.parse(process.env);
  const piiCrypto = PiiCryptoSecretsSchema.parse(process.env);
  const geocoding = GeocodingSecretsSchema.parse(process.env);
  return {
    instance,
    api,
    auth,
    databases,
    notification,
    matchScore,
    networkRuntime,
    schemaRegistry,
    piiCrypto,
    geocoding,
  };
}
