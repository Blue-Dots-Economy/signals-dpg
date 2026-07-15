import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMinorGuardian = vi.fn();

vi.mock('@/config', () => ({
  apiConfig: { served_domains: [{ network: 'blue_dot', domain: 'seeker' }] },
}));
vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));
vi.mock('@/services/minor_guardian_repo', () => ({
  getMinorGuardian: (...a: unknown[]) => getMinorGuardian(...a),
}));

import { u18_status_handler } from '../u18_status';

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (req: any) => {
  const reply = makeReply();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return u18_status_handler(req, reply as any).then(() => reply);
};

describe('u18_status_handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    const reply = await call({ user: undefined, query: { network: 'blue_dot' } });
    expect(reply.statusCode).toBe(401);
  });

  it('400 when the network is not served', async () => {
    const reply = await call({ user: { id: 'u1' }, query: { network: 'green_dot' } });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('UNKNOWN_NETWORK');
  });

  it('no stored birth data → hasBirthData:false, isMinor:false', async () => {
    getMinorGuardian.mockResolvedValue(null);
    const reply = await call({ user: { id: 'u1' }, query: { network: 'blue_dot' } });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ hasBirthData: false, isMinor: false, guardianVerified: false });
  });

  it('stored minor → hasBirthData:true, isMinor:true, carries guardianVerified', async () => {
    getMinorGuardian.mockResolvedValue({
      birthYear: 2015, birthMonth: 5, guardianContactType: 'email', guardianVerified: true,
    });
    const reply = await call({ user: { id: 'u1' }, query: { network: 'blue_dot' } });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ hasBirthData: true, isMinor: true, guardianVerified: true });
  });

  it('stored adult → hasBirthData:true, isMinor:false', async () => {
    getMinorGuardian.mockResolvedValue({
      birthYear: 1990, birthMonth: 5, guardianContactType: null, guardianVerified: false,
    });
    const reply = await call({ user: { id: 'u1' }, query: { network: 'blue_dot' } });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ hasBirthData: true, isMinor: false, guardianVerified: false });
  });
});
