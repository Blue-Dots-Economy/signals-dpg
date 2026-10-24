import { createRequire } from 'node:module';
import fastify, { type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import {
  apiConfig,
  apiReferenceEnabled,
  getCurrentApiBaseUrl,
  instance,
  uiHostBindings,
} from '@/config';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyQs from 'fastify-qs';
import fastifySwagger from '@fastify/swagger';
import {
  allowed_origins,
  getAllowedInstanceOriginsFromNetworkConfig,
  mergeAllowedOrigins,
  unknownBindingDomains,
} from '@dpg/config';
import v1_routes from '@/routes/v1/v1_routes';
import { EXPORT_EXPOSED_HEADERS } from '@/services/action_export/headers';
import { requestIdOptions, registerRequestIdEcho } from '@/request_id';
import health_routes from '@/routes/health/health_route';
import { getNetworkConfigs } from '@/network_configs';
import {
  clearNetworkSchemaCache,
  refreshConsumedSchemas,
} from '@/network_schema_cache';
import { getEmailMessages } from '@/notifications/email/messages';
import { getSmsTemplates } from '@/notifications/sms/templates';
import { registerRawBodyCapture } from '@/plugins/raw_body';

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

const baseJsonSchemaTransform = createJsonSchemaTransform({});

// Operations served without user auth; the spec's default security is
// cleared for these. Documentation only, so keep it in sync with the route
// preHandlers (see apps/api/CLAUDE.md "Route auth wiring"). A missing entry
// only over-documents auth on a public route; runtime auth is unaffected.
const PUBLIC_OPERATION_URLS = new Set([
  '/',
  '/health/live',
  '/health/ready',
  '/api/v1/auth/config',
  '/api/v1/auth/u18-precheck',
  '/api/v1/consent/status-by-identifier',
  '/api/v1/network/schemas',
  '/api/v1/network/item/fetch',
  // The BFF login flow: how a browser obtains a session.
  '/api/v1/auth/session',
  '/api/v1/auth/session/login',
  '/api/v1/auth/session/callback',
  '/api/v1/auth/session/logout',
]);

// Operations guarded by peer_instance_guard (inter-instance HMAC) instead of
// user auth.
const PEER_OPERATION_URLS = new Set([
  '/api/v1/network/item/count_local',
  '/api/v1/network/item/fetch_local',
  '/api/v1/network/item/markers_local',
  // Asserts identity in its body, so it is peer-authenticated.
  '/api/v1/network/action/perform',
]);

import { setBrowserAllowedOrigins } from '@/services/auth/oidc_flow_state';
import { loadCountryBoundary } from '@/services/geocoding/country_boundary';

// Public responses that must still not be cached. `status-by-identifier`
// answers "is this identifier registered?", so a shared proxy would re-serve
// that enumeration answer; `auth/config` describes the instance's auth wiring.
// Every other public route keeps its own caching semantics.
const NO_STORE_PUBLIC_URLS = new Set([
  '/api/v1/auth/config',
  '/api/v1/consent/status-by-identifier',
  // Carries the per-session CSRF token but resolves no `request.user` (it
  // reads the cookie itself), so the authenticated branch of the no-store hook
  // misses it; a shared proxy could otherwise hand one user's token to another.
  '/api/v1/auth/session',
]);

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
 * Builds the fully wired Fastify app without listening. Used by the server
 * entry, the OpenAPI dump script, and the OpenAPI smoke test.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
    trustProxy: true,
    // Honours and length-caps an inbound `x-request-id`, mints one when
    // absent, and logs it as `reqId` (see @/request_id).
    ...requestIdOptions,
  });

  registerRequestIdEcho(app);

  // UI_HOST_BINDINGS is parsed at module load, before a logger exists, so its
  // warnings surface here. Malformed entries were already dropped; this is the
  // only signal an operator gets that a portal link is misconfigured.
  for (const warning of uiHostBindings.warnings) {
    app.log.warn(warning);
  }
  const unknown = unknownBindingDomains(
    uiHostBindings.byDomain,
    apiConfig.served_domains.map((b) => b.domain)
  );
  if (unknown.length > 0) {
    app.log.warn(
      { domains: unknown },
      'UI_HOST_BINDINGS names domains this instance does not serve — their emails will fall back to FRONTEND_BASE_URL'
    );
  }

  // The schema cache lives on disk under tmpdir() and survives restarts, so in
  // local mode a cache from a previously configured network would keep being
  // served. Wipe and rebuild on boot; remote mode keeps the cache because its
  // schemas are expensive to refetch. Rebuilding queries the `items` table, so
  // it needs Postgres; SCHEMA_CACHE_WARMUP_ENABLED=false (the OpenAPI dump)
  // skips it, which is safe because route registration never reads the cache.
  if (
    apiConfig.network_config_source === 'local' &&
    apiConfig.schema_cache_warmup_enabled
  ) {
    await clearNetworkSchemaCache();
    await refreshConsumedSchemas();
  }

  // Load email copy at boot: a defect in the required bundled defaults throws
  // here rather than on the first send, and fallback warnings for an
  // EMAIL_MESSAGES_PATH override land in deploy logs. Filesystem only, so it
  // runs unconditionally.
  await getEmailMessages();

  // Loaded at boot so a bad registry shows in deploy logs. Never throws: SMS
  // is best-effort and dispatchSms skips an unconfigured template.
  await getSmsTemplates();

  // Country boundary for the supplied-coordinate check, loaded at boot so a
  // bad ConfigMap is a deploy-log warning. Never throws: an unloadable
  // boundary only disables that check.
  await loadCountryBoundary();

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

  // The BFF login validates `appOrigin` and the request Host against the CORS
  // list, so the origins a browser may call from and be redirected to match.
  setBrowserAllowedOrigins(corsAllowedOrigins);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Capture raw JSON bytes for peer_instance_guard (see plugins/raw_body.ts).
  registerRawBodyCapture(app);

  // Responses for a resolved user carry PII or session state, so they get
  // no-store, as do NO_STORE_PUBLIC_URLS. Other public responses keep their own
  // caching. A route that already set Cache-Control wins.
  app.addHook('onSend', async (request, reply, payload) => {
    const needsNoStore =
      request.user || NO_STORE_PUBLIC_URLS.has(request.url.split('?')[0]);
    if (needsNoStore && !reply.getHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  /**
   * Cookie parsing for the BFF browser session. Registered at the root scope
   * before any route: registered later or in an encapsulated scope, the session
   * routes and cookie auth channel silently see no cookies.
   *
   * No `secret`: `sid` is an opaque random id looked up in Redis, so signing
   * it would prove nothing the lookup does not.
   */
  await app.register(cookie);

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
    // Lets the cross-origin UI read the export filename and counts.
    exposedHeaders: [...EXPORT_EXPOSED_HEADERS],
  });

  // Query string parser - supports bracket notation (e.g. itemState[userId]=value)
  await app.register(fastifyQs, {});

  // Off by default; the published reference is the bluedots-docs site (see
  // apiReferenceEnabled in @/config).
  if (apiReferenceEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Signals DPG API',
          description:
            'Network-aware Signals DPG API — items, actions, events, consent, network fetch, admin.\n\n' +
            'Unless marked otherwise, operations require authentication via either the `apiKeyAuth` ' +
            'or `sessionAuth` scheme (the spec default). Public operations carry no Authorizations ' +
            'section; the four inter-instance peer operations (the three `*_local` reads and `action/perform`) use the service-to-service ' +
            '`peerAuth` scheme instead. Admin and aggregator operations additionally require the ' +
            '`x-acting-org-id` header (optional on action operations). See ' +
            '`docs/operations/integrating-dpgs.md` for the full auth model.',
          version: pkg.version,
        },
        // Default for every operation; documentAuthTransform applies the
        // exceptions. Two alternatives: an api key, or the session cookie plus
        // the CSRF token (paired so generated clients discover the header; it
        // is enforced only on unsafe methods).
        security: [{ apiKeyAuth: [] }, { sessionAuth: [], csrfToken: [] }],
        // Tag descriptions make starlight-openapi emit an overview page per group.
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
                'machine clients (apps/api/plugins/auth/auth_middleware.ts). Takes priority over ' +
                'session auth: if present and invalid the request is rejected outright, with no ' +
                'fallback to a session. Routes under /api/v1/admin and /api/v1/aggregator ' +
                'additionally require an `x-acting-org-id` header identifying the organization the ' +
                'request acts on behalf of — see docs/operations/integrating-dpgs.md.',
            },
            sessionAuth: {
              type: 'apiKey',
              in: 'cookie',
              name: 'sid',
              description:
                'Opaque browser-session cookie issued by the BFF after sign-in, used by the web UI ' +
                '(apps/api/plugins/auth/resolve_browser_session.ts). httpOnly, so script cannot ' +
                'read it; the access and refresh tokens live server-side in Redis and never reach ' +
                'the browser. Checked when x-api-key is absent, before the bearer path. This is ' +
                'the only session channel a browser has — #517 removed the better-auth cookie ' +
                'that used to sit alongside it. **Every unsafe method ' +
                '(anything but GET/HEAD/OPTIONS) additionally requires the `x-csrf-token` header ' +
                'echoing the value from `GET /api/v1/auth/session`; without it the request is ' +
                'refused with 403 CSRF_TOKEN_INVALID.**',
            },
            csrfToken: {
              type: 'apiKey',
              in: 'header',
              name: 'x-csrf-token',
              description:
                'Per-session CSRF token for the cookie channel, read from `GET /api/v1/auth/session` ' +
                'and echoed on every state-changing request. A cookie is attached by the browser ' +
                'automatically, so this double-submit token is what a cross-site page cannot supply ' +
                '— it can cause the cookie to be sent but cannot read the response that carries ' +
                'this value. Not required on GET/HEAD/OPTIONS, and not used by the x-api-key or ' +
                'bearer channels.',
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

  app.register(v1_routes, { prefix: '/api/v1' });

  return app;
}
