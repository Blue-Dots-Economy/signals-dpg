import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const dispatchEmailMock = vi.fn();
/** Running count the mocked fixed-window counter returns (rate-limit tests). */
const incrWithinWindowMock = vi.fn(async () => 1);

function mockDeps(cfg: {
  recipients?: string;
  cc?: string;
  fromEmail?: string;
  linkBaseUrl?: string;
  teamName?: string;
  client?: boolean;
  attachmentMaxTotalBytes?: number;
  attachmentMaxFiles?: number;
}) {
  vi.doMock('@/utils/rate_window', () => ({ incrWithinWindow: incrWithinWindowMock }));
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
      attachmentMaxTotalBytes: cfg.attachmentMaxTotalBytes ?? 5 * 1024 * 1024,
      attachmentMaxFiles: cfg.attachmentMaxFiles ?? 3,
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
    incrWithinWindowMock.mockReset();
    incrWithinWindowMock.mockResolvedValue(1);
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
    const arg = dispatchEmailMock.mock.calls[0][0];
    expect(arg.replyTo).toBe('from@org.com');
    // No linkBaseUrl configured here: fromSite must be empty, not omitted or
    // a stray " from undefined" — this is the no-link branch of the subject.
    expect(arg.variables.fromSite).toBe('');
    expect(arg.variables.type).toBe('Support Request');
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

describe('POST /api/v1/support — attachments (#551)', () => {
  const png = (bytes: number) => ({
    filename: 'evidence.png',
    contentType: 'image/png',
    data: Buffer.alloc(bytes, 7).toString('base64'),
  });

  beforeEach(() => {
    vi.resetModules();
    dispatchEmailMock.mockReset();
    dispatchEmailMock.mockResolvedValue({ ok: true });
    incrWithinWindowMock.mockReset();
    incrWithinWindowMock.mockResolvedValue(1);
  });

  it('forwards accepted attachments and lists them in the details table', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(2048)] },
    });
    expect(res.statusCode).toBe(201);
    const arg = dispatchEmailMock.mock.calls[0][0];
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe('evidence.png');
    expect(arg.attachments[0].contentType).toBe('image/png');
    expect(arg.attachments[0].data).toBe(png(2048).data);
    expect(arg.variables.detailsTable).toContain('Attachments (1)');
    expect(arg.variables.detailsTable).toContain('evidence.png');
    await app.close();
  });

  it('omits the attachments key when none are submitted', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    expect(dispatchEmailMock.mock.calls[0][0]).not.toHaveProperty('attachments');
    expect(dispatchEmailMock.mock.calls[0][0].variables.detailsTable).not.toContain('Attachments');
    await app.close();
  });

  it('strips a path from the submitted filename before it reaches the email', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: {
        ...validPayload,
        attachments: [{ ...png(64), filename: '../../etc/passwd.png' }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(dispatchEmailMock.mock.calls[0][0].attachments[0].filename).toBe('passwd.png');
    await app.close();
  });

  it('returns 400 ATTACHMENT_COUNT_EXCEEDED past the configured file count', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com', attachmentMaxFiles: 2 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(16), png(16), png(16)] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ATTACHMENT_COUNT_EXCEEDED');
    expect(res.json().message).toContain('2 files');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 ATTACHMENT_TOO_LARGE past the configured byte budget', async () => {
    mockDeps({
      recipients: 'support@org.com',
      fromEmail: 'from@org.com',
      attachmentMaxTotalBytes: 4096,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(3000), png(3000)] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ATTACHMENT_TOO_LARGE');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 ATTACHMENT_TYPE_NOT_ALLOWED for a disallowed content type', async () => {
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: {
        ...validPayload,
        attachments: [{ filename: 'payload.exe', contentType: 'application/x-msdownload', data: 'eA==' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
    expect(res.json().message).toContain('payload.exe');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 413 when the body exceeds the derived limit', async () => {
    // 64KB budget => ~85KB base64 + 256KB headroom; a 512KB payload is over it.
    mockDeps({
      recipients: 'support@org.com',
      fromEmail: 'from@org.com',
      attachmentMaxTotalBytes: 64 * 1024,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(512 * 1024)] },
    });
    expect(res.statusCode).toBe(413);
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('counts an invalid submission against the quota, not just accepted ones', async () => {
    // The body is already buffered and parsed by the time the handler runs, so a
    // rejected submission costs the same as an accepted one. If only accepted
    // ones counted, a caller could post oversized rubbish without limit.
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com', attachmentMaxFiles: 2 });
    const app = await buildApp();
    const png = {
      filename: 'a.png',
      contentType: 'image/png',
      data: Buffer.alloc(16, 7).toString('base64'),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png, png, png] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ATTACHMENT_COUNT_EXCEEDED');
    expect(incrWithinWindowMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('429s an over-quota caller before it even looks at the attachments', async () => {
    incrWithinWindowMock.mockResolvedValue(6);
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com', attachmentMaxFiles: 1 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: {
        ...validPayload,
        attachments: [
          { filename: 'run.exe', contentType: 'application/x-msdownload', data: 'eA==' },
        ],
      },
    });
    expect(res.statusCode).toBe(429);
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

});

describe('POST /api/v1/support — rate limit (#551)', () => {
  beforeEach(() => {
    vi.resetModules();
    dispatchEmailMock.mockReset();
    dispatchEmailMock.mockResolvedValue({ ok: true });
    incrWithinWindowMock.mockReset();
  });

  it('returns 429 SUPPORT_RATE_LIMITED once the window max is passed', async () => {
    incrWithinWindowMock.mockResolvedValue(6);
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('SUPPORT_RATE_LIMITED');
    expect(dispatchEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows the submission at the window max', async () => {
    incrWithinWindowMock.mockResolvedValue(5);
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('fails open when the counter backend is down, rather than blocking a complaint', async () => {
    incrWithinWindowMock.mockRejectedValue(new Error('redis down'));
    mockDeps({ recipients: 'support@org.com', fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    expect(dispatchEmailMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not consume quota when support is not configured', async () => {
    mockDeps({ recipients: undefined, fromEmail: 'from@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(incrWithinWindowMock).not.toHaveBeenCalled();
    await app.close();
  });
});
