import { describe, it, expect, vi, afterEach } from 'vitest';
import { APIError } from 'better-auth/api';

// Cookie writing is covered on its own in `utils/__tests__/session_cookie.test.ts`;
// here it is stubbed so the endpoint can be driven without better-auth's real
// cookie/secret machinery.
const { setSessionCookieSpy } = vi.hoisted(() => ({
  setSessionCookieSpy: vi.fn(),
}));
vi.mock('../../utils', () => ({
  setSessionCookie: async (...args: unknown[]) => setSessionCookieSpy(...args),
}));

import {
  unifiedOtp,
  type UserWithPhoneNumber,
  type unifiedOtpOptions,
} from '../unified_otp';
import {
  callEndpoint,
  createFakeAuthContext,
  type FakeRow,
} from './support/otp_test_context';

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
    async (_data: { user: UserWithPhoneNumber }) => ({ onboarded: true })
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

const PHONE = '+911234567890';
const PHONE_KEY = `otp:phone:${PHONE}`;
const EMAIL = 'known@example.com';
const EMAIL_KEY = `otp:email:${EMAIL}`;

/** A fully verified existing user, fresh per call. */
function knownUser(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'user_existing',
    email: EMAIL,
    phoneNumber: PHONE,
    name: 'Known User',
    emailVerified: true,
    phoneNumberVerified: true,
    ...overrides,
  };
}

afterEach(() => {
  setSessionCookieSpy.mockClear();
  vi.restoreAllMocks();
});

describe('verifyOtp — identifier and channel guards', () => {
  it('requires at least one identifier', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext();

    const caught = await catchError(
      callEndpoint(unifiedOtp(options), 'verifyOtp', { otp: '123456' }, fake.context)
    );

    expect(caught).toBeInstanceOf(APIError);
    expect(caught.message).toMatch(/Enter either phone number or email/);
    expect(fake.secondaryStorage.get).not.toHaveBeenCalled();
  });

  it('rejects a disallowed channel before reading the OTP from storage', async () => {
    const { options } = buildOptions({ loginChannels: ['email'] });
    const fake = createFakeAuthContext({ storedOtps: { [PHONE_KEY]: '123456' } });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '123456' },
        fake.context
      )
    );

    expect(caught.body?.code).toBe('LOGIN_CHANNEL_DISABLED');
    expect(fake.secondaryStorage.get).not.toHaveBeenCalled();
    expect(fake.secondaryStorage.delete).not.toHaveBeenCalled();
  });

  it('rejects an OTP that is not six characters long at the schema boundary', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({ storedOtps: { [PHONE_KEY]: '123456' } });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '123' },
        fake.context
      )
    );

    expect(caught.statusCode).toBe(400);
    expect(caught.body?.code).toBe('VALIDATION_ERROR');
    expect(fake.secondaryStorage.get).not.toHaveBeenCalled();
  });
});

describe('verifyOtp — OTP matching', () => {
  it('rejects a wrong OTP and leaves the stored code intact', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '111111' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '222222' },
        fake.context
      )
    );

    expect(caught).toBeInstanceOf(APIError);
    expect(caught.message).toMatch(/Invalid or expired OTP/);
    expect(fake.secondaryStorage.delete).not.toHaveBeenCalled();
    expect(fake.store.get(PHONE_KEY)).toBe('111111');
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it('rejects when no OTP is stored (expired TTL)', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({ users: [knownUser()] });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '111111' },
        fake.context
      )
    );

    expect(caught.message).toMatch(/Invalid or expired OTP/);
    expect(fake.secondaryStorage.get).toHaveBeenCalledWith(PHONE_KEY);
  });

  it('consumes the phone OTP on success, so a replay of the same code fails', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });
    const plugin = unifiedOtp(options);

    const result = await callEndpoint(
      plugin,
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242' },
      fake.context
    );

    expect(result.token).toBe('token_for_user_existing');
    expect(result.redirect).toBe(false);
    expect(fake.secondaryStorage.delete).toHaveBeenCalledWith(PHONE_KEY);
    expect(fake.store.has(PHONE_KEY)).toBe(false);

    const replay = await catchError(
      callEndpoint(
        plugin,
        'verifyOtp',
        { phoneNumber: PHONE, otp: '424242' },
        fake.context
      )
    );
    expect(replay.message).toMatch(/Invalid or expired OTP/);
  });

  it('falls back to the email key when the phone key holds a different code', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '111111', [EMAIL_KEY]: '654321' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, email: EMAIL, otp: '654321' },
      fake.context
    );

    expect(fake.secondaryStorage.delete).toHaveBeenCalledTimes(1);
    expect(fake.secondaryStorage.delete).toHaveBeenCalledWith(EMAIL_KEY);
    expect(fake.store.get(PHONE_KEY)).toBe('111111');
  });
});

describe('verifyOtp — existing user', () => {
  it('creates a session, returns the user and skips afterUserCreate', async () => {
    const { options, afterUserCreate } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242' },
      fake.context
    );

    expect(afterUserCreate).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('afterUserCreate');
    expect(result.user).toMatchObject({ id: 'user_existing', email: EMAIL });
    expect(fake.create).not.toHaveBeenCalled();
    // rememberMe is omitted, so the session is a remembered one.
    expect(fake.createSession).toHaveBeenCalledWith('user_existing', false);
    expect(setSessionCookieSpy).toHaveBeenCalledTimes(1);
  });

  it('honours rememberMe:false by asking for a non-remembered session', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242', rememberMe: false },
      fake.context
    );

    expect(fake.createSession).toHaveBeenCalledWith('user_existing', true);
    const cookieArgs = setSessionCookieSpy.mock.calls[0];
    expect(cookieArgs[2]).toBe(true);
  });

  it('marks an unverified phone number as verified', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser({ phoneNumberVerified: false })],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242' },
      fake.context
    );

    expect(fake.update).toHaveBeenCalledWith({
      model: 'user',
      where: [{ field: 'id', value: 'user_existing' }],
      update: { phoneNumberVerified: true },
    });
    expect(result.user).toMatchObject({ phoneNumberVerified: true });
  });

  it('backfills a blank email and marks it verified', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser({ email: '', emailVerified: false })],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, email: 'fresh@example.com', otp: '424242' },
      fake.context
    );

    expect(fake.update).toHaveBeenCalledWith({
      model: 'user',
      where: [{ field: 'id', value: 'user_existing' }],
      update: { email: 'fresh@example.com', emailVerified: true },
    });
    expect(result.user).toMatchObject({
      email: 'fresh@example.com',
      emailVerified: true,
    });
  });

  it('writes no update when both identifiers are already verified', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, email: EMAIL, otp: '424242' },
      fake.context
    );

    expect(fake.update).not.toHaveBeenCalled();
  });

  it('rejects an email that contradicts the registered one — after consuming the OTP', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, email: 'someone.else@example.com', otp: '424242' },
        fake.context
      )
    );

    expect(caught.message).toMatch(/does not match the user’s registered email/);
    // The OTP is deleted before the mismatch check, so a retry needs a new code.
    expect(fake.store.has(PHONE_KEY)).toBe(false);
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it('rejects a phone number that contradicts the registered one', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [EMAIL_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { email: EMAIL, phoneNumber: '+915555555555', otp: '424242' },
        fake.context
      )
    );

    expect(caught.message).toMatch(
      /does not match the user’s registered phone number/
    );
  });

  it('returns SERVICE_UNAVAILABLE when the user cannot be re-read after the update', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });
    const user = knownUser({ phoneNumberVerified: false });
    fake.findOne.mockImplementation(
      async (args: { model: string; where: { field: string; value: unknown }[] }) =>
        args.where[0]?.field === 'id' ? null : user
    );

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '424242' },
        fake.context
      )
    );

    expect(caught.status).toBe('SERVICE_UNAVAILABLE');
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it('maps a session-creation failure to SERVICE_UNAVAILABLE', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
      createSessionError: new Error('redis unavailable'),
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '424242' },
        fake.context
      )
    );

    expect(caught.status).toBe('SERVICE_UNAVAILABLE');
    expect(setSessionCookieSpy).not.toHaveBeenCalled();
  });
});

describe('verifyOtp — new user creation', () => {
  it('creates the user, runs afterUserCreate and returns its payload', async () => {
    const { options, afterUserCreate } = buildOptions();
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, name: 'New Person', age: 22, otp: '424242' },
      fake.context
    );

    expect(fake.create).toHaveBeenCalledTimes(1);
    const created = fake.create.mock.calls[0][0];
    expect(created.model).toBe('user');
    expect(created.data).toMatchObject({
      email: null,
      phoneNumber: PHONE,
      name: 'New Person',
      role: 'user',
      age: 22,
      termsAccepted: true,
      privacyAccepted: true,
      banned: false,
    });
    expect(afterUserCreate).toHaveBeenCalledTimes(1);
    expect(result.afterUserCreate).toEqual({ onboarded: true });
    expect(result.user).toMatchObject({
      phoneNumber: PHONE,
      phoneNumberVerified: true,
    });
  });

  it('defaults the name to "user" and the age to null', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242' },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data).toMatchObject({
      name: 'user',
      age: null,
    });
  });

  it('coerces a string age into a number', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242', age: '17' },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data.age).toBe(17);
  });

  it('rejects an out-of-range age at the schema boundary', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '424242', age: 121 },
        fake.context
      )
    );

    expect(caught.statusCode).toBe(400);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('DISCREPANCY: the new row is written with snake_case email_verified', async () => {
    // `adapter.create` is handed `email_verified: false` while every other read
    // and write in the plugin uses better-auth's camelCase `emailVerified`; the
    // follow-up update sets `emailVerified: true` anyway, so the stray column
    // name is inert rather than harmful. Pinned so a rename is deliberate.
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      storedOtps: { [EMAIL_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { email: EMAIL, otp: '424242' },
      fake.context
    );

    const created = fake.create.mock.calls[0][0].data;
    expect(created).toHaveProperty('email_verified', false);
    expect(created).not.toHaveProperty('emailVerified');
    expect(fake.update).toHaveBeenCalledWith({
      model: 'user',
      where: [{ field: 'id', value: 'user_1' }],
      update: { emailVerified: true },
    });
  });

  it('refuses to create a user when self-signup is gated, yet the OTP is already spent', async () => {
    const { options, afterUserCreate } = buildOptions({
      allowSelfSignup: false,
      adminByDomain: ['admin.example.com'],
    });
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '424242' },
        fake.context
      )
    );

    expect(caught).toBeInstanceOf(APIError);
    expect(caught.body?.code).toBe('SELF_SIGNUP_DISABLED');
    expect(caught.status).toBe('FORBIDDEN');
    expect(fake.create).not.toHaveBeenCalled();
    expect(afterUserCreate).not.toHaveBeenCalled();
    // The single-use delete happens before the gate runs.
    expect(fake.store.has(PHONE_KEY)).toBe(false);
  });

  it('lets an admin-domain email create an account while signup is gated', async () => {
    const { options } = buildOptions({
      allowSelfSignup: false,
      adminByDomain: ['admin.example.com'],
    });
    const fake = createFakeAuthContext({
      storedOtps: { 'otp:email:boss@admin.example.com': '424242' },
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { email: 'boss@admin.example.com', otp: '424242' },
      fake.context
    );

    expect(fake.create).toHaveBeenCalledTimes(1);
    // The bypass alone does not confer admin — that needs createAdmin.
    expect(fake.create.mock.calls[0][0].data.role).toBe('user');
    expect(result.token).toBe('token_for_user_1');
  });

  it('grants the admin role for createAdmin on a configured admin domain', async () => {
    const { options } = buildOptions({ adminByDomain: ['admin.example.com'] });
    const fake = createFakeAuthContext({
      storedOtps: { 'otp:email:boss@admin.example.com': '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { email: 'boss@admin.example.com', otp: '424242', createAdmin: true },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data.role).toBe('admin');
  });

  it('leaves createAdmin on a non-admin domain as an ordinary user', async () => {
    const { options } = buildOptions({ adminByDomain: ['admin.example.com'] });
    const fake = createFakeAuthContext({
      storedOtps: { [EMAIL_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { email: EMAIL, otp: '424242', createAdmin: true },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data.role).toBe('user');
  });

  it('rejects createAdmin without an email address', async () => {
    const { options } = buildOptions({ adminByDomain: ['admin.example.com'] });
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        { phoneNumber: PHONE, otp: '424242', createAdmin: true },
        fake.context
      )
    );

    expect(caught.message).toMatch(/can not be an admin/);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('ignores createAdmin entirely when no admin domains are configured', async () => {
    const { options } = buildOptions({ adminByDomain: undefined });
    const fake = createFakeAuthContext({
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      { phoneNumber: PHONE, otp: '424242', createAdmin: true },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data.role).toBe('user');
  });
});

describe('verifyOtp — joinOrg', () => {
  const org: FakeRow = { id: 'org_1', slug: 'acme' };

  it('adds a membership with the requested role', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      organizations: [{ ...org }],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      {
        phoneNumber: PHONE,
        otp: '424242',
        joinOrg: { orgSlug: 'acme', role: 'seeker', join: true },
      },
      fake.context
    );

    expect(result.token).toBe('token_for_user_existing');
    expect(fake.create).toHaveBeenCalledTimes(1);
    const created = fake.create.mock.calls[0][0];
    expect(created.model).toBe('member');
    expect(created.data).toMatchObject({
      organizationId: 'org_1',
      userId: 'user_existing',
      role: 'seeker',
      teamId: null,
    });
  });

  it('uses the schema default role "viewer" when the role is omitted', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      organizations: [{ ...org }],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      {
        phoneNumber: PHONE,
        otp: '424242',
        joinOrg: { orgSlug: 'acme', join: true },
      },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data.role).toBe('viewer');
  });

  it('falls back to "member" only when the role is explicitly null', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      organizations: [{ ...org }],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      {
        phoneNumber: PHONE,
        otp: '424242',
        joinOrg: { orgSlug: 'acme', role: null, join: true },
      },
      fake.context
    );

    expect(fake.create.mock.calls[0][0].data.role).toBe('member');
  });

  it('does nothing when join is false', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      organizations: [{ ...org }],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      {
        phoneNumber: PHONE,
        otp: '424242',
        joinOrg: { orgSlug: 'acme', join: false },
      },
      fake.context
    );

    expect(fake.create).not.toHaveBeenCalled();
  });

  it('rejects a blank organization slug', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        {
          phoneNumber: PHONE,
          otp: '424242',
          joinOrg: { orgSlug: '', join: true },
        },
        fake.context
      )
    );

    expect(caught.message).toMatch(/Organization slug is required/);
  });

  it('returns NOT_FOUND for an unknown organization', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    const caught = await catchError(
      callEndpoint(
        unifiedOtp(options),
        'verifyOtp',
        {
          phoneNumber: PHONE,
          otp: '424242',
          joinOrg: { orgSlug: 'nope', join: true },
        },
        fake.context
      )
    );

    expect(caught.status).toBe('NOT_FOUND');
    expect(caught.message).toMatch(/Organization not found/);
  });

  it('does not duplicate an existing membership', async () => {
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      organizations: [{ ...org }],
      members: [
        { id: 'member_existing', organizationId: 'org_1', userId: 'user_existing' },
      ],
      storedOtps: { [PHONE_KEY]: '424242' },
    });

    await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      {
        phoneNumber: PHONE,
        otp: '424242',
        joinOrg: { orgSlug: 'acme', role: 'member', join: true },
      },
      fake.context
    );

    expect(fake.create).not.toHaveBeenCalled();
  });

  it('swallows a membership-insert failure and still signs the user in', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { options } = buildOptions();
    const fake = createFakeAuthContext({
      users: [knownUser()],
      organizations: [{ ...org }],
      storedOtps: { [PHONE_KEY]: '424242' },
    });
    fake.create.mockRejectedValueOnce(new Error('member insert failed'));

    const result = await callEndpoint(
      unifiedOtp(options),
      'verifyOtp',
      {
        phoneNumber: PHONE,
        otp: '424242',
        joinOrg: { orgSlug: 'acme', join: true },
      },
      fake.context
    );

    expect(result.token).toBe('token_for_user_existing');
    expect(logSpy).toHaveBeenCalled();
  });
});
