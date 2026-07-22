import { createRequire } from 'node:module';
import fastify, { type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import AuthRoutes from '@/routes/auth';
import {
  apiConfig,
  apiReferenceEnabled,
  getCurrentApiBaseUrl,
  instance,
} from '@/config';
import cors from '@fastify/cors';
import fastifyQs from 'fastify-qs';
import fastifySwagger from '@fastify/swagger';
import {
  allowed_origins,
  getAllowedInstanceOriginsFromNetworkConfig,
  mergeAllowedOrigins,
} from '@dpg/config';
import v1_routes from '@/routes/v1/v1_routes';
import { getNetworkConfigs } from '@/network_configs';
import {
  clearNetworkSchemaCache,
  refreshConsumedSchemas,
} from '@/network_schema_cache';

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

/**
 * Builds the fully-wired Fastify app WITHOUT listening. Used by the server
 * entry (which listens), the OpenAPI dump script, and the openapi smoke test.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
    trustProxy: true,
  });

  // The schema cache lives on disk under tmpdir() and outlives a restart. In
  // local mode the network is driven by NETWORK_CONFIG_LOCAL_FILE, so a stale
  // cache from a previous network keeps being served after a switch. Wipe and
  // rebuild on boot so local dev always reflects the configured network.
  // Remote mode keeps the cache (schemas there are expensive to refetch).
  // Rebuilding queries the `items` table (cacheReferencedItemSchemas), so it
  // needs a reachable Postgres; SCHEMA_CACHE_WARMUP_ENABLED=false (used by
  // the OpenAPI dump script) skips it — safe because route registration
  // below is fully static and never reads the schema cache itself.
  if (
    apiConfig.network_config_source === 'local' &&
    apiConfig.schema_cache_warmup_enabled
  ) {
    await clearNetworkSchemaCache();
    await refreshConsumedSchemas();
  }

  const networkConfigs = await getNetworkConfigs();

  const networkAllowedOrigins = networkConfigs.flatMap((networkConfig) =>
    getAllowedInstanceOriginsFromNetworkConfig(
      networkConfig,
      apiConfig.served_domains
    )
  );

  const corsAllowedOrigins = mergeAllowedOrigins(
    allowed_origins,
    networkAllowedOrigins
  );

  // Add schema validator and serializer
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || corsAllowedOrigins.includes(origin)) {
        return cb(null, true);
      } else {
        return cb(new Error('Not allowed'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  });

  // Query string parser - supports bracket notation (e.g. itemState[userId]=value)
  await app.register(fastifyQs, {});

  // Documentation. Gated: the always-available reference is the
  // bluedots-docs site, so this is a secure-by-default local/dev convenience
  // (see apiReferenceEnabled in @/config).
  if (apiReferenceEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Signals DPG API',
          description:
            'Network-aware Signals DPG API — items, actions, events, consent, network fetch, admin.\n\n' +
            'Most `/api/v1` operations require authentication, via either the `apiKeyAuth` or ' +
            '`sessionAuth` scheme below. Per-operation `security` annotations are not yet applied ' +
            'in this spec (tracked as a follow-up) — the schemes are documented here for accuracy, ' +
            'but which scheme (and which additional headers, e.g. `x-acting-org-id` for admin/' +
            'aggregator routes) a given operation needs is not yet machine-readable. See ' +
            '`docs/operations/integrating-dpgs.md` for the full auth model.',
          version: pkg.version,
        },
        // Deployments are per network instance, so the published spec carries a
        // substitute-your-host URL (from the dump env's API_DOMAIN) plus a
        // local-dev entry; at runtime servers[0] is this instance's own URL.
        servers: [
          {
            url: getCurrentApiBaseUrl(),
            description: "Your deployment's public host (set per network instance)",
          },
          ...(getCurrentApiBaseUrl() === 'http://localhost:2742'
            ? []
            : [{ url: 'http://localhost:2742', description: 'Local development' }]),
        ],
        components: {
          securitySchemes: {
            apiKeyAuth: {
              type: 'apiKey',
              in: 'header',
              name: 'x-api-key',
              description:
                'Service API key used by integrating DPGs (aggregator-dpg, voice-dpg) and other ' +
                'machine clients (apps/api/plugins/auth/validate_api_key.ts). Takes priority over ' +
                'session auth: if present and invalid the request is rejected outright, with no ' +
                'fallback to a session. Routes under /api/v1/admin and /api/v1/aggregator ' +
                'additionally require an `x-acting-org-id` header identifying the organization the ' +
                'request acts on behalf of — see docs/operations/integrating-dpgs.md.',
            },
            sessionAuth: {
              type: 'apiKey',
              in: 'cookie',
              name: 'better-auth.session_token',
              description:
                'Browser session cookie issued by better-auth after sign-in, used by the web UI ' +
                '(apps/api/plugins/auth/validate_session.ts). Checked as a fallback only when ' +
                'x-api-key is absent.',
            },
          },
        },
      },
      transform: createJsonSchemaTransform({}),
    });
    await app.register(import('@scalar/fastify-api-reference'), {
      routePrefix: '/api/reference',
    });
  }

  // Routes
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/',
    handler: (_, res) => {
      res.send({
        service: instance.INSTANCE_NAME,
        status: 'ok',
        served_domains: apiConfig.served_domains,
        network_config_source: apiConfig.network_config_source,
      });
    },
  });
  app.register(AuthRoutes);
  app.register(v1_routes, { prefix: '/api/v1' });

  return app;
}
