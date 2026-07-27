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
import { requestIdOptions, registerRequestIdEcho } from '@/request_id';
import health_routes from '@/routes/health/health_route';
import { getNetworkConfigs } from '@/network_configs';
import {
  clearNetworkSchemaCache,
  refreshConsumedSchemas,
} from '@/network_schema_cache';

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

const baseJsonSchemaTransform = createJsonSchemaTransform({});

// Operations served WITHOUT user auth (no preHandler on the route and no
// group-level auth hook) — the spec-level default security is cleared for
// these. Derived from the actual route wiring; keep in sync when a route's
// preHandler changes (see apps/api/CLAUDE.md "Route auth wiring"). Failure
// direction is safe: a forgotten entry documents auth on a public route — it
// never hides auth on a protected one; runtime auth is untouched either way.
const PUBLIC_OPERATION_URLS = new Set([
  '/',
  '/health/live',
  '/health/ready',
  '/api/v1/auth/config',
  '/api/v1/auth/u18-precheck',
  '/api/v1/consent/status-by-identifier',
  '/api/v1/network/schemas',
  '/api/v1/network/item/fetch',
  '/api/v1/network/action/perform',
]);

// Operations guarded by peer_instance_guard (inter-instance HMAC) instead of
// user auth.
const PEER_OPERATION_URLS = new Set(['/api/v1/network/item/count_local', '/api/v1/network/item/fetch_local']);

/**
 * Wraps the zod json-schema transform to make the auth model machine-readable
 * in the generated OpenAPI document: applies the public/peer security
 * exceptions and documents the `x-acting-org-id` header on the route groups
 * whose acting-org preHandlers read it (required for admin/aggregator via
 * acting_org.ts, optional for action via acting_org_optional.ts).
 */
const documentAuthTransform: typeof baseJsonSchemaTransform = (data) => {
  const transformed = baseJsonSchemaTransform(data);
  const { url } = transformed;
  const schema = { ...(transformed.schema as Record<string, unknown> | undefined) };

  if (PUBLIC_OPERATION_URLS.has(url) || url.startsWith('/api/v1/network/schema/')) {
    schema.security = [];
  } else if (PEER_OPERATION_URLS.has(url)) {
    schema.security = [{ peerAuth: [] }];
  }

  const actingOrgRequired = url.startsWith('/api/v1/admin') || url.startsWith('/api/v1/aggregator');
  if (actingOrgRequired || url.startsWith('/api/v1/action')) {
    schema.headers = {
      type: 'object',
      properties: {
        'x-acting-org-id': {
          type: 'string',
          description: actingOrgRequired
            ? 'Organization this request acts on behalf of. Required for admin/aggregator operations.'
            : 'Organization this request acts on behalf of. Optional: a non-admin actor can perform an action without acting for an org.',
        },
      },
      ...(actingOrgRequired ? { required: ['x-acting-org-id'] } : {}),
    };
  }

  return { ...transformed, schema: schema as typeof transformed.schema };
};

/**
 * Builds the fully-wired Fastify app WITHOUT listening. Used by the server
 * entry (which listens), the OpenAPI dump script, and the openapi smoke test.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
    trustProxy: true,
    // Correlation id: honour + length-cap an inbound `x-request-id`, mint one
    // when absent, log it as `reqId` (see @/request_id).
    ...requestIdOptions,
  });

  // Echo the resolved correlation id back on every response.
  registerRequestIdEcho(app);

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
            'Unless marked otherwise, operations require authentication via either the `apiKeyAuth` ' +
            'or `sessionAuth` scheme (the spec default). Public operations carry no Authorizations ' +
            'section; the two inter-instance `*_local` operations use the service-to-service ' +
            '`peerAuth` scheme instead. Admin and aggregator operations additionally require the ' +
            '`x-acting-org-id` header (optional on action operations). See ' +
            '`docs/operations/integrating-dpgs.md` for the full auth model.',
          version: pkg.version,
        },
        // Default for every operation; exceptions are applied per-route in
        // documentAuthTransform below.
        security: [{ apiKeyAuth: [] }, { sessionAuth: [] }],
        // Tag descriptions make starlight-openapi emit one overview page per
        // group in the published reference (tags without a description get
        // sidebar-group-only treatment).
        tags: [
          { name: 'health', description: 'Liveness and readiness probes for orchestrators (unauthenticated).' },
          { name: 'item', description: 'Create, fetch, update and delete items, and manage their lifecycle status.' },
          { name: 'action', description: 'Perform and track actions between items — single, bulk, and status updates.' },
          { name: 'event', description: 'Structured results of actions: store and fetch events.' },
          { name: 'match_score', description: 'Compatibility scoring between items.' },
          { name: 'network', description: 'Network-level schema discovery and cross-instance item reads.' },
          { name: 'admin', description: 'Administrative operations (aggregator upsert, participants). Requires the x-acting-org-id header.' },
          { name: 'aggregator', description: 'Aggregator-facing dashboard and export.' },
          { name: 'consent', description: 'Consent status and acceptance, including the under-18 guardian flows.' },
          { name: 'auth', description: 'Auth configuration and signup pre-checks.' },
          { name: 'user', description: 'Per-user domain preferences.' },
          { name: 'support', description: 'Contact-support form submission.' },
        ],
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
            peerAuth: {
              type: 'apiKey',
              in: 'header',
              name: 'x-instance-token',
              description:
                'Inter-instance HMAC token (paired with an `x-instance-timestamp` header), used ' +
                'only by peer Signals instances for the network `*_local` operations ' +
                '(src/middleware/peer_instance_guard.ts). Not for external callers.',
            },
          },
        },
      },
      transform: documentAuthTransform,
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
  app.register(health_routes);
  app.register(AuthRoutes);
  app.register(v1_routes, { prefix: '/api/v1' });

  return app;
}
