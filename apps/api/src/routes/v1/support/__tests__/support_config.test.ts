import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

function mockDeps(cfg: {
  recipients?: string;
  client?: boolean;
  maxTotalBytes?: number;
  maxFiles?: number;
  authenticated?: boolean;
}) {
  vi.doMock('@api/plugins/auth/auth_middleware', () => ({
    auth_middleware_if_enabled: async (req: { user?: { id: string } }) => {
      if (cfg.authenticated !== false) req.user = { id: 'u1' };
    },
  }));
  vi.doMock('@/utils/notificationClient', () => ({
    getNotificationClient: () => (cfg.client === false ? undefined : { send: vi.fn() }),
  }));
  vi.doMock('@/config', () => ({
    supportConfig: {
      recipients: cfg.recipients,
      attachmentMaxTotalBytes: cfg.maxTotalBytes ?? 5 * 1024 * 1024,
      attachmentMaxFiles: cfg.maxFiles ?? 3,
    },
    instance: { INSTANCE_NAME: 'Blue Dot' },
  }));
}

async function buildApp() {
  const { support_config } = await import('../support_config');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(support_config, { prefix: '/api/v1/support' });
  await app.ready();
  return app;
}

const get = async (app: Awaited<ReturnType<typeof buildApp>>) =>
  app.inject({ method: 'GET', url: '/api/v1/support/config' });

describe('GET /api/v1/support/config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports enabled with the configured limits and allowlist', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      maxTotalBytes: 5 * 1024 * 1024,
      maxFiles: 3,
    });
    expect(res.json().allowedTypes).toContain('image/png');
    expect(res.json().allowedTypes).toContain('audio/amr');
    // Extensions ride along so the picker can match files macOS won't resolve
    // from the MIME type alone (.m4a against audio/mp4).
    expect(res.json().allowedExtensions).toContain('.m4a');
    await app.close();
  });

  it('serves overridden limits, so the form follows the env without a rebuild', async () => {
    mockDeps({
      recipients: 'support@org.com',
      maxTotalBytes: 1024,
      maxFiles: 1,
    });
    const app = await buildApp();
    expect((await get(app)).json()).toMatchObject({ maxTotalBytes: 1024, maxFiles: 1 });
    await app.close();
  });

  // The submit route 503s on exactly these two conditions; enabled must agree
  // with it or the UI shows a form that cannot succeed.
  it('reports disabled when no recipient is configured', async () => {
    mockDeps({ recipients: undefined });
    const app = await buildApp();
    expect((await get(app)).json().enabled).toBe(false);
    await app.close();
  });

  it('reports disabled when the notification client is unavailable', async () => {
    mockDeps({ recipients: 'support@org.com', client: false });
    const app = await buildApp();
    expect((await get(app)).json().enabled).toBe(false);
    await app.close();
  });

  it('requires authentication', async () => {
    mockDeps({ recipients: 'support@org.com', authenticated: false });
    const app = await buildApp();
    const res = await get(app);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
    await app.close();
  });
});
