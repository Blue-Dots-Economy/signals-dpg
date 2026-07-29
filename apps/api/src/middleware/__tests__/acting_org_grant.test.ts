import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Acting-org authorisation by token grant (§5.1 of the Keycloak migration
 * design).
 *
 * The property that matters most is at the top: under the default
 * `ACTING_ORG_SOURCE=header` nothing changes, even when the token carries a
 * grant that contradicts the header. That is what makes this safe to merge.
 *
 * Everything else is the tightening: an asserted org outside the grant is
 * refused, where today any existing org id is honoured.
 */

// db calls in order: organization (by id), then member (by userId).
const selectResults: unknown[][] = [];
let selectCall = 0;

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResults[selectCall++] ?? [],
        }),
      }),
    }),
  },
}));

const mockAuthConfig = {
  acting_org_source: 'header' as 'header' | 'claim_preferred' | 'claim_required',
  acting_org_claim_enforced: false,
  acting_org_claim_required: false,
};

vi.mock('@/config', () => ({ authConfig: mockAuthConfig }));

const { acting_org_preHandler } = await import('../acting_org.js');

const ORG = 'org_bbmp';
const OTHER_ORG = 'org_someone_else';

const setMode = (mode: 'header' | 'claim_preferred' | 'claim_required') => {
  mockAuthConfig.acting_org_source = mode;
  mockAuthConfig.acting_org_claim_enforced = mode !== 'header';
  mockAuthConfig.acting_org_claim_required = mode === 'claim_required';
};

const makeReply = () => {
  const reply: Record<string, unknown> = {};
  reply.code = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply as unknown as FastifyReply & {
    code: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
};

const makeRequest = (opts: { header?: string; grant?: string[] } = {}) =>
  ({
    headers: opts.header ? { 'x-acting-org-id': opts.header } : {},
    user: { id: 'usr_service_1' },
    acting_org_grant: opts.grant,
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }) as unknown as FastifyRequest;

/** Queue an existing, allowed org plus a membership row so the happy path completes. */
const queueResolvableOrg = (type = 'aggregator') => {
  selectResults.push([{ id: ORG, type }], [{ id: 'mem_1' }]);
};

const errorOf = (reply: { send: ReturnType<typeof vi.fn> }) =>
  reply.send.mock.calls[0]?.[0]?.error;

beforeEach(() => {
  selectResults.length = 0;
  selectCall = 0;
  setMode('header');
});

describe('ACTING_ORG_SOURCE=header — unchanged behaviour', () => {
  it('honours the header and ignores the grant entirely', async () => {
    queueResolvableOrg();
    const req = makeRequest({ header: ORG });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org).toEqual({
      org_id: ORG,
      org_type: 'aggregator',
      service_user_id: 'usr_service_1',
    });
  });

  it('honours a header the grant does NOT permit', async () => {
    // Deliberate: `header` mode must not change behaviour for anyone, even
    // once partners start emitting grants. The tightening is opt-in.
    queueResolvableOrg();
    const req = makeRequest({ header: ORG, grant: [OTHER_ORG] });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org?.org_id).toBe(ORG);
  });

  it('still requires the header even when the grant names one org', async () => {
    const req = makeRequest({ grant: [ORG] });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(errorOf(reply)).toBe('MISSING_ACTING_ORG');
  });
});

describe('ACTING_ORG_SOURCE=claim_preferred', () => {
  beforeEach(() => setMode('claim_preferred'));

  it('allows a header inside the grant', async () => {
    queueResolvableOrg();
    const req = makeRequest({ header: ORG, grant: [ORG, OTHER_ORG] });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org?.org_id).toBe(ORG);
  });

  it('refuses a header outside the grant — the hole this closes', async () => {
    const req = makeRequest({ header: ORG, grant: [OTHER_ORG] });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(errorOf(reply)).toBe('ACTING_ORG_NOT_GRANTED');
    expect(req.acting_org).toBeUndefined();
    expect(req.log.warn).toHaveBeenCalled();
  });

  it('falls back to the header when the token carries no grant', async () => {
    // The compatibility window: partners adopt the claim independently.
    queueResolvableOrg();
    const req = makeRequest({ header: ORG });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org?.org_id).toBe(ORG);
  });

  it('treats an EMPTY grant as authorising nothing', async () => {
    // Distinct from an absent claim — empty is a real grant of nothing.
    const req = makeRequest({ header: ORG, grant: [] });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(errorOf(reply)).toBe('ACTING_ORG_NOT_GRANTED');
  });

  it('lets a single-org grant stand in for the header', async () => {
    // This is what allows human callers to stop sending the header.
    queueResolvableOrg();
    const req = makeRequest({ grant: [ORG] });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org?.org_id).toBe(ORG);
  });

  it('still needs the header when the grant is ambiguous', async () => {
    const req = makeRequest({ grant: [ORG, OTHER_ORG] });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(errorOf(reply)).toBe('MISSING_ACTING_ORG');
  });

  it('allows any org under a wildcard grant', async () => {
    // `["*"]` preserves today's platform-wide reach for network_service, as an
    // explicit auditable grant rather than an unstated default.
    queueResolvableOrg('network_service');
    const req = makeRequest({ header: ORG, grant: ['*'] });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org?.org_id).toBe(ORG);
  });

  it('does not let a wildcard stand in for a missing header', async () => {
    // A wildcard names no specific org, so there is nothing to default to.
    const req = makeRequest({ grant: ['*'] });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(errorOf(reply)).toBe('MISSING_ACTING_ORG');
  });

  it('still enforces the org-type gate on a granted org', async () => {
    // The grant authorises WHICH org, not WHAT it may do.
    selectResults.push([{ id: ORG, type: 'something_else' }]);
    const req = makeRequest({ header: ORG, grant: [ORG] });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(errorOf(reply)).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });
});

describe('ACTING_ORG_SOURCE=claim_required', () => {
  beforeEach(() => setMode('claim_required'));

  it('refuses a token with no grant at all', async () => {
    const req = makeRequest({ header: ORG });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(errorOf(reply)).toBe('ACTING_ORG_CLAIM_MISSING');
  });

  it('refuses before even looking at the header', async () => {
    // No header AND no grant should report the grant problem, which is the
    // actionable one for an operator mid-cutover.
    const req = makeRequest({});
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(errorOf(reply)).toBe('ACTING_ORG_CLAIM_MISSING');
  });

  it('allows a granted org', async () => {
    queueResolvableOrg();
    const req = makeRequest({ header: ORG, grant: [ORG] });

    await acting_org_preHandler(req, makeReply());

    expect(req.acting_org?.org_id).toBe(ORG);
  });

  it('refuses an x-api-key caller, which carries no grant', async () => {
    // Expected: claim_required is the terminal state, after the apikey path is
    // gone. Worth asserting so the failure is understood rather than surprising.
    const req = makeRequest({ header: ORG });
    const reply = makeReply();

    await acting_org_preHandler(req, reply);

    expect(errorOf(reply)).toBe('ACTING_ORG_CLAIM_MISSING');
  });
});
