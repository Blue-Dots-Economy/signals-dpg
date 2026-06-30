import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Unit tests for POST /api/v1/admin/participant/decrypt.
 * Mounts the route in isolation with mocked config + db and a stubbed
 * request.acting_org. Verifies request validation and the acting-org
 * gating matrix without touching a database.
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
  authConfig: { secret: 'test-secret', middleware_enabled: false, url: '', create_test_otp: false },
  databasesConfig: { pg_url: 'postgres://localhost/test' },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {}, databases: {}, matchScore: {}, notification: {},
  networkRuntime: {}, schemaRegistry: {},
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

// item_decrypt is exercised by the integration test; stub it here so the unit
// suite never needs the PII key.
vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: (row: { item_state: Record<string, unknown> }) => ({ mergedState: row.item_state }),
}));

const uuid = '11111111-1111-4111-8111-111111111111';

async function buildApp(orgType: 'aggregator' | 'network_service' | 'voice' | null) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  if (orgType) {
    app.addHook('preHandler', async (request) => {
      request.acting_org = { org_id: 'org_test', org_type: orgType, service_user_id: 'usr_test' };
    });
  }
  const { participant_decrypt } = await import('../participant_decrypt');
  await app.register(participant_decrypt);
  return app;
}

describe('POST /api/v1/admin/participant/decrypt (unit)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp('network_service'); });

  it('rejects a body with neither item_ids nor user_id (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/participant/decrypt', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body with both item_ids and user_id (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/participant/decrypt',
      payload: { item_ids: [uuid], user_id: 'usr_1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty item_ids array (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/participant/decrypt', payload: { item_ids: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing acting_org (403 INVALID_ACTING_ORG)', async () => {
    const app2 = await buildApp(null);
    const res = await app2.inject({ method: 'POST', url: '/participant/decrypt', payload: { item_ids: [uuid] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INVALID_ACTING_ORG');
  });

  it('rejects a voice acting org (403 ACTING_ORG_TYPE_NOT_ALLOWED)', async () => {
    const app2 = await buildApp('voice');
    const res = await app2.inject({ method: 'POST', url: '/participant/decrypt', payload: { item_ids: [uuid] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });
});
