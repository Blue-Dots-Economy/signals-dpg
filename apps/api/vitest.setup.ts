import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load the repo-root .env so `pnpm --filter api test:integration` picks up
// POSTGRES_URL / REDIS_URL / etc. without needing the root turbo-with-env
// wrapper. Unit-test runs benefit too (they're a superset of the same env
// surface). Vars already in process.env take precedence — CI overrides win.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env'), override: false });

// Deterministic PII master key for tests so encrypt/decrypt round-trips
// without depending on a developer's local .env. 32 bytes of 0xA1 base64-encoded.
process.env.SIGNALS_PII_KEY ??= Buffer.alloc(32, 0xa1).toString('base64');

// CI has no .env, but importing src/config.ts runs loadEnv() at module load,
// which Zod-validates every secrets schema. Tests that import modules in that
// chain (network_configs, served_domain_guard, geo_resolver, ...) need the
// required vars present. `??=` keeps developer/CI-provided values authoritative.
process.env.INSTANCE_NAME ??= 'test-instance';
process.env.INSTANCE_ENV ??= 'development';
process.env.API_DOMAIN ??= 'http://localhost:2742';
process.env.AUTH_SECRET ??= 'test-auth-secret';
process.env.POSTGRES_USER ??= 'test';
process.env.POSTGRES_PASSWORD ??= 'test-password';
process.env.POSTGRES_DB ??= 'test';
process.env.REDIS_PASSWORD ??= 'test-password';
process.env.SERVED_DOMAINS ??= 'yellow_dot/student';
process.env.INSTANCE_SHARED_SECRET ??= 'test-instance-shared-secret-32-bytes-min';

// Keycloak is the only auth provider since #517, so `assertKeycloakConfigured`
// runs unconditionally at `src/config.ts` import — it used to return early under
// the default `AUTH_PROVIDER=betterauth`. Without these, every test that reaches
// the config chain fails to *import*, not to assert. Set here rather than in the
// ~15 affected test files so there is one place to change.
process.env.KEYCLOAK_BASE_URL ??= 'http://localhost:8080/auth';
process.env.KEYCLOAK_ACCEPTED_CLIENT_IDS ??= 'signals-ui';
