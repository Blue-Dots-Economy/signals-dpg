import {
  ApiSecretsSchema,
  assertAuthProviderSupported,
  AuthSecretsSchema,
  DatabaseSecretsSchema,
  GeocodingSecretsSchema,
  InstanceSecretsSchema,
  KeycloakSecretsSchema,
  MatchScoreSecretsSchema,
  NetworkRuntimeSecretsSchema,
  NotificationSecretsSchema,
  OptionalSchemaRegistrySecretsSchema,
  PiiCryptoSecretsSchema,
  SignalsSearchSecretsSchema,
} from '@dpg/config';

export function loadEnv() {
  // Before any schema parse: `dual` was removed from AUTH_PROVIDER, and Zod's
  // enum error would say only "Invalid input" without telling an operator what
  // to switch to or that a user migration is now a prerequisite.
  assertAuthProviderSupported(process.env.AUTH_PROVIDER);

  const instance = InstanceSecretsSchema.parse(process.env);
  const api = ApiSecretsSchema.parse(process.env);
  const auth = AuthSecretsSchema.parse(process.env);
  const keycloak = KeycloakSecretsSchema.parse(process.env);
  const databases = DatabaseSecretsSchema.parse(process.env);
  const notification = NotificationSecretsSchema.parse(process.env);
  const matchScore = MatchScoreSecretsSchema.parse(process.env);
  const networkRuntime = NetworkRuntimeSecretsSchema.parse(process.env);
  const schemaRegistry = OptionalSchemaRegistrySecretsSchema.parse(process.env);
  const piiCrypto = PiiCryptoSecretsSchema.parse(process.env);
  const geocoding = GeocodingSecretsSchema.parse(process.env);
  const signalsSearch = SignalsSearchSecretsSchema.parse(process.env);
  return {
    instance,
    api,
    auth,
    keycloak,
    databases,
    notification,
    matchScore,
    networkRuntime,
    schemaRegistry,
    piiCrypto,
    geocoding,
    signalsSearch,
  };
}
