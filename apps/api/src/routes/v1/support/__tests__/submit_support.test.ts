import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { NotifyTransportError, SUPPORT_REQUEST } from '@dpg/notification';

const ACCEPTED = { ok: true, status: 202, body: { notification_event_id: 'ne-1', correlation_id: 'c-1' } };
const sendMock = vi.fn();
/** Running count the mocked fixed-window counter returns (rate-limit tests). */
const incrWithinWindowMock = vi.fn(async () => 1);

function mockDeps(cfg: {
  recipients?: string;
  cc?: string;
  linkBaseUrl?: string;
  /** `null` = INSTANCE_NAME unset. */
  teamName?: string | null;
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
  vi.doMock('@/utils/notificationClient', () => ({
    getNotificationClient: () => (cfg.client === false ? undefined : { send: sendMock }),
  }));
  vi.doMock('@/config', () => ({
    supportConfig: {
      recipients: cfg.recipients,
      cc: cfg.cc,
      linkBaseUrl: cfg.linkBaseUrl,
      teamName: cfg.teamName === null ? undefined : (cfg.teamName ?? 'Blue Dot'),
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

async function buildApp(logLines?: string[]) {
  const { submit_support } = await import('../submit_support');
  const app = logLines
    ? Fastify({ logger: { level: 'warn', stream: { write: (line: string) => void logLines.push(line) } } })
    : Fastify();
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
    sendMock.mockReset();
    sendMock.mockResolvedValue(ACCEPTED);
    incrWithinWindowMock.mockReset();
    incrWithinWindowMock.mockResolvedValue(1);
  });

  it('sends the support.request event and returns 201 with a reference', async () => {
    mockDeps({ recipients: 'support@org.com', linkBaseUrl: 'https://x.org' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    const reference = res.json().reference as string;
    expect(reference).toMatch(/^SUP-\d{8}-/);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0][0];
    expect(arg).toEqual({
      event_type: SUPPORT_REQUEST,
      domain: null,
      to: { email: 'support@org.com' },
      reply_to: 'asha@example.com',
      variables: {
        reference,
        type: 'Complaint',
        name: 'Asha',
        fromSite: ' from https://x.org',
        details: 'It broke',
        teamName: 'Blue Dot',
        phone: '+919000000000',
        email: 'asha@example.com',
        submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        attachmentsSummary: 'none',
      },
      priority: 'normal',
      idempotency_key: reference,
    });
    await app.close();
  });

  it('gives two submissions two idempotency keys (R12: the reference is the occurrence)', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    const [first, second] = sendMock.mock.calls.map(([e]) => e.idempotency_key as string);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(128);
    await app.close();
  });

  it('sends the first recipient as `to` and the rest plus SUPPORT_CC_EMAIL as cc (F2-6)', async () => {
    mockDeps({ recipients: 'a@org.com, b@org.com', cc: 'c@org.com, d@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toEqual({ email: 'a@org.com' });
    expect(arg.cc).toEqual(['b@org.com', 'c@org.com', 'd@org.com']);
    await app.close();
  });

  it('de-duplicates cc (case-insensitively, and against `to`) and caps it at 10', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `cc${i}@org.com`).join(', ');
    mockDeps({ recipients: 'a@org.com, b@org.com, B@org.com', cc: `A@org.com, b@org.com, ${many}` });
    const logLines: string[] = [];
    const app = await buildApp(logLines);
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toEqual({ email: 'a@org.com' });
    expect(arg.cc).toHaveLength(10);
    expect(arg.cc[0]).toBe('b@org.com');
    expect(arg.cc.slice(1)).toEqual(Array.from({ length: 9 }, (_, i) => `cc${i}@org.com`));
    // The overflow is logged by count only, never by address.
    const dump = logLines.join('\n');
    expect(dump).toContain('"dropped":3');
    expect(dump).not.toContain('@org.com');
    await app.close();
  });

  it('omits cc when there is a single recipient and no SUPPORT_CC_EMAIL', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(sendMock.mock.calls[0][0]).not.toHaveProperty('cc');
    await app.close();
  });

  it('omits reply_to and fills the R5 "—" placeholders when only a phone is given', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { name: 'Asha', phone: '+919000000000', type: 'support_request', details: 'x', consent: true },
    });
    expect(res.statusCode).toBe(201);
    const arg = sendMock.mock.calls[0][0];
    // Replies then go to the deployment From address, as the old fallback to
    // NOTIFICATION_FROM_EMAIL did (F2-4).
    expect(arg).not.toHaveProperty('reply_to');
    expect(arg.variables.email).toBe('—');
    expect(arg.variables.phone).toBe('+919000000000');
    // No linkBaseUrl configured here: fromSite must be empty, not omitted or
    // a stray " from undefined" — this is the no-link branch of the subject.
    expect(arg.variables.fromSite).toBe('');
    expect(arg.variables.type).toBe('Support Request');
    await app.close();
  });

  it('fills phone with "—" when only an email is given', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { name: 'Asha', email: 'asha@example.com', type: 'complaint', details: 'x', consent: true },
    });
    expect(sendMock.mock.calls[0][0].variables.phone).toBe('—');
    await app.close();
  });

  it('falls back to "Support" as teamName when INSTANCE_NAME is unset', async () => {
    mockDeps({ recipients: 'support@org.com', teamName: null });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(sendMock.mock.calls[0][0].variables.teamName).toBe('Support');
    await app.close();
  });

  it('returns 400 CONTACT_REQUIRED when neither email nor phone is given', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { name: 'Asha', type: 'complaint', details: 'x', consent: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CONTACT_REQUIRED');
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when consent is not true', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, consent: false },
    });
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when details is empty', async () => {
    mockDeps({ recipients: 'support@org.com' });
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
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, details: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when SUPPORT_EMAIL is unset', async () => {
    mockDeps({ recipients: undefined });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when the notification client is unavailable', async () => {
    mockDeps({ recipients: 'support@org.com', client: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SUPPORT_NOT_CONFIGURED');
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 502 SUPPORT_SEND_FAILED when the service refuses the event (ok:false)', async () => {
    mockDeps({ recipients: 'support@org.com' });
    sendMock.mockResolvedValue({ ok: false, status: 422, error: 'no_policy', kind: 'configuration' });
    const logLines: string[] = [];
    const app = await buildApp(logLines);
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('SUPPORT_SEND_FAILED');
    const dump = logLines.join('\n');
    expect(dump).toContain('no_policy');
    expect(dump).not.toContain('asha@example.com');
    expect(dump).not.toContain('support@org.com');
    expect(dump).not.toContain('It broke');
    await app.close();
  });

  it('returns 502 SUPPORT_SEND_FAILED on a transport error', async () => {
    mockDeps({ recipients: 'support@org.com' });
    sendMock.mockRejectedValue(new NotifyTransportError('fetch failed: TypeError'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('SUPPORT_SEND_FAILED');
    await app.close();
  });

  it('returns 502 SUPPORT_SEND_FAILED on an unexpected error', async () => {
    mockDeps({ recipients: 'support@org.com' });
    sendMock.mockRejectedValue(new Error('boom'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(502);
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
    sendMock.mockReset();
    sendMock.mockResolvedValue(ACCEPTED);
    incrWithinWindowMock.mockReset();
    incrWithinWindowMock.mockResolvedValue(1);
  });

  it('passes accepted attachments through and summarises them in attachmentsSummary', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(2048)] },
    });
    expect(res.statusCode).toBe(201);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe('evidence.png');
    expect(arg.attachments[0].contentType).toBe('image/png');
    expect(arg.attachments[0].data).toBe(png(2048).data);
    expect(arg.attachments[0]).toEqual({ filename: 'evidence.png', contentType: 'image/png', data: png(2048).data });
    expect(arg.variables.attachmentsSummary).toBe('evidence.png (2.0 KB)');
    await app.close();
  });

  it('omits the attachments key when none are submitted', async () => {
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    expect(sendMock.mock.calls[0][0]).not.toHaveProperty('attachments');
    expect(sendMock.mock.calls[0][0].variables.attachmentsSummary).toBe('none');
    await app.close();
  });

  it('strips a path from the submitted filename before it reaches the email', async () => {
    mockDeps({ recipients: 'support@org.com' });
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
    expect(sendMock.mock.calls[0][0].attachments[0].filename).toBe('passwd.png');
    await app.close();
  });

  it('returns 400 ATTACHMENT_COUNT_EXCEEDED past the configured file count', async () => {
    mockDeps({ recipients: 'support@org.com', attachmentMaxFiles: 2 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(16), png(16), png(16)] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ATTACHMENT_COUNT_EXCEEDED');
    expect(res.json().message).toContain('2 files');
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 ATTACHMENT_TOO_LARGE past the configured byte budget', async () => {
    mockDeps({
      recipients: 'support@org.com',
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
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 ATTACHMENT_TYPE_NOT_ALLOWED for a disallowed content type', async () => {
    mockDeps({ recipients: 'support@org.com' });
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
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 413 when the body exceeds the derived limit', async () => {
    // 64KB budget => ~85KB base64 + 256KB headroom; a 512KB payload is over it.
    mockDeps({
      recipients: 'support@org.com',
      attachmentMaxTotalBytes: 64 * 1024,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support',
      payload: { ...validPayload, attachments: [png(512 * 1024)] },
    });
    expect(res.statusCode).toBe(413);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('counts an invalid submission against the quota, not just accepted ones', async () => {
    // The body is already buffered and parsed by the time the handler runs, so a
    // rejected submission costs the same as an accepted one. If only accepted
    // ones counted, a caller could post oversized rubbish without limit.
    mockDeps({ recipients: 'support@org.com', attachmentMaxFiles: 2 });
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
    mockDeps({ recipients: 'support@org.com', attachmentMaxFiles: 1 });
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
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

});

describe('POST /api/v1/support — rate limit (#551)', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    sendMock.mockResolvedValue(ACCEPTED);
    incrWithinWindowMock.mockReset();
  });

  it('returns 429 SUPPORT_RATE_LIMITED once the window max is passed', async () => {
    incrWithinWindowMock.mockResolvedValue(6);
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('SUPPORT_RATE_LIMITED');
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows the submission at the window max', async () => {
    incrWithinWindowMock.mockResolvedValue(5);
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('fails open when the counter backend is down, rather than blocking a complaint', async () => {
    incrWithinWindowMock.mockRejectedValue(new Error('redis down'));
    mockDeps({ recipients: 'support@org.com' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not consume quota when support is not configured', async () => {
    mockDeps({ recipients: undefined });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/support', payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(incrWithinWindowMock).not.toHaveBeenCalled();
    await app.close();
  });
});
