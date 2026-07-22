import fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import AuthRoutes from '@/routes/auth';
import { apiConfig, getCurrentApiBaseUrl, instance } from '@/config';
import cors from '@fastify/cors';
import fastifyQs from 'fastify-qs';
import fastifySwagger from '@fastify/swagger';
import 'dotenv/config';
import {
  allowed_origins,
  getAllowedInstanceOriginsFromNetworkConfig,
  mergeAllowedOrigins,
} from '@dpg/config';
import v1_routes from '@/routes/v1/v1_routes';
import { requestIdOptions, registerRequestIdEcho } from '@/request_id';
import health_routes from '@/routes/health/health_route';
import { pool } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';
import { getNetworkConfigs } from '@/network_configs';
import {
  clearNetworkSchemaCache,
  refreshConsumedSchemas,
} from '@/network_schema_cache';

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
if (apiConfig.network_config_source === 'local') {
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

// Documentation
await app.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'DPG',
      description: 'DPG API Service',
      version: '1.0.0',
    },
    servers: [
      {
        url: getCurrentApiBaseUrl(),
        description: 'Current API instance',
      },
    ],
  },
  transform: createJsonSchemaTransform({}),
});
/**/
await app.register(import('@scalar/fastify-api-reference'), {
  routePrefix: '/api/reference',
});

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

// setup
await app
  .listen({
    port: apiConfig.port,
    host: '0.0.0.0',
  })
  .then((endpoint) => console.log('Server Endpoint: ', endpoint))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Shutting down (${signal})`);

  try {
    // Drain the HTTP server first (stop accepting requests), then close the
    // backing connections that were previously leaked on shutdown: the Postgres
    // pool and the Redis client.
    await app.close();
    await pool.end();
    await redis.quit();
  } catch (err) {
    app.log.error(err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
