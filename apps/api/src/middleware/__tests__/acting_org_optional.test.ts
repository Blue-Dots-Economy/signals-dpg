import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const stricts: Array<{ called: boolean }> = [];

vi.mock('../acting_org.js', () => ({
  acting_org_preHandler: vi.fn(async (req: FastifyRequest) => {
    stricts.push({ called: true });
    (req as any).acting_org = {
      org_id: 'org_voice',
      org_type: 'voice',
      service_user_id: 'svc',
    };
  }),
}));

import { acting_org_preHandler_optional } from '../acting_org_optional.js';

const makeReply = () => {
  const reply: any = {
    code: vi.fn(function (this: any) { return this; }),
    send: vi.fn(function (this: any) { return this; }),
  };
  return reply as FastifyReply;
};

const makeRequest = (overrides: { headers?: Record<string, string | string[]> } = {}): FastifyRequest =>
  ({
    headers: overrides.headers ?? {},
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }) as unknown as FastifyRequest;

describe('acting_org_preHandler_optional', () => {
  it('sets request.acting_org = undefined and does NOT call strict when header absent', async () => {
    stricts.length = 0;
    const req = makeRequest();
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect((req as any).acting_org).toBeUndefined();
    expect(reply.code).not.toHaveBeenCalled();
    expect(stricts).toHaveLength(0);
  });

  it('treats blank-after-trim header as absent', async () => {
    stricts.length = 0;
    const req = makeRequest({ headers: { 'x-acting-org-id': '   ' } });
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect((req as any).acting_org).toBeUndefined();
    expect(stricts).toHaveLength(0);
  });

  it('delegates to strict preHandler when header is present', async () => {
    stricts.length = 0;
    const req = makeRequest({ headers: { 'x-acting-org-id': 'org_voice' } });
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect(stricts).toHaveLength(1);
    expect((req as any).acting_org?.org_id).toBe('org_voice');
  });

  it('treats array-shaped header by checking first value for emptiness', async () => {
    stricts.length = 0;
    const req = makeRequest({ headers: { 'x-acting-org-id': ['  ', 'org_other'] } });
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect(stricts).toHaveLength(0);
    expect((req as any).acting_org).toBeUndefined();
  });
});
