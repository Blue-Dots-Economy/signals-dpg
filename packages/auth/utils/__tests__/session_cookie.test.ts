import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDate, setSessionCookie } from '../index';

/**
 * `setSessionCookie` only touches a narrow slice of better-auth's endpoint
 * context, so it is driven here with a hand-built double. The real signature is
 * typed against better-auth's `GenericEndpointContext`, hence the casts at the
 * call boundary.
 */
interface CookieCall {
  name: string;
  value: string;
  secret: string;
  attributes: Record<string, unknown>;
}

const SESSION_EXPIRES_IN = 604800; // 7 days, in seconds

function createCtx(options: {
  dontRememberCookie?: string | false | null;
  withSecondaryStorage?: boolean;
} = {}) {
  const cookies: CookieCall[] = [];
  const setSignedCookie = vi.fn(
    async (
      name: string,
      value: string,
      secret: string,
      attributes: Record<string, unknown>
    ) => {
      cookies.push({ name, value, secret, attributes });
      return `${name}=${value}`;
    }
  );
  const getSignedCookie = vi.fn(async (_name: string, _secret: string) =>
    options.dontRememberCookie ?? null
  );
  const storageSet = vi.fn(
    async (_key: string, _value: string, _ttl?: number) => {}
  );
  const setNewSession = vi.fn();

  const ctx = {
    getSignedCookie,
    setSignedCookie,
    context: {
      secret: 'test-secret',
      sessionConfig: { expiresIn: SESSION_EXPIRES_IN },
      authCookies: {
        sessionToken: {
          name: 'dpg.session_token',
          attributes: { httpOnly: true, sameSite: 'lax', path: '/' },
        },
        dontRememberToken: {
          name: 'dpg.dont_remember',
          attributes: { httpOnly: true, path: '/' },
        },
      },
      setNewSession,
      secondaryStorage: { set: storageSet },
      options: options.withSecondaryStorage === false ? {} : { secondaryStorage: {} },
    },
  };

  return { ctx, cookies, setSignedCookie, getSignedCookie, storageSet, setNewSession };
}

function createSession(expiresAt: Date) {
  return {
    session: { token: 'session-token-abc', id: 'sess_1', expiresAt },
    user: { id: 'user_1', email: 'a@b.co', name: 'A' },
  };
}

type CtxArg = Parameters<typeof setSessionCookie>[0];
type SessionArg = Parameters<typeof setSessionCookie>[1];

describe('getDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats the span as milliseconds by default', () => {
    expect(getDate(1500).toISOString()).toBe('2026-01-01T00:00:01.500Z');
  });

  it('multiplies by 1000 when the unit is seconds', () => {
    expect(getDate(90, 'sec').toISOString()).toBe('2026-01-01T00:01:30.000Z');
  });

  it('accepts an explicit ms unit and a negative span (a past date)', () => {
    expect(getDate(250, 'ms').toISOString()).toBe('2026-01-01T00:00:00.250Z');
    expect(getDate(-1, 'sec').toISOString()).toBe('2025-12-31T23:59:59.000Z');
  });
});

describe('setSessionCookie', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a remembered session cookie with the configured maxAge', async () => {
    const harness = createCtx();
    const session = createSession(new Date('2026-01-01T02:00:00.000Z'));

    await setSessionCookie(harness.ctx as unknown as CtxArg, session as unknown as SessionArg);

    expect(harness.cookies).toHaveLength(1);
    expect(harness.cookies[0]).toEqual({
      name: 'dpg.session_token',
      value: 'session-token-abc',
      secret: 'test-secret',
      attributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_EXPIRES_IN,
      },
    });
    expect(harness.setNewSession).toHaveBeenCalledWith(session);
  });

  it('reads the dont-remember cookie with the auth secret', async () => {
    const harness = createCtx();
    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T02:00:00.000Z')) as unknown as SessionArg
    );

    expect(harness.getSignedCookie).toHaveBeenCalledWith(
      'dpg.dont_remember',
      'test-secret'
    );
  });

  it('omits maxAge and sets the dont-remember cookie when told not to remember', async () => {
    const harness = createCtx();

    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T02:00:00.000Z')) as unknown as SessionArg,
      true
    );

    expect(harness.cookies).toHaveLength(2);
    expect(harness.cookies[0].attributes.maxAge).toBeUndefined();
    expect(harness.cookies[1]).toEqual({
      name: 'dpg.dont_remember',
      value: 'true',
      secret: 'test-secret',
      attributes: { httpOnly: true, path: '/' },
    });
  });

  it('infers dont-remember from an existing signed cookie when the flag is omitted', async () => {
    const harness = createCtx({ dontRememberCookie: 'true' });

    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T02:00:00.000Z')) as unknown as SessionArg
    );

    expect(harness.cookies).toHaveLength(2);
    expect(harness.cookies[0].attributes.maxAge).toBeUndefined();
    expect(harness.cookies[1].name).toBe('dpg.dont_remember');
  });

  it('lets an explicit false flag override the existing dont-remember cookie', async () => {
    const harness = createCtx({ dontRememberCookie: 'true' });

    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T02:00:00.000Z')) as unknown as SessionArg,
      false
    );

    expect(harness.cookies).toHaveLength(1);
    expect(harness.cookies[0].attributes.maxAge).toBe(SESSION_EXPIRES_IN);
  });

  it('applies overrides last, so they win over the computed maxAge', async () => {
    const harness = createCtx();

    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T02:00:00.000Z')) as unknown as SessionArg,
      false,
      { maxAge: 42, sameSite: 'strict' }
    );

    expect(harness.cookies[0].attributes).toMatchObject({
      maxAge: 42,
      sameSite: 'strict',
      httpOnly: true,
    });
  });

  it('mirrors the session into secondary storage keyed by the session token', async () => {
    const harness = createCtx();
    const session = createSession(new Date('2026-01-01T02:00:00.000Z'));

    await setSessionCookie(harness.ctx as unknown as CtxArg, session as unknown as SessionArg);

    expect(harness.storageSet).toHaveBeenCalledTimes(1);
    const [key, payload, ttl] = harness.storageSet.mock.calls[0];
    expect(key).toBe('session-token-abc');
    expect(JSON.parse(payload)).toEqual({
      user: { id: 'user_1', email: 'a@b.co', name: 'A' },
      session: {
        token: 'session-token-abc',
        id: 'sess_1',
        expiresAt: '2026-01-01T02:00:00.000Z',
      },
    });
    // 2 hours until expiry, expressed in whole seconds.
    expect(ttl).toBe(7200);
  });

  it('floors a fractional remaining lifetime to whole seconds', async () => {
    const harness = createCtx();

    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T00:00:09.900Z')) as unknown as SessionArg
    );

    expect(harness.storageSet.mock.calls[0][2]).toBe(9);
  });

  it('skips secondary storage when the auth options do not enable it', async () => {
    const harness = createCtx({ withSecondaryStorage: false });

    await setSessionCookie(
      harness.ctx as unknown as CtxArg,
      createSession(new Date('2026-01-01T02:00:00.000Z')) as unknown as SessionArg
    );

    expect(harness.storageSet).not.toHaveBeenCalled();
    expect(harness.setNewSession).toHaveBeenCalledTimes(1);
  });
});
