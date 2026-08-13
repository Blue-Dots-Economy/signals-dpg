import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// Covers the four U18 guardian handlers: DOB capture, authenticated guardian
// OTP issue, guardian OTP verify, and the PRE-AUTH signup variant. Every
// dependency is mocked; the error classes are defined here (not imported) so
// the `instanceof` branches in the handlers are exercised for real.
const {
  rowQueue,
  inserts,
  dbState,
  WardLimitError,
  GuardianOtpError,
  SignupGuardianError,
  getWardAge,
  setWardAge,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
  isGuardianWardLimitReached,
  guardianContactMatchesWard,
  setGuardianVerified,
  resolveConsentVersion,
  issueGuardianOtp,
  verifyGuardianOtp,
  assertVerifyAttemptAllowed,
  guardianUserConsentRow,
  startSignupGuardian,
  verifySignupGuardian,
  redisIncr,
  redisExpire,
} = vi.hoisted(() => {
  class WardLimitErrorImpl extends Error {
    constructor() {
      super('GUARDIAN_WARD_LIMIT');
      this.name = 'WardLimitError';
    }
  }
  class GuardianOtpErrorImpl extends Error {
    constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED') {
      super(code);
      this.name = 'GuardianOtpError';
    }
  }
  class SignupGuardianErrorImpl extends Error {
    constructor(public code: string) {
      super(code);
      this.name = 'SignupGuardianError';
    }
  }
  return {
    rowQueue: [] as unknown[][],
    inserts: [] as { table: unknown; values: unknown }[],
    // Resettable failure flags — never monkey-patch the shared row queue, an
    // override there leaks into every later test in the file.
    dbState: { failWith: null as Error | null, failInsert: null as Error | null },
    WardLimitError: WardLimitErrorImpl,
    GuardianOtpError: GuardianOtpErrorImpl,
    SignupGuardianError: SignupGuardianErrorImpl,
    // Params are declared on every vi.fn: `vi.fn(() => ...)` infers a ZERO-arg
    // signature, which breaks the spread-through in the vi.mock factories.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getWardAge: vi.fn(async (..._a: any[]) => null as number | null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setWardAge: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsertGuardianDetails: vi.fn(async (..._a: any[]) => {}),
    getGuardianContactPlaintext: vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (..._a: any[]) => null as { contact: string; contactType: string } | null,
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isGuardianWardLimitReached: vi.fn(async (..._a: any[]) => false),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guardianContactMatchesWard: vi.fn((..._a: any[]) => false),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setGuardianVerified: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveConsentVersion: vi.fn(async (..._a: any[]) => 1 as number | null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    issueGuardianOtp: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verifyGuardianOtp: vi.fn(async (..._a: any[]) => true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertVerifyAttemptAllowed: vi.fn(async (..._a: any[]) => {}),
    guardianUserConsentRow: vi.fn((a: Record<string, unknown>) => ({ row: a })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startSignupGuardian: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verifySignupGuardian: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisIncr: vi.fn(async (..._a: any[]) => 1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisExpire: vi.fn(async (..._a: any[]) => 1),
  };
});

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // A thenable so both `await .where(...)` and `.limit()` work. BOTH
          // callbacks must be forwarded — dropping `rej` makes a rejected
          // query hang the await forever.
          const result = {
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              nextRows().then(res, rej),
            limit: () => nextRows(),
          };
          return result;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (dbState.failInsert) return Promise.reject(dbState.failInsert);
        inserts.push({ table, values });
        return Promise.resolve([]);
      },
    }),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: { userId: 'cr.userId' },
  user: { id: 'user.id', email: 'user.email', phoneNumber: 'user.phoneNumber' },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    incr: (...a: any[]) => redisIncr(...a),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expire: (...a: any[]) => redisExpire(...a),
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('@dpg/schemas', () => ({
  default: { object: () => ({}), string: () => ({ min: () => ({}) }) },
  U18DobBodySchema: {},
  U18DobResponseSchema: {},
  U18GuardianBodySchema: {},
  U18GuardianResponseSchema: {},
  U18GuardianVerifyBodySchema: {},
  U18GuardianVerifyResponseSchema: {},
  SignupGuardianBodySchema: {},
  SignupGuardianResponseSchema: {},
  SignupGuardianVerifyBodySchema: {},
  SignupGuardianVerifyResponseSchema: {},
}));

vi.mock('@/config', () => ({
  apiConfig: {
    served_domains: [{ network: 'blue_dot', domain: 'student' }],
    max_wards_per_guardian: 3,
  },
}));

vi.mock('@/services/minor', () => ({ isMinor: (age: number) => age < 18 }));

vi.mock('@/services/minor_guardian_repo', () => ({
  WardLimitError,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWardAge: (...a: any[]) => getWardAge(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setWardAge: (...a: any[]) => setWardAge(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertGuardianDetails: (...a: any[]) => upsertGuardianDetails(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGuardianContactPlaintext: (...a: any[]) => getGuardianContactPlaintext(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isGuardianWardLimitReached: (...a: any[]) => isGuardianWardLimitReached(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guardianContactMatchesWard: (...a: any[]) => guardianContactMatchesWard(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setGuardianVerified: (...a: any[]) => setGuardianVerified(...a),
  // Faithful re-implementation: phone wins over email.
  resolveOtpChannel: (input: { guardianEmail?: string | null; guardianPhone?: string | null }) => {
    if (input.guardianPhone) return { contact: input.guardianPhone, contactType: 'phone' };
    if (input.guardianEmail) return { contact: input.guardianEmail, contactType: 'email' };
    throw new Error('resolveOtpChannel: at least one guardian contact is required');
  },
}));

vi.mock('@/services/consent_version', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveConsentVersion: (...a: any[]) => resolveConsentVersion(...a),
}));

vi.mock('@/services/guardian_consent_rows', () => ({
  guardianUserConsentRow: (a: Record<string, unknown>) => guardianUserConsentRow(a),
}));

vi.mock('@/services/guardian_otp', () => ({
  GuardianOtpError,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  issueGuardianOtp: (...a: any[]) => issueGuardianOtp(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyGuardianOtp: (...a: any[]) => verifyGuardianOtp(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assertVerifyAttemptAllowed: (...a: any[]) => assertVerifyAttemptAllowed(...a),
  // Faithful re-implementation of the shared status ladder.
  guardianOtpErrorReply: (err: unknown) => {
    if (!(err instanceof GuardianOtpError)) return null;
    if (err.code === 'RATE_LIMITED') {
      return { status: 429, error: 'OTP_RATE_LIMITED', message: 'Too many OTP requests; try again shortly' };
    }
    if (err.code === 'NO_OTP_PROVIDER') {
      return { status: 503, error: 'OTP_PROVIDER_UNAVAILABLE', message: 'No OTP channel configured for this instance' };
    }
    return { status: 429, error: 'OTP_VERIFY_THROTTLED', message: 'Too many attempts; try again shortly' };
  },
}));

vi.mock('@/services/signup_guardian', () => ({
  SignupGuardianError,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  startSignupGuardian: (...a: any[]) => startSignupGuardian(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifySignupGuardian: (...a: any[]) => verifySignupGuardian(...a),
}));

import { u18_dob_handler } from '../u18_dob';
import { u18_guardian_handler, guardianOtpScope } from '../u18_guardian';
import { u18_guardian_verify_handler } from '../u18_guardian_verify';
import { u18_signup_guardian } from '../u18_signup_guardian';

// --- fakes -----------------------------------------------------------------

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
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

const log = { error: vi.fn() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(handler: any, req: Record<string, unknown>) {
  const reply = makeReply();
  return handler({ log, ...req }, reply).then(() => reply);
}

const errOf = (reply: FakeReply) => (reply.body as { error: string }).error;
const msgOf = (reply: FakeReply) => (reply.body as { message: string }).message;

interface FakeRoute {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preHandler?: (...a: any[]) => unknown;
}

const signupRoutes: FakeRoute[] = [];

async function loadSignupRoutes() {
  signupRoutes.length = 0;
  const fakeFastify = { route: (opts: FakeRoute) => void signupRoutes.push(opts) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await u18_signup_guardian(fakeFastify as any, {} as any);
}

function signupRouteFor(url: string): FakeRoute {
  const found = signupRoutes.find((r) => r.url === url);
  if (!found) throw new Error(`no route registered for ${url}`);
  return found;
}

beforeEach(async () => {
  rowQueue.length = 0;
  inserts.length = 0;
  dbState.failWith = null;
  dbState.failInsert = null;
  vi.clearAllMocks();
  // Defaults (clearAllMocks keeps implementations, but be explicit).
  getWardAge.mockResolvedValue(null);
  setWardAge.mockResolvedValue(undefined);
  upsertGuardianDetails.mockResolvedValue(undefined);
  getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.com', contactType: 'email' });
  isGuardianWardLimitReached.mockResolvedValue(false);
  guardianContactMatchesWard.mockReturnValue(false);
  setGuardianVerified.mockResolvedValue(undefined);
  resolveConsentVersion.mockResolvedValue(1);
  issueGuardianOtp.mockResolvedValue(undefined);
  verifyGuardianOtp.mockResolvedValue(true);
  assertVerifyAttemptAllowed.mockResolvedValue(undefined);
  guardianUserConsentRow.mockImplementation((a: Record<string, unknown>) => ({ row: a }));
  startSignupGuardian.mockResolvedValue(undefined);
  verifySignupGuardian.mockResolvedValue(undefined);
  redisIncr.mockResolvedValue(1);
  redisExpire.mockResolvedValue(1);
  await loadSignupRoutes();
});

// ---------------------------------------------------------------------------

describe('u18_dob_handler', () => {
  it('401 when unauthenticated', async () => {
    const reply = await call(u18_dob_handler, {
      user: undefined,
      body: { network: 'blue_dot', age: 15 },
    });

    expect(reply.statusCode).toBe(401);
    expect(errOf(reply)).toBe('UNAUTHORIZED');
    expect(getWardAge).not.toHaveBeenCalled();
  });

  it('400 UNKNOWN_NETWORK for a network this instance does not serve', async () => {
    const reply = await call(u18_dob_handler, {
      user: { id: 'u1' },
      body: { network: 'green_dot', age: 15 },
    });

    expect(reply.statusCode).toBe(400);
    expect(errOf(reply)).toBe('UNKNOWN_NETWORK');
    expect(getWardAge).not.toHaveBeenCalled();
  });

  it('persists a first age and reports minor status', async () => {
    getWardAge.mockResolvedValue(null);

    const reply = await call(u18_dob_handler, {
      user: { id: 'u1' },
      body: { network: 'blue_dot', age: 15 },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ isMinor: true });
    expect(setWardAge).toHaveBeenCalledWith('u1', 15);
  });

  it('reports isMinor false for an adult age', async () => {
    getWardAge.mockResolvedValue(null);

    const reply = await call(u18_dob_handler, {
      user: { id: 'u1' },
      body: { network: 'blue_dot', age: 18 },
    });

    expect(reply.body).toEqual({ isMinor: false });
  });

  it('409 DOB_ALREADY_SET when a DIFFERENT age is re-sent', async () => {
    getWardAge.mockResolvedValue(15);

    const reply = await call(u18_dob_handler, {
      user: { id: 'u1' },
      body: { network: 'blue_dot', age: 21 },
    });

    expect(reply.statusCode).toBe(409);
    expect(errOf(reply)).toBe('DOB_ALREADY_SET');
    // The minor→adult flip must not be written.
    expect(setWardAge).not.toHaveBeenCalled();
  });

  it('re-sending the SAME age is an idempotent no-op', async () => {
    getWardAge.mockResolvedValue(15);

    const reply = await call(u18_dob_handler, {
      user: { id: 'u1' },
      body: { network: 'blue_dot', age: 15 },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ isMinor: true });
    expect(setWardAge).not.toHaveBeenCalled();
  });

  it('500 DOB_WRITE_FAILED when the age write throws', async () => {
    getWardAge.mockResolvedValue(null);
    setWardAge.mockRejectedValue(new Error('db down'));

    const reply = await call(u18_dob_handler, {
      user: { id: 'u1' },
      body: { network: 'blue_dot', age: 15 },
    });

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('DOB_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('u18_guardian_handler', () => {
  const body = {
    network: 'blue_dot',
    brand: 'bd',
    guardianName: 'Parent One',
    guardianEmail: 'parent@example.com',
  };

  const minorReq = () => {
    getWardAge.mockResolvedValue(15);
    rowQueue.push([{ email: 'ward@example.com', phoneNumber: '9990001111' }]);
    return { user: { id: 'u1' }, body };
  };

  it('scopes the OTP per user', () => {
    expect(guardianOtpScope('u1')).toBe('u1:guardian');
  });

  it('401 when unauthenticated', async () => {
    const reply = await call(u18_guardian_handler, { user: undefined, body });

    expect(reply.statusCode).toBe(401);
    expect(errOf(reply)).toBe('UNAUTHORIZED');
  });

  it('400 UNKNOWN_NETWORK for an unserved network', async () => {
    const reply = await call(u18_guardian_handler, {
      user: { id: 'u1' },
      body: { ...body, network: 'green_dot' },
    });

    expect(reply.statusCode).toBe(400);
    expect(errOf(reply)).toBe('UNKNOWN_NETWORK');
    expect(getWardAge).not.toHaveBeenCalled();
  });

  it('409 DOB_REQUIRED when no age is stored yet', async () => {
    getWardAge.mockResolvedValue(null);

    const reply = await call(u18_guardian_handler, { user: { id: 'u1' }, body });

    expect(reply.statusCode).toBe(409);
    expect(errOf(reply)).toBe('DOB_REQUIRED');
  });

  it('409 NOT_A_MINOR when the stored age is 18+', async () => {
    getWardAge.mockResolvedValue(18);

    const reply = await call(u18_guardian_handler, { user: { id: 'u1' }, body });

    expect(reply.statusCode).toBe(409);
    expect(errOf(reply)).toBe('NOT_A_MINOR');
    expect(upsertGuardianDetails).not.toHaveBeenCalled();
  });

  it('409 SAME_CONTACT_NOT_ALLOWED is a HARD block, not an ack-able warning', async () => {
    const req = minorReq();
    guardianContactMatchesWard.mockReturnValue(true);

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(409);
    expect(errOf(reply)).toBe('SAME_CONTACT_NOT_ALLOWED');
    // Compared against the ward's own row read from the DB.
    expect(guardianContactMatchesWard).toHaveBeenCalledWith({
      wardEmail: 'ward@example.com',
      wardPhone: '9990001111',
      guardianEmail: 'parent@example.com',
      guardianPhone: undefined,
    });
    expect(upsertGuardianDetails).not.toHaveBeenCalled();
  });

  it('tolerates a missing ward row when comparing contacts', async () => {
    getWardAge.mockResolvedValue(15);
    rowQueue.push([]); // no ward row

    const reply = await call(u18_guardian_handler, { user: { id: 'u1' }, body });

    expect(guardianContactMatchesWard).toHaveBeenCalledWith({
      wardEmail: undefined,
      wardPhone: undefined,
      guardianEmail: 'parent@example.com',
      guardianPhone: undefined,
    });
    expect(reply.statusCode).toBe(200);
  });

  it('409 GUARDIAN_WARD_LIMIT when the guardian cap is already reached', async () => {
    const req = minorReq();
    isGuardianWardLimitReached.mockResolvedValue(true);

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(409);
    expect(errOf(reply)).toBe('GUARDIAN_WARD_LIMIT');
    expect(msgOf(reply)).toContain('maximum of 3');
    // The cap is checked on the resolved OTP channel contact for this ward.
    expect(isGuardianWardLimitReached).toHaveBeenCalledWith('parent@example.com', 'u1');
    expect(upsertGuardianDetails).not.toHaveBeenCalled();
  });

  it('prefers the phone as the ward-limit contact when both are supplied', async () => {
    getWardAge.mockResolvedValue(15);
    rowQueue.push([{ email: 'ward@example.com', phoneNumber: '9990001111' }]);
    isGuardianWardLimitReached.mockResolvedValue(true);

    await call(u18_guardian_handler, {
      user: { id: 'u1' },
      body: { ...body, guardianPhone: '8880002222' },
    });

    expect(isGuardianWardLimitReached).toHaveBeenCalledWith('8880002222', 'u1');
  });

  it('400 CONSENT_VERSION_UNCONFIGURED when guardian_declaration has no version', async () => {
    const req = minorReq();
    resolveConsentVersion.mockResolvedValue(null);

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(400);
    expect(errOf(reply)).toBe('CONSENT_VERSION_UNCONFIGURED');
    expect(resolveConsentVersion).toHaveBeenCalledWith({
      network: 'blue_dot',
      brand: 'bd',
      category: 'guardian_declaration',
      variant: 'u18',
    });
    expect(upsertGuardianDetails).not.toHaveBeenCalled();
  });

  it('409 GUARDIAN_WARD_LIMIT when the atomic re-check loses the race', async () => {
    const req = minorReq();
    upsertGuardianDetails.mockRejectedValue(new WardLimitError());

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(409);
    expect(errOf(reply)).toBe('GUARDIAN_WARD_LIMIT');
    // A lost cap race is not an internal error, so nothing is logged as one.
    expect(log.error).not.toHaveBeenCalled();
  });

  it('500 GUARDIAN_WRITE_FAILED when the guardian upsert throws', async () => {
    const req = minorReq();
    upsertGuardianDetails.mockRejectedValue(new Error('db down'));

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('GUARDIAN_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('500 GUARDIAN_WRITE_FAILED when the declaration insert throws', async () => {
    const req = minorReq();
    dbState.failInsert = new Error('insert boom');

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('GUARDIAN_WRITE_FAILED');
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('500 GUARDIAN_WRITE_FAILED when the contact is missing after the write', async () => {
    const req = minorReq();
    getGuardianContactPlaintext.mockResolvedValue(null);

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('GUARDIAN_WRITE_FAILED');
    expect(msgOf(reply)).toBe('Guardian contact missing after write');
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('200 records a self-sourced declaration and issues the OTP', async () => {
    const req = minorReq();

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ otpSent: true });
    // Missing contacts are normalised to null before persisting.
    expect(upsertGuardianDetails).toHaveBeenCalledWith('u1', {
      guardianName: 'Parent One',
      guardianEmail: 'parent@example.com',
      guardianPhone: null,
    });
    // D12: the ward attests to guardian validity themselves.
    expect(guardianUserConsentRow).toHaveBeenCalledWith({
      category: 'guardian_declaration',
      userId: 'u1',
      network: 'blue_dot',
      brand: 'bd',
      documentVersion: 1,
      source: 'self',
    });
    expect(inserts).toHaveLength(1);
    expect(issueGuardianOtp).toHaveBeenCalledWith({
      scope: 'u1:guardian',
      contact: 'g@x.com',
      contactType: 'email',
      scenario: { kind: 'account' },
      variables: { parentName: 'Parent One' },
    });
  });

  it('429 OTP_RATE_LIMITED when the OTP send is rate limited', async () => {
    const req = minorReq();
    issueGuardianOtp.mockRejectedValue(new GuardianOtpError('RATE_LIMITED'));

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(429);
    expect(errOf(reply)).toBe('OTP_RATE_LIMITED');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('503 OTP_PROVIDER_UNAVAILABLE when no OTP channel is configured', async () => {
    const req = minorReq();
    issueGuardianOtp.mockRejectedValue(new GuardianOtpError('NO_OTP_PROVIDER'));

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(503);
    expect(errOf(reply)).toBe('OTP_PROVIDER_UNAVAILABLE');
  });

  it('500 OTP_SEND_FAILED for an unmapped OTP failure', async () => {
    const req = minorReq();
    issueGuardianOtp.mockRejectedValue(new Error('smtp exploded'));

    const reply = await call(u18_guardian_handler, req);

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('OTP_SEND_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('u18_guardian_verify_handler', () => {
  const body = { network: 'blue_dot', brand: 'bd', otp: '000000' };
  const req = () => ({ user: { id: 'u1' }, body });

  it('401 when unauthenticated', async () => {
    const reply = await call(u18_guardian_verify_handler, { user: undefined, body });

    expect(reply.statusCode).toBe(401);
    expect(errOf(reply)).toBe('UNAUTHORIZED');
    expect(assertVerifyAttemptAllowed).not.toHaveBeenCalled();
  });

  it('400 UNKNOWN_NETWORK for an unserved network', async () => {
    const reply = await call(u18_guardian_verify_handler, {
      user: { id: 'u1' },
      body: { ...body, network: 'green_dot' },
    });

    expect(reply.statusCode).toBe(400);
    expect(errOf(reply)).toBe('UNKNOWN_NETWORK');
  });

  it('429 OTP_VERIFY_THROTTLED when too many attempts were made', async () => {
    assertVerifyAttemptAllowed.mockRejectedValue(new GuardianOtpError('VERIFY_THROTTLED'));

    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(429);
    expect(errOf(reply)).toBe('OTP_VERIFY_THROTTLED');
    expect(assertVerifyAttemptAllowed).toHaveBeenCalledWith('u1:guardian');
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('RETHROWS a non-OTP failure from the attempt gate (no reply is sent)', async () => {
    // Deviates from the repo-wide "routes never throw" rule: an unmapped error
    // from `assertVerifyAttemptAllowed` is re-thrown for the Fastify error
    // handler rather than turned into a 500 body here.
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('redis down'));

    await expect(call(u18_guardian_verify_handler, req())).rejects.toThrow('redis down');
  });

  it('400 CONSENT_VERSION_UNCONFIGURED without burning the OTP', async () => {
    resolveConsentVersion.mockResolvedValue(null);

    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(400);
    expect(errOf(reply)).toBe('CONSENT_VERSION_UNCONFIGURED');
    expect(msgOf(reply)).toBe('u18 terms not configured');
    // Version resolution happens BEFORE the single-use OTP is consumed.
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('400 CONSENT_VERSION_UNCONFIGURED naming privacy when only that is missing', async () => {
    resolveConsentVersion.mockImplementation(
      async (args: { category?: string } = {}) => (args.category === 'privacy' ? null : 2),
    );

    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(400);
    expect(msgOf(reply)).toBe('u18 privacy not configured');
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('400 INVALID_OTP when the code does not verify', async () => {
    verifyGuardianOtp.mockResolvedValue(false);

    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(400);
    expect(errOf(reply)).toBe('INVALID_OTP');
    expect(setGuardianVerified).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('200 writes guardian-sourced terms + privacy and flags the ward verified', async () => {
    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ verified: true });
    expect(verifyGuardianOtp).toHaveBeenCalledWith({ scope: 'u1:guardian', otp: '000000' });
    expect(guardianUserConsentRow).toHaveBeenCalledTimes(2);
    expect(
      guardianUserConsentRow.mock.calls.map((c) => [c[0].category, c[0].source]),
    ).toEqual([
      ['terms', 'guardian'],
      ['privacy', 'guardian'],
    ]);
    // Both rows go in as ONE insert.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toHaveLength(2);
    expect(setGuardianVerified).toHaveBeenCalledWith('u1');
  });

  it('500 CONSENT_WRITE_FAILED when the consent insert throws', async () => {
    dbState.failInsert = new Error('insert boom');

    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
    expect(setGuardianVerified).not.toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when marking the guardian verified throws', async () => {
    setGuardianVerified.mockRejectedValue(new Error('db down'));

    const reply = await call(u18_guardian_verify_handler, req());

    expect(reply.statusCode).toBe(500);
    expect(errOf(reply)).toBe('CONSENT_WRITE_FAILED');
  });
});

// ---------------------------------------------------------------------------

describe('u18_signup_guardian (PRE-AUTH)', () => {
  const startBody = {
    network: 'blue_dot',
    domain: 'student',
    email: 'ward@example.com',
    age: 15,
    guardianName: 'Parent One',
    guardianEmail: 'parent@example.com',
    guardianDeclarationAccepted: true,
  };

  function callStart(req: Record<string, unknown>) {
    return call(signupRouteFor('/u18/signup/guardian').handler, { ip: '1.2.3.4', ...req });
  }
  function callVerify(req: Record<string, unknown>) {
    return call(signupRouteFor('/u18/signup/guardian/verify').handler, req);
  }

  it('registers both routes WITHOUT an auth preHandler (the account does not exist yet)', () => {
    expect(signupRoutes.map((r) => r.url)).toEqual([
      '/u18/signup/guardian',
      '/u18/signup/guardian/verify',
    ]);
    expect(signupRoutes.every((r) => r.preHandler === undefined)).toBe(true);
  });

  describe('start', () => {
    it('sets the window TTL only on the first hit in the window', async () => {
      redisIncr.mockResolvedValue(1);

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(200);
      expect(redisIncr).toHaveBeenCalledWith('u18_signup_guardian_rl:1.2.3.4');
      expect(redisExpire).toHaveBeenCalledWith('u18_signup_guardian_rl:1.2.3.4', 300);
    });

    it('does not reset the TTL on subsequent hits', async () => {
      redisIncr.mockResolvedValue(4);

      await callStart({ body: startBody });

      expect(redisExpire).not.toHaveBeenCalled();
    });

    it('allows the 10th request in the window', async () => {
      redisIncr.mockResolvedValue(10);

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(200);
    });

    it('429 OTP_RATE_LIMITED once the per-IP window max is exceeded', async () => {
      redisIncr.mockResolvedValue(11);

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(429);
      expect(errOf(reply)).toBe('OTP_RATE_LIMITED');
      expect(startSignupGuardian).not.toHaveBeenCalled();
    });

    it('fails OPEN when the limiter itself errors', async () => {
      redisIncr.mockRejectedValue(new Error('redis down'));

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(200);
      expect(startSignupGuardian).toHaveBeenCalled();
    });

    it('400 UNKNOWN_NETWORK when the network/domain PAIR is not served', async () => {
      const reply = await callStart({ body: { ...startBody, domain: 'mentor' } });

      expect(reply.statusCode).toBe(400);
      expect(errOf(reply)).toBe('UNKNOWN_NETWORK');
      expect(msgOf(reply)).toContain('blue_dot/mentor');
      expect(startSignupGuardian).not.toHaveBeenCalled();
    });

    it('200 forwards the email identifier and the full guardian payload', async () => {
      const reply = await callStart({
        body: { ...startBody, guardianPhone: '8880002222', sameContactAcknowledged: true },
      });

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ otpSent: true });
      expect(startSignupGuardian).toHaveBeenCalledWith({
        network: 'blue_dot',
        domain: 'student',
        identifier: { email: 'ward@example.com' },
        age: 15,
        guardianName: 'Parent One',
        guardianEmail: 'parent@example.com',
        guardianPhone: '8880002222',
        guardianDeclarationAccepted: true,
        sameContactAcknowledged: true,
      });
    });

    it('uses the phoneNumber identifier when no email is supplied', async () => {
      const { email: _email, ...rest } = startBody;

      await callStart({ body: { ...rest, phoneNumber: '9990001111' } });

      expect(startSignupGuardian.mock.calls[0][0].identifier).toEqual({
        phoneNumber: '9990001111',
      });
    });

    it.each([
      ['NOT_A_MINOR', 409],
      ['SAME_CONTACT_NOT_ALLOWED', 409],
      ['GUARDIAN_WARD_LIMIT', 409],
      ['UNKNOWN_NETWORK', 400],
      ['NOT_GATED', 400],
    ])('maps SignupGuardianError %s to %i', async (code, status) => {
      startSignupGuardian.mockRejectedValue(new SignupGuardianError(code));

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(status);
      // The code doubles as the message on this pre-auth route.
      expect(reply.body).toEqual({ error: code, message: code });
      expect(log.error).not.toHaveBeenCalled();
    });

    it.each([
      ['RATE_LIMITED', 429],
      ['NO_OTP_PROVIDER', 503],
      ['VERIFY_THROTTLED', 429],
    ] as const)('maps GuardianOtpError %s to %i', async (code, status) => {
      startSignupGuardian.mockRejectedValue(new GuardianOtpError(code));

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(status);
      expect(errOf(reply)).toBe(code);
    });

    it('500 SIGNUP_GUARDIAN_FAILED for an unmapped failure', async () => {
      startSignupGuardian.mockRejectedValue(new Error('boom'));

      const reply = await callStart({ body: startBody });

      expect(reply.statusCode).toBe(500);
      expect(errOf(reply)).toBe('SIGNUP_GUARDIAN_FAILED');
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const verifyBody = { email: 'ward@example.com', otp: '000000', network: 'blue_dot' };

    it('is not rate limited per IP (only the send route is)', async () => {
      await callVerify({ body: verifyBody });

      expect(redisIncr).not.toHaveBeenCalled();
    });

    it('400 UNKNOWN_NETWORK when an unserved network is supplied', async () => {
      const reply = await callVerify({ body: { ...verifyBody, network: 'green_dot' } });

      expect(reply.statusCode).toBe(400);
      expect(errOf(reply)).toBe('UNKNOWN_NETWORK');
      expect(verifySignupGuardian).not.toHaveBeenCalled();
    });

    it('skips the network check when network is omitted (optional here)', async () => {
      const { network: _network, ...rest } = verifyBody;

      const reply = await callVerify({ body: rest });

      expect(reply.statusCode).toBe(200);
      expect(verifySignupGuardian).toHaveBeenCalled();
    });

    it('200 verified on a good OTP', async () => {
      const reply = await callVerify({ body: verifyBody });

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ verified: true });
      expect(verifySignupGuardian).toHaveBeenCalledWith({
        identifier: { email: 'ward@example.com' },
        otp: '000000',
      });
    });

    it('resolves a phone-only identifier', async () => {
      await callVerify({ body: { phoneNumber: '9990001111', otp: '000000' } });

      expect(verifySignupGuardian.mock.calls[0][0].identifier).toEqual({
        phoneNumber: '9990001111',
      });
    });

    it.each([
      ['INVALID_OTP', 400],
      ['NO_PENDING_SIGNUP', 400],
      ['NOT_A_MINOR', 409],
    ])('maps SignupGuardianError %s to %i', async (code, status) => {
      verifySignupGuardian.mockRejectedValue(new SignupGuardianError(code));

      const reply = await callVerify({ body: verifyBody });

      expect(reply.statusCode).toBe(status);
      expect(reply.body).toEqual({ error: code, message: code });
    });

    it('maps a verify throttle to 429 VERIFY_THROTTLED', async () => {
      verifySignupGuardian.mockRejectedValue(new GuardianOtpError('VERIFY_THROTTLED'));

      const reply = await callVerify({ body: verifyBody });

      expect(reply.statusCode).toBe(429);
      expect(errOf(reply)).toBe('VERIFY_THROTTLED');
    });

    it('500 SIGNUP_GUARDIAN_VERIFY_FAILED for an unmapped failure', async () => {
      verifySignupGuardian.mockRejectedValue(new Error('boom'));

      const reply = await callVerify({ body: verifyBody });

      expect(reply.statusCode).toBe(500);
      expect(errOf(reply)).toBe('SIGNUP_GUARDIAN_VERIFY_FAILED');
      expect(log.error).toHaveBeenCalled();
    });
  });
});
