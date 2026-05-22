import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// vi.mock factory — hoisted so it runs before the import below.
// Adjust the shape if necessary based on Task 4's actual DB call pattern.
const selectResults: {
  organization: Array<{ id: string; type: string }>;
  member: Array<{ id: string }>;
  nextTable: 'organization' | 'member';
} = { organization: [], member: [], nextTable: 'organization' };

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const table = selectResults.nextTable;
        selectResults.nextTable = table === 'organization' ? 'member' : 'organization';
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(selectResults[table])),
          })),
        };
      }),
    })),
  },
}));

// Import after mock so the mocked db is what acting_org_preHandler picks up.
// (This import will FAIL today — that's the point of Task 3: failing tests.)
import { acting_org_preHandler } from '../acting_org.js';

const makeReply = () => {
  const reply: any = {
    code: vi.fn(function (this: any) {
      return this;
    }),
    send: vi.fn(function (this: any) {
      return this;
    }),
  };
  return reply as FastifyReply;
};

const makeRequest = (
  overrides: { headers?: Record<string, string | string[]>; user?: { id: string } } = {},
): FastifyRequest =>
  ({
    headers: overrides.headers ?? {},
    user: overrides.user,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }) as unknown as FastifyRequest;

describe('acting_org preHandler', () => {
  beforeEach(() => {
    selectResults.organization = [];
    selectResults.member = [];
    selectResults.nextTable = 'organization';
  });

  it('replies 400 MISSING_ACTING_ORG when x-acting-org-id header is missing', async () => {
    const req = makeRequest({ user: { id: 'svc_user_1' } });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'MISSING_ACTING_ORG' }),
    );
  });

  it('replies 401 UNAUTHENTICATED when request.user is not set', async () => {
    const req = makeRequest({ headers: { 'x-acting-org-id': 'org_bbmp' } });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'UNAUTHENTICATED' }),
    );
  });

  it('replies 404 ACTING_ORG_NOT_FOUND when org_id does not exist', async () => {
    // selectResults.organization stays empty -> the org lookup returns [].
    const req = makeRequest({
      headers: { 'x-acting-org-id': 'org_nope' },
      user: { id: 'svc_user_1' },
    });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'ACTING_ORG_NOT_FOUND' }),
    );
  });

  it('replies 403 ACTING_ORG_TYPE_NOT_ALLOWED for an org with a non-allowed type', async () => {
    selectResults.organization = [{ id: 'org_x', type: 'consumer' }];
    const req = makeRequest({
      headers: { 'x-acting-org-id': 'org_x' },
      user: { id: 'svc_user_1' },
    });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'ACTING_ORG_TYPE_NOT_ALLOWED' }),
    );
  });

  it('replies 403 SERVICE_USER_NOT_REGISTERED when service user has no member rows', async () => {
    selectResults.organization = [{ id: 'org_bbmp', type: 'aggregator' }];
    selectResults.member = []; // user is not a member of anything
    const req = makeRequest({
      headers: { 'x-acting-org-id': 'org_bbmp' },
      user: { id: 'svc_user_1' },
    });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SERVICE_USER_NOT_REGISTERED' }),
    );
  });

  it('happy path — attaches acting_org and does NOT call reply.code/send', async () => {
    selectResults.organization = [{ id: 'org_bbmp', type: 'aggregator' }];
    selectResults.member = [{ id: 'mem_1' }];
    const req = makeRequest({
      headers: { 'x-acting-org-id': 'org_bbmp' },
      user: { id: 'svc_user_1' },
    });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    // Successful preHandler doesn't touch reply.
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    // It mutates request to attach the acting_org.
    expect((req as any).acting_org).toEqual({
      org_id: 'org_bbmp',
      org_type: 'aggregator',
      service_user_id: 'svc_user_1',
    });
  });

  it('happy path — accepts voice and network_service org_type values too', async () => {
    selectResults.organization = [{ id: 'org_voice', type: 'voice' }];
    selectResults.member = [{ id: 'mem_2' }];
    const req = makeRequest({
      headers: { 'x-acting-org-id': 'org_voice' },
      user: { id: 'svc_user_voice' },
    });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect((req as any).acting_org).toEqual({
      org_id: 'org_voice',
      org_type: 'voice',
      service_user_id: 'svc_user_voice',
    });
  });

  it('treats x-acting-org-id presented as an array header (multi-value) by using the first value', async () => {
    selectResults.organization = [{ id: 'org_bbmp', type: 'aggregator' }];
    selectResults.member = [{ id: 'mem_1' }];
    // Some HTTP setups deliver duplicated headers as string[]. The preHandler
    // should pick the first entry rather than crashing.
    const req = makeRequest({
      headers: { 'x-acting-org-id': ['org_bbmp', 'org_other'] },
      user: { id: 'svc_user_1' },
    });
    const reply = makeReply();
    await acting_org_preHandler(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect((req as any).acting_org?.org_id).toBe('org_bbmp');
  });
});
