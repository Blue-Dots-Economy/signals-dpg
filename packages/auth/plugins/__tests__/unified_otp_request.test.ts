import { describe, it, expect, vi, afterEach } from 'vitest';
import { APIError } from 'better-auth/api';

// `unified_otp.ts` imports Zod through the workspace alias `@dpg/schemas`, which
import {
  generateLoginOtp,
  generateTestOtp,
  unifiedOtp,
  type UserWithPhoneNumber,
  type unifiedOtpOptions,
} from '../unified_otp';
import {
  callEndpoint,
  createFakeAuthContext,
  endpointPath,
  type FakeRow,
} from './support/otp_test_context';

/** Five minutes, in seconds — the TTL the plugin writes OTPs with. */
const OTP_TTL_SECONDS = 300;

/**
 * Shape of the errors these endpoints reject with. Body-validation failures are
 * raised by `better-call` itself, whose `APIError` class is a *different* class
 * object from the `APIError` re-exported by `better-auth/api` (so `instanceof`
 * that export is false for them) — hence the structural assertion.
 */
interface ThrownApiError extends Error {
  status?: string | number;
  statusCode?: number;
  body?: { message?: string; code?: string };
}

async function catchError(promise: Promise<unknown>): Promise<ThrownApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ThrownApiError;
  }
  throw new Error('Expected the endpoint to reject, but it resolved.');
}

function buildOptions(overrides: Partial<unifiedOtpOptions> = {}) {
  const sendPhoneOtp = vi.fn(
    async (_data: { phoneNumber: string; otp: string }) => {}
  );
  const sendEmailOtp = vi.fn(
    async (_data: {
      email: string;
      otp: string;
      user: UserWithPhoneNumber | null;
    }) => {}
  );
  const afterUserCreate = vi.fn(
    async (_data: { user: UserWithPhoneNumber }) => ({ profileCreated: true })
  );
  const options: unifiedOtpOptions = {
    sendPhoneOtp,
    sendEmailOtp,
    afterUserCreate,
    allowSelfSignup: true,
    loginChannels: ['email', 'phone'],
    ...overrides,
  };
  return { options, sendPhoneOtp, sendEmailOtp, afterUserCreate };
}

/** A fresh copy each call, so a test that mutates rows cannot leak sideways. */
function knownUser(): FakeRow {
  return {
    id: 'user_existing',
    email: 'known@example.com',
    phoneNumber: '+911234567890',
    name: 'Known User',
    emailVerified: true,
    phoneNumberVerified: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OTP generation', () => {
  it('generateTestOtp returns the fixed test OTP', () => {
    expect(generateTestOtp()).toBe('000000');
  });

  it('never falls back to Math.random for a live code', () => {
    const random = vi.spyOn(Math, 'random');

    const codes = Array.from({ length: 500 }, () => generateLoginOtp());

    expect(random).not.toHaveBeenCalled();
    for (const otp of codes) expect(otp).toMatch(/^\d{6}$/);
    // A CSPRNG draw over 900k values should not repeat itself much in 500
    // samples; a constant or tiny-period source would collapse this count.
    expect(new Set(codes).size).toBeGreaterThan(400);
  });

  it('never emits the fixed test OTP from the live generator', () => {
    for (let i = 0; i < 200; i += 1) {
      const otp = generateLoginOtp();
      expect(otp).toMatch(/^\d{6}$/);
      expect(otp).not.toBe(generateTestOtp());
      expect(Number(otp)).toBeGreaterThanOrEqual(100000);
      expect(Number(otp)).toBeLessThanOrEqual(999999);
    }
  });
});

describe('unifiedOtp plugin shape', () => {
  it('declares the plugin id, user columns and endpoint paths', () => {
    const { options } = buildOptions();
    const plugin = unifiedOtp(options);

    expect(plugin.id).toBe('unified-otp');
    expect(plugin.schema?.user.fields).toMatchObject({
      email: { type: 'string', unique: true },
      phoneNumber: { type: 'string', required: false, unique: true },
      phoneNumberVerified: { type: 'boolean', required: false },
      age: { type: 'number', required: false },
      termsAccepted: { type: 'boolean', required: false },
      privacyAccepted: { type: 'boolean', required: false },
    });

    expect(endpointPath(plugin, 'checkUser')).toBe('/unified-otp/check-user');
    expect(endpointPath(plugin, 'requestOtp')).toBe('/unified-otp/request');
    expect(endpointPath(plugin, 'verifyOtp')).toBe('/unified-otp/verify');
  });
});

describe('checkUser', () => {
  it('reports an existing user found by email without a phone lookup', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    const result = await callEndpoint(
      unifiedOtp(options),
      'checkUser',
      { email: 'known@example.com', phoneNumber: '+911234567890' },
      fake.context
    );

    expect(result).toEqual({ userExists: true });
    expect(fake.findOne).toHaveBeenCalledTimes(1);
    expect(fake.findOne).toHaveBeenCalledWith({
      model: 'user',
      where: [{ field: 'email', value: 'known@example.com' }],
    });
  });

  it('falls back to a phone lookup when the email lookup misses', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    const result = await callEndpoint(
      unifiedOtp(options),
      'checkUser',
      { email: 'other@example.com', phoneNumber: '+911234567890' },
      fake.context
    );

    expect(result).toEqual({ userExists: true });
    expect(fake.findOne).toHaveBeenCalledTimes(2);
    expect(fake.findOne).toHaveBeenLastCalledWith({
      model: 'user',
      where: [{ field: 'phoneNumber', value: '+911234567890' }],
    });
  });

  it('reports userExists false for an unknown identifier even when signup is gated', async () => {
    // check-user is only an existence probe, so it deliberately does not run
    // the self-signup gate.
    const { options } = buildOptions({ allowSelfSignup: false });
    const fake = createFakeAuthContext();

    const result = await callEndpoint(
      unifiedOtp(options),
      'checkUser',
      { phoneNumber: '+919999999999' },
      fake.context
    );

    expect(result).toEqual({ userExists: false });
  });

  it('rejects a disallowed channel before touching the database', async () => {
    const { options } = buildOptions({ loginChannels: ['email'] });
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await expect(
      callEndpoint(
        unifiedOtp(options),
        'checkUser',
        { phoneNumber: '+911234567890' },
        fake.context
      )
    ).rejects.toMatchObject({ body: { code: 'LOGIN_CHANNEL_DISABLED' } });
    expect(fake.findOne).not.toHaveBeenCalled();
  });

  it('rejects a malformed email with a 400 before touching the database', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext();

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'checkUser',
        { email: 'not-an-email' },
        fake.context
      )
    );

    expect(caught.name).toBe('APIError');
    expect(caught.statusCode).toBe(400);
    expect(caught.body?.code).toBe('VALIDATION_ERROR');
    expect(caught.message).toMatch(/Please enter a valid Email/);
    expect(fake.findOne).not.toHaveBeenCalled();
  });
});

describe('requestOtp', () => {
  it('stores a phone OTP under otp:phone:<number> with a 5-minute TTL and sends it', async () => {
    const { options, sendPhoneOtp, sendEmailOtp } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { phoneNumber: '+911234567890' },
      fake.context
    );

    expect(result).toEqual({ ok: true, user: true });

    const key = 'otp:phone:+911234567890';
    expect(fake.secondaryStorage.set).toHaveBeenCalledTimes(1);
    const stored = fake.store.get(key);
    expect(stored).toMatch(/^\d{6}$/);
    expect(fake.ttls.get(key)).toBe(OTP_TTL_SECONDS);
    expect(sendPhoneOtp).toHaveBeenCalledWith({
      phoneNumber: '+911234567890',
      otp: stored,
    });
    expect(sendEmailOtp).not.toHaveBeenCalled();
  });

  it('reports user:false for an unknown identifier when self-signup is open', async () => {
    const { options, sendPhoneOtp } = buildOptions({ allowSelfSignup: true });
    const fake = createFakeAuthContext();

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { phoneNumber: '+919999999999' },
      fake.context
    );

    expect(result).toEqual({ ok: true, user: false });
    expect(sendPhoneOtp).toHaveBeenCalledTimes(1);
    expect(fake.store.get('otp:phone:+919999999999')).toMatch(/^\d{6}$/);
  });

  it('stores the fixed 000000 code when createTestOtp is enabled', async () => {
    const { options, sendPhoneOtp } = buildOptions({ createTestOtp: true });
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { phoneNumber: '+911234567890' },
      fake.context
    );

    expect(fake.store.get('otp:phone:+911234567890')).toBe('000000');
    expect(sendPhoneOtp).toHaveBeenCalledWith({
      phoneNumber: '+911234567890',
      otp: '000000',
    });
  });

  it('stores an email OTP under otp:email:<email> and passes the user to the email sender', async () => {
    const { options, sendEmailOtp, sendPhoneOtp } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { email: 'known@example.com' },
      fake.context
    );

    const key = 'otp:email:known@example.com';
    expect(fake.ttls.get(key)).toBe(OTP_TTL_SECONDS);
    expect(sendPhoneOtp).not.toHaveBeenCalled();
    expect(sendEmailOtp).toHaveBeenCalledWith({
      email: 'known@example.com',
      otp: fake.store.get(key),
      user: expect.objectContaining({ id: 'user_existing' }),
    });
  });

  it('keys on the phone number when both identifiers are supplied, yet sends over both channels', async () => {
    const { options, sendPhoneOtp, sendEmailOtp } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { email: 'known@example.com', phoneNumber: '+911234567890' },
      fake.context
    );

    expect([...fake.store.keys()]).toEqual(['otp:phone:+911234567890']);
    const otp = fake.store.get('otp:phone:+911234567890');
    expect(sendPhoneOtp).toHaveBeenCalledWith({
      phoneNumber: '+911234567890',
      otp,
    });
    expect(sendEmailOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'known@example.com', otp })
    );
  });

  it('refuses an unknown identifier when self-signup is gated, before any OTP is stored', async () => {
    const { options, sendPhoneOtp } = buildOptions({
      allowSelfSignup: false,
      adminByDomain: ['admin.example.com'],
    });
    const fake = createFakeAuthContext();

    let caught: unknown;
    try {
      await callEndpoint(
        unifiedOtp(options),
        'requestOtp',
        { phoneNumber: '+919999999999' },
        fake.context
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).body?.code).toBe('SELF_SIGNUP_DISABLED');
    expect((caught as APIError).status).toBe('FORBIDDEN');
    expect(fake.secondaryStorage.set).not.toHaveBeenCalled();
    expect(sendPhoneOtp).not.toHaveBeenCalled();
  });

  it('lets an admin-domain email through the gate (admin bootstrap)', async () => {
    const { options, sendEmailOtp } = buildOptions({
      allowSelfSignup: false,
      adminByDomain: ['admin.example.com'],
    });
    const fake = createFakeAuthContext();

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { email: 'boss@admin.example.com' },
      fake.context
    );

    expect(result).toEqual({ ok: true, user: false });
    expect(fake.store.get('otp:email:boss@admin.example.com')).toMatch(
      /^\d{6}$/
    );
    expect(sendEmailOtp).toHaveBeenCalledTimes(1);
  });

  it('still serves an existing user while self-signup is gated', async () => {
    const { options } = buildOptions({ allowSelfSignup: false });
    const fake = createFakeAuthContext({ users: [knownUser()] });

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { phoneNumber: '+911234567890' },
      fake.context
    );

    expect(result).toEqual({ ok: true, user: true });
  });

  it('rejects an email that does not match the registered email of the matched user', async () => {
    const { options, sendEmailOtp } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await expect(
      callEndpoint(
        unifiedOtp(options),
        'requestOtp',
        { email: 'someone.else@example.com', phoneNumber: '+911234567890' },
        fake.context
      )
    ).rejects.toThrow(/does not match the user’s registered email/);
    expect(fake.secondaryStorage.set).not.toHaveBeenCalled();
    expect(sendEmailOtp).not.toHaveBeenCalled();
  });

  it('rejects a phone number that does not match the registered number of the matched user', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await expect(
      callEndpoint(
        unifiedOtp(options),
        'requestOtp',
        { email: 'known@example.com', phoneNumber: '+915555555555' },
        fake.context
      )
    ).rejects.toThrow(/does not match the user’s registered phone number/);
    expect(fake.secondaryStorage.set).not.toHaveBeenCalled();
  });

  it('treats a blank stored email/phone as unset rather than a mismatch', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [
        {
          id: 'user_blank',
          email: '   ',
          phoneNumber: '+911234567890',
          name: 'Blank Email',
        },
      ],
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { email: 'fresh@example.com', phoneNumber: '+911234567890' },
      fake.context
    );

    expect(result).toEqual({ ok: true, user: true });
    expect(fake.store.get('otp:phone:+911234567890')).toMatch(/^\d{6}$/);
  });

  it('fails with 502 OTP_DELIVERY_FAILED and drops the stored OTP when delivery fails', async () => {
    const sendPhoneOtp = vi.fn(
      async (_data: { phoneNumber: string; otp: string }) => {
        throw new Error('sms gateway down');
      }
    );
    const { options } = buildOptions({ sendPhoneOtp });
    const fake = createFakeAuthContext({ users: [knownUser()] });

    let caught: unknown;
    try {
      await callEndpoint(
        unifiedOtp(options),
        'requestOtp',
        { phoneNumber: '+911234567890' },
        fake.context
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).statusCode).toBe(502);
    expect((caught as APIError).body?.code).toBe('OTP_DELIVERY_FAILED');
    expect(fake.secondaryStorage.delete).toHaveBeenCalledWith(
      'otp:phone:+911234567890'
    );
    expect(fake.store.has('otp:phone:+911234567890')).toBe(false);
  });

  it('rejects a disallowed channel before generating or storing an OTP', async () => {
    const { options, sendEmailOtp } = buildOptions({
      loginChannels: ['phone'],
    });
    const fake = createFakeAuthContext({ users: [knownUser()] });

    await expect(
      callEndpoint(
        unifiedOtp(options),
        'requestOtp',
        { email: 'known@example.com' },
        fake.context
      )
    ).rejects.toMatchObject({ body: { code: 'LOGIN_CHANNEL_DISABLED' } });
    expect(fake.secondaryStorage.set).not.toHaveBeenCalled();
    expect(sendEmailOtp).not.toHaveBeenCalled();
  });

  it('rejects an empty phone number string (schema requires a non-empty value)', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext();

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'requestOtp',
        { phoneNumber: '' },
        fake.context
      )
    );

    expect(caught.statusCode).toBe(400);
    expect(caught.body?.code).toBe('VALIDATION_ERROR');
    expect(fake.secondaryStorage.set).not.toHaveBeenCalled();
  });

  it('DISCREPANCY: an identifier-less request still reports ok and writes a junk key', async () => {
    // Both identifiers are optional in `RequestOtpInput` and nothing rejects an
    // empty body, so the handler falls through to the email branch with an
    // `undefined` address: it stores `otp:email:undefined`, delivers nothing
    // (deliverOtp has no channel to send on) and answers `{ ok: true }`.
    // Asserted as-is to pin current behaviour, not as an endorsement.
    const { options, sendPhoneOtp, sendEmailOtp } = buildOptions();
    const fake = createFakeAuthContext();

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      {},
      fake.context
    );

    expect(result).toEqual({ ok: true, user: false });
    expect([...fake.store.keys()]).toEqual(['otp:email:undefined']);
    expect(sendPhoneOtp).not.toHaveBeenCalled();
    expect(sendEmailOtp).not.toHaveBeenCalled();
  });

  it('tolerates a context without secondary storage (optional-chained write)', async () => {
    const { options, sendPhoneOtp } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });
    const context = { ...fake.context, secondaryStorage: undefined };

    const result = await callEndpoint(
      unifiedOtp(options),
      'requestOtp',
      { phoneNumber: '+911234567890' },
      context
    );

    expect(result).toEqual({ ok: true, user: true });
    expect(sendPhoneOtp).toHaveBeenCalledTimes(1);
  });
});
