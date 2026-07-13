import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const notifyMock = vi.fn();

function mockDeps(cfg: { recipient?: string; fromEmail?: string; client?: boolean }) {
  vi.doMock('@api/plugins/auth/auth_middleware', () => ({
    auth_middleware_if_enabled: async (req: { user?: { id: string } }) => {
      req.user = { id: 'u1' };
    },
  }));
  vi.doMock('@/utils/notificationClient', () => ({
    getNotificationClient: () => (cfg.client === false ? undefined : { notify: notifyMock }),
  }));
  vi.doMock('@/config', () => ({
    supportConfig: { recipient: cfg.recipient, fromEmail: cfg.fromEmail },
    apiConfig: { served_domains: [{ network: 'blue_dot', domain: 'seeker', key: 'blue_dot/seeker' }] },
    instance: { INSTANCE_NAME: 'Blue Dot' },
  }));
  vi.doMock('@api/db/postgres/drizzle_config', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ name: 'Asha', email: 'asha@example.com', phone: '+919000000000' }]),
          }),
        }),
      }),
    },
  }));
}

async function buildApp() {
  const { submit_support } = await import('../submit_support');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(submit_support, { prefix: '/api/v1/support' });
  await app.ready();
  return app;
}

describe('POST /api/v1/support', () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(undefined);
  });

  it('sends the support email and returns 201', async () => {
    mockDeps({ recipient: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { subject: 'Help', message: 'It broke' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0][0];
    expect(arg.to).toBe('support@org.com');
    expect(arg.variables.replyTo).toBe('asha@example.com');
    expect(arg.variables.subject).toContain('Help');
    expect(arg.variables.html).toContain('It broke');
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when SUPPORT_EMAIL is unset', async () => {
    mockDeps({ recipient: undefined, fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: { message: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(notifyMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when message is empty', async () => {
    mockDeps({ recipient: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: { message: '' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 502 SUPPORT_SEND_FAILED when the notification send rejects', async () => {
    mockDeps({ recipient: 'support@org.com', fromEmail: 'from@org.com' });
    notifyMock.mockRejectedValue(new Error('smtp down'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: { message: 'x' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('SUPPORT_SEND_FAILED');
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when the notification client is unavailable', async () => {
    mockDeps({ recipient: 'support@org.com', fromEmail: 'from@org.com', client: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: { message: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(notifyMock).not.toHaveBeenCalled();
    await app.close();
  });
});
