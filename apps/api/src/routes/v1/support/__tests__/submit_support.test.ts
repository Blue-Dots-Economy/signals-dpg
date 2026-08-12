import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const dispatchEmailMock = vi.fn();

function mockDeps(cfg: {
  recipients?: string;
  cc?: string;
  fromEmail?: string;
  linkBaseUrl?: string;
  teamName?: string;
  client?: boolean;
}) {
  vi.doMock('@api/plugins/auth/auth_middleware', () => ({
    auth_middleware_if_enabled: async (req: { user?: { id: string } }) => {
      req.user = { id: 'u1' };
    },
  }));
  vi.doMock('@/notifications/email/dispatch_email', () => ({
    getDefaultEmailSender: () =>
      cfg.client === false ? null : { dispatchEmail: dispatchEmailMock },
  }));
  vi.doMock('@/config', () => ({
    supportConfig: {
      recipients: cfg.recipients,
      cc: cfg.cc,
      fromEmail: cfg.fromEmail,
      linkBaseUrl: cfg.linkBaseUrl,
      teamName: cfg.teamName ?? 'Blue Dot',
    },
    instance: { INSTANCE_NAME: 'Blue Dot' },
  }));
  vi.doMock('@api/db/postgres/drizzle_config', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: 'u1' }]),
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

const validPayload = {
  name: 'Asha',
  email: 'asha@example.com',
  phone: '+919000000000',
  type: 'complaint',
  details: 'It broke',
  consent: true,
};

describe('POST /api/v1/support', () => {
  beforeEach(() => {
    vi.resetModules();
    dispatchEmailMock.mockReset();
    dispatchEmailMock.mockResolvedValue({ ok: true });
  });

  it('sends the support email and returns 201 with a reference', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com', linkBaseUrl: 'https://x.org' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(res.json().reference).toMatch(/^SUP-\d{8}-/);
    expect(dispatchEmailMock).toHaveBeenCalledTimes(1);
    const arg = dispatchEmailMock.mock.calls[0][0];
    expect(arg.caseId).toBe('support.request');
    expect(arg.to).toBe('support@org.com');
    expect(arg.replyTo).toBe('asha@example.com');
    expect(arg.dedupeId).toBe(res.json().reference);
    expect(arg.variables.reference).toBe(res.json().reference);
    expect(arg.variables.type).toBe('Complaint');
    expect(arg.variables.name).toBe('Asha');
    expect(arg.variables.fromSite).toBe(' from https://x.org');
    expect(arg.variables.details).toBe('It broke');
    expect(arg.variables.teamName).toBe('Blue Dot');
    expect(arg.variables.detailsTable).toContain('asha@example.com');
    expect(arg.cc).toBeUndefined();
    await app.close();
  });

  it('passes multiple recipients through to `to` and cc into the call', async () => {
    mockDeps({
      recipients: 'a@org.com, b@org.com',
      cc: 'c@org.com, d@org.com',
      fromEmail: 'from@org.com',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    const arg = dispatchEmailMock.mock.calls[0][0];
    expect(arg.to).toBe('a@org.com, b@org.com');
    expect(arg.cc).toBe('c@org.com, d@org.com');
    await app.close();
  });

  it('falls back replyTo to fromEmail when only a phone is given', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { name: 'Asha', phone: '+919000000000', type: 'support_request', details: 'x', consent: true },
    });
    expect(res.statusCode).toBe(201);
    expect(dispatchEmailMock.mock.calls[0][0].replyTo).toBe('from@org.com');
    await app.close();
  });

  it('returns 400 CONTACT_REQUIRED when neither email nor phone is given', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { name: 'Asha', type: 'complaint', details: 'x', consent: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CONTACT_REQUIRED');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when consent is not true', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, consent: false },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when details is empty', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, details: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for whitespace-only details (M2 trim)', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, details: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when SUPPORT_EMAIL is unset', async () => {
    mockDeps({ recipients: undefined, fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when the default email sender is unavailable', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com', client: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 502 SUPPORT_SEND_FAILED when dispatchEmail rejects', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    dispatchEmailMock.mockRejectedValue(new Error('smtp down'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('SUPPORT_SEND_FAILED');
    await app.close();
  });
});
