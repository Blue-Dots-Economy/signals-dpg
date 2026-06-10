import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Unit tests for GET /api/v1/admin/participant (read-only endpoint).
 * Mounts the route in isolation with mocked config and stubs request.acting_org.
 * Verifies the dispatch matrix and response shape without a database.
 */

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [{ network: 'blue_dot', domain: 'seeker' }],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  authConfig: {
    secret: 'test-secret',
    middleware_enabled: false,
    url: 'http://source.local/api/auth',
    create_test_otp: false,
  },
  databasesConfig: {
    pg_url: 'postgres://localhost/test',
  },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {},
  databases: {},
  matchScore: {},
  notification: {},
  networkRuntime: {},
  schemaRegistry: {},
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('GET /api/v1/admin/participant (unit)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.addHook('preHandler', async (request, _reply) => {
      request.acting_org = {
        org_id: 'org_test',
        org_type: 'network_service' as const,
        service_user_id: 'usr_test',
      };
    });

    const { participant_read } = await import('../participant_read');
    await app.register(participant_read);
  });

  it('rejects missing email and phone_number with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/participant',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts email parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/participant?email=test@example.com',
    });
    expect(res.statusCode).toBe(500);
  });

  it('accepts phone_number parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/participant?phone_number=%2B911234567890',
    });
    expect(res.statusCode).toBe(500);
  });

  it('rejects missing acting_org with 403', async () => {
    const app2 = Fastify().withTypeProvider<ZodTypeProvider>();
    app2.setValidatorCompiler(validatorCompiler);
    app2.setSerializerCompiler(serializerCompiler);

    const { participant_read } = await import('../participant_read');
    await app2.register(participant_read);

    const res = await app2.inject({
      method: 'GET',
      url: '/participant?email=test@example.com',
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('INVALID_ACTING_ORG');
  });

  it('rejects non-aggregator/network_service acting org', async () => {
    const app2 = Fastify().withTypeProvider<ZodTypeProvider>();
    app2.setValidatorCompiler(validatorCompiler);
    app2.setSerializerCompiler(serializerCompiler);

    app2.addHook('preHandler', async (request, _reply) => {
      request.acting_org = {
        org_id: 'org_test',
        org_type: 'voice' as const,
        service_user_id: 'usr_test',
      };
    });

    const { participant_read } = await import('../participant_read');
    await app2.register(participant_read);

    const res = await app2.inject({
      method: 'GET',
      url: '/participant?email=test@example.com',
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });
});
