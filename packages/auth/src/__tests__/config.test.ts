import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `createAuth` (src/config.ts).
 *
 * `betterAuth` and every plugin factory are mocked so we can inspect the exact
 * options object `createAuth` builds, and drive the OTP send / after-signup
 * callbacks it installs on the unified-OTP plugin without a better-auth
 * runtime, a database or Redis.
 */

const {
  betterAuthSpy,
  drizzleAdapterSpy,
  openAPISpy,
  bearerSpy,
  adminSpy,
  organizationSpy,
  unifiedOtpSpy,
  apiKeySpy,
} = vi.hoisted(() => ({
  betterAuthSpy: vi.fn((_options: Record<string, unknown>) => ({
    id: 'auth-instance',
  })),
  drizzleAdapterSpy: vi.fn((_db: unknown, _options: unknown) => ({
    id: 'drizzle-adapter',
  })),
  openAPISpy: vi.fn((..._args: unknown[]) => ({ id: 'openapi' })),
  bearerSpy: vi.fn((..._args: unknown[]) => ({ id: 'bearer' })),
  adminSpy: vi.fn((..._args: unknown[]) => ({ id: 'admin' })),
  organizationSpy: vi.fn((..._args: unknown[]) => ({ id: 'organization' })),
  unifiedOtpSpy: vi.fn((_options: Record<string, unknown>) => ({
    id: 'unified-otp',
  })),
  apiKeySpy: vi.fn((_options: Record<string, unknown>) => ({ id: 'apikey' })),
}));

vi.mock('better-auth/minimal', () => ({
  betterAuth: (options: Record<string, unknown>) => betterAuthSpy(options),
}));

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: (db: unknown, options: unknown) =>
    drizzleAdapterSpy(db, options),
}));

vi.mock('better-auth/plugins', () => ({
  openAPI: (...args: unknown[]) => openAPISpy(...args),
  bearer: (...args: unknown[]) => bearerSpy(...args),
  admin: (...args: unknown[]) => adminSpy(...args),
  organization: (...args: unknown[]) => organizationSpy(...args),
}));

vi.mock('@better-auth/api-key', () => ({
  apiKey: (options: Record<string, unknown>) => apiKeySpy(options),
}));

vi.mock('../../plugins/unified_otp', () => ({
  unifiedOtp: (options: Record<string, unknown>) => unifiedOtpSpy(options),
}));

import { createAuth } from '../config';

/* ------------------------------------------------------------------ types */

interface SecondaryStorage {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

interface CookieAttributes {
  sameSite: string;
  secure: boolean;
  partitioned?: boolean;
}

interface CapturedAuthOptions {
  appName: string;
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  rateLimit: { enabled: boolean };
  database: unknown;
  secondaryStorage: SecondaryStorage;
  session: { cookieCache: { enabled: boolean; maxAge: number } };
  emailAndPassword: { enabled: boolean };
  advanced: {
    database: { generateId: () => string };
    disableCSRFCheck: boolean;
    disableOriginCheck: boolean;
    useSecureCookies: boolean;
    crossSubDomainCookies: { enabled: boolean };
    defaultCookieAttributes: CookieAttributes;
    cookies: { sessionToken: { attributes: CookieAttributes } };
  };
  plugins: { id: string }[];
}

interface OtpUser {
  id?: string;
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
}

interface CapturedOtpOptions {
  adminByDomain: string[];
  allowSelfSignup: boolean;
  loginChannels: string[];
  createTestOtp?: boolean;
  sendPhoneOtp: (data: { phoneNumber: string; otp: string }) => Promise<void>;
  sendEmailOtp: (data: {
    email: string;
    otp: string;
    user: OtpUser | null;
  }) => Promise<void>;
  afterUserCreate: (data: { user: OtpUser }) => Promise<unknown>;
}

/* ---------------------------------------------------------------- helpers */

const makeRedis = () => ({
  get: vi.fn(async (_key: string): Promise<string | null | undefined> => null),
  set: vi.fn(
    async (
      _key: string,
      _value: string,
      _mode?: string,
      _ttl?: number
    ): Promise<string> => 'OK'
  ),
  del: vi.fn(async (_key: string): Promise<number> => 1),
});

const makeNotificationClient = () => ({
  notify: vi.fn(
    async (_payload: Record<string, unknown>): Promise<{ ok: boolean }> => ({
      ok: true,
    })
  ),
});

/** Spy for the injected `AuthRuntimeConfig.sendEmail` central dispatcher (#529). */
const makeSendEmail = () =>
  vi.fn(async (_args: Record<string, unknown>): Promise<void> => {});

type RuntimeConfig = Parameters<typeof createAuth>[0];

const buildConfig = (overrides: Record<string, unknown> = {}) => {
  const cfg = {
    appName: 'BlueDots',
    nodeEnv: 'development',
    baseURL: 'http://localhost:3000',
    secret: 'super-secret-value',
    apiDomain: 'localhost',
    trustedOrigins: ['http://localhost:5173'],
    adminDomains: ['bluedots.org'],
    db: { __db: true },
    redis: makeRedis(),
    allowSelfSignup: true,
    loginChannels: ['email', 'phone'],
    ...overrides,
  };
  return cfg as unknown as RuntimeConfig;
};

const build = (overrides: Record<string, unknown> = {}) => {
  const cfg = buildConfig(overrides);
  const instance = createAuth(cfg);
  const options = betterAuthSpy.mock.calls[0][0] as unknown as
    CapturedAuthOptions;
  const otpOptions = unifiedOtpSpy.mock.calls[0][0] as unknown as
    CapturedOtpOptions;
  return { cfg, instance, options, otpOptions };
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  betterAuthSpy.mockClear();
  drizzleAdapterSpy.mockClear();
  openAPISpy.mockClear();
  bearerSpy.mockClear();
  adminSpy.mockClear();
  organizationSpy.mockClear();
  unifiedOtpSpy.mockClear();
  apiKeySpy.mockClear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

/* ------------------------------------------------------------------ tests */

describe('createAuth — instance wiring', () => {
  it('calls betterAuth exactly once and returns its instance', () => {
    const { instance } = build();
    expect(betterAuthSpy).toHaveBeenCalledTimes(1);
    expect(instance).toEqual({ id: 'auth-instance' });
  });

  it('passes appName, baseURL, secret and trustedOrigins straight through', () => {
    const { options } = build({
      appName: 'Signals',
      baseURL: 'https://api.example.org',
      secret: 'sekret',
      trustedOrigins: ['https://a.example', 'https://b.example'],
    });
    expect(options.appName).toBe('Signals');
    expect(options.baseURL).toBe('https://api.example.org');
    expect(options.secret).toBe('sekret');
    expect(options.trustedOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('DISABLES the instance-level rate limit (deliberate gap: OTP endpoints are unthrottled)', () => {
    const { options } = build();
    expect(options.rateLimit).toEqual({ enabled: false });
  });

  it('keeps the rate limit disabled in production too', () => {
    const { options } = build({ nodeEnv: 'production' });
    expect(options.rateLimit.enabled).toBe(false);
  });

  it('builds the database from drizzleAdapter(config.db, { provider: "pg" })', () => {
    const { cfg, options } = build();
    expect(drizzleAdapterSpy).toHaveBeenCalledTimes(1);
    expect(drizzleAdapterSpy.mock.calls[0][0]).toBe(cfg.db);
    expect(drizzleAdapterSpy.mock.calls[0][1]).toEqual({ provider: 'pg' });
    expect(options.database).toEqual({ id: 'drizzle-adapter' });
  });

  it('enables the 10-minute session cookie cache', () => {
    const { options } = build();
    expect(options.session.cookieCache).toEqual({
      enabled: true,
      maxAge: 10 * 60,
    });
  });

  it('leaves email + password sign-in enabled', () => {
    const { options } = build();
    expect(options.emailAndPassword).toEqual({ enabled: true });
  });

  it('generates a fresh uuid per generateId() call', () => {
    const { options } = build();
    const a = options.advanced.database.generateId();
    const b = options.advanced.database.generateId();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(a).not.toBe(b);
  });
});

describe('createAuth — advanced/cookie hardening by nodeEnv', () => {
  it('relaxes CSRF/origin checks and uses lax insecure cookies in development', () => {
    const { options } = build({ nodeEnv: 'development' });
    const adv = options.advanced;
    expect(adv.disableCSRFCheck).toBe(true);
    expect(adv.disableOriginCheck).toBe(true);
    expect(adv.useSecureCookies).toBe(false);
    expect(adv.defaultCookieAttributes).toEqual({
      sameSite: 'lax',
      secure: false,
      partitioned: false,
    });
    expect(adv.cookies.sessionToken.attributes).toEqual({
      sameSite: 'lax',
      secure: false,
    });
  });

  it('enforces CSRF/origin checks and partitioned secure cookies in production', () => {
    const { options } = build({ nodeEnv: 'production' });
    const adv = options.advanced;
    expect(adv.disableCSRFCheck).toBe(false);
    expect(adv.disableOriginCheck).toBe(false);
    expect(adv.useSecureCookies).toBe(true);
    expect(adv.defaultCookieAttributes).toEqual({
      sameSite: 'none',
      secure: true,
      partitioned: true,
    });
    expect(adv.cookies.sessionToken.attributes).toEqual({
      sameSite: 'none',
      secure: true,
    });
  });

  it('never enables cross-subdomain cookies', () => {
    expect(build({ nodeEnv: 'production' }).options.advanced
      .crossSubDomainCookies).toEqual({ enabled: false });
  });

  it('treats any non-"production" nodeEnv as development (e.g. "test")', () => {
    const { options } = build({ nodeEnv: 'test' });
    expect(options.advanced.useSecureCookies).toBe(false);
    expect(options.advanced.disableCSRFCheck).toBe(true);
  });
});

describe('createAuth — plugin list', () => {
  it('registers the six plugins in order', () => {
    const { options } = build();
    expect(options.plugins.map((p) => p.id)).toEqual([
      'openapi',
      'bearer',
      'admin',
      'organization',
      'unified-otp',
      'apikey',
    ]);
  });

  it('configures openAPI with no theme and calls bearer() with no arguments', () => {
    build();
    expect(openAPISpy).toHaveBeenCalledWith({ theme: 'none' });
    expect(bearerSpy).toHaveBeenCalledTimes(1);
    expect(bearerSpy.mock.calls[0]).toEqual([]);
  });

  it('configures the admin plugin with defaultRole "user" and adminRoles ["admin"]', () => {
    build();
    expect(adminSpy).toHaveBeenCalledWith({
      defaultRole: 'user',
      adminRoles: ['admin'],
    });
  });

  it('adds a sortable organization.type field defaulting to "employer"', () => {
    build();
    expect(organizationSpy).toHaveBeenCalledWith({
      schema: {
        organization: {
          additionalFields: {
            type: {
              type: 'string',
              input: true,
              required: false,
              sortable: true,
              defaultValue: 'employer',
            },
          },
        },
      },
    });
  });
});

describe('createAuth — apiKey plugin config (the only rate limit in the package)', () => {
  it('scopes a 1-hour / 10000-request rate limit to API keys', () => {
    build();
    const cfg = apiKeySpy.mock.calls[0][0] as {
      rateLimit: { timeWindow: number; maxRequests: number };
    };
    expect(cfg.rateLimit).toEqual({
      timeWindow: 60 * 60 * 1000,
      maxRequests: 10000,
    });
  });

  it('requires a name, reads the x-api-key header and enables metadata + sessions', () => {
    build();
    const cfg = apiKeySpy.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.requireName).toBe(true);
    expect(cfg.apiKeyHeaders).toBe('x-api-key');
    expect(cfg.enableMetadata).toBe(true);
    expect(cfg.enableSessionForAPIKeys).toBe(true);
  });

  it('derives the key prefix from a lower-cased appName', () => {
    build({ appName: 'BlueDots' });
    expect(
      (apiKeySpy.mock.calls[0][0] as { defaultPrefix: string }).defaultPrefix
    ).toBe('bluedots_');
  });

  it('lower-cases a fully upper-case appName for the prefix', () => {
    build({ appName: 'SIGNALS DPG' });
    expect(
      (apiKeySpy.mock.calls[0][0] as { defaultPrefix: string }).defaultPrefix
    ).toBe('signals dpg_');
  });
});

describe('createAuth — secondaryStorage proxies Redis', () => {
  it('returns the stored value on a hit', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce('123456');
    const { options } = build({ redis });
    await expect(options.secondaryStorage.get('otp:email:a@b.co')).resolves.toBe(
      '123456'
    );
    expect(redis.get).toHaveBeenCalledWith('otp:email:a@b.co');
  });

  it('returns null on a miss', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce(null);
    const { options } = build({ redis });
    await expect(options.secondaryStorage.get('missing')).resolves.toBeNull();
  });

  it('coerces an undefined redis reply to null', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce(undefined);
    const { options } = build({ redis });
    await expect(options.secondaryStorage.get('k')).resolves.toBeNull();
  });

  it('collapses a stored empty string into null (empty value is indistinguishable from a miss)', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce('');
    const { options } = build({ redis });
    await expect(options.secondaryStorage.get('k')).resolves.toBeNull();
  });

  it('writes with the caller-supplied TTL', async () => {
    const redis = makeRedis();
    const { options } = build({ redis });
    await options.secondaryStorage.set('otp:phone:+9111', '000000', 300);
    expect(redis.set).toHaveBeenCalledWith(
      'otp:phone:+9111',
      '000000',
      'EX',
      300
    );
  });

  it('falls back to a 600s TTL when no TTL is given', async () => {
    const redis = makeRedis();
    const { options } = build({ redis });
    await options.secondaryStorage.set('session:abc', 'payload');
    expect(redis.set).toHaveBeenCalledWith('session:abc', 'payload', 'EX', 600);
  });

  it('treats ttl=0 as "no TTL" and still writes a 600s expiry', async () => {
    const redis = makeRedis();
    const { options } = build({ redis });
    await options.secondaryStorage.set('k', 'v', 0);
    expect(redis.set).toHaveBeenCalledWith('k', 'v', 'EX', 600);
  });

  it('deletes through redis.del', async () => {
    const redis = makeRedis();
    const { options } = build({ redis });
    await options.secondaryStorage.delete('otp:email:a@b.co');
    expect(redis.del).toHaveBeenCalledWith('otp:email:a@b.co');
  });
});

describe('createAuth — unifiedOtp option passthrough', () => {
  it('forwards the admin domains, self-signup flag and login channels', () => {
    const { otpOptions } = build({
      adminDomains: ['admin.example'],
      allowSelfSignup: false,
      loginChannels: ['email'],
    });
    expect(otpOptions.adminByDomain).toEqual(['admin.example']);
    expect(otpOptions.allowSelfSignup).toBe(false);
    expect(otpOptions.loginChannels).toEqual(['email']);
  });

  it('forwards createTestOTP as createTestOtp when set', () => {
    expect(build({ createTestOTP: true }).otpOptions.createTestOtp).toBe(true);
  });

  it('leaves createTestOtp undefined when the flag is absent', () => {
    expect(build().otpOptions.createTestOtp).toBeUndefined();
  });
});

describe('sendPhoneOtp', () => {
  it('sends a realtime SMS with the OTP as the message variable', async () => {
    const nc = makeNotificationClient();
    const { otpOptions } = build({ notificationClient: nc });
    await otpOptions.sendPhoneOtp({ phoneNumber: '+911234567890', otp: '424242' });
    expect(nc.notify).toHaveBeenCalledWith({
      channel: 'sms',
      template_id: 'login_otp',
      to: '+911234567890',
      priority: 'realtime',
      variables: { message: '424242' },
    });
  });

  it('uses the configured smsTemplateId when provided', async () => {
    const nc = makeNotificationClient();
    const { otpOptions } = build({
      notificationClient: nc,
      smsTemplateId: 'custom_otp_tpl',
    });
    await otpOptions.sendPhoneOtp({ phoneNumber: '+1555', otp: '111111' });
    expect(
      (nc.notify.mock.calls[0][0] as { template_id: string }).template_id
    ).toBe('custom_otp_tpl');
  });

  it('falls back to login_otp when smsTemplateId is an empty string', async () => {
    const nc = makeNotificationClient();
    const { otpOptions } = build({
      notificationClient: nc,
      smsTemplateId: '',
    });
    await otpOptions.sendPhoneOtp({ phoneNumber: '+1555', otp: '111111' });
    expect(
      (nc.notify.mock.calls[0][0] as { template_id: string }).template_id
    ).toBe('login_otp');
  });

  it('logs AND rethrows a notification-service failure (fail-loud delivery)', async () => {
    const nc = makeNotificationClient();
    const boom = new Error('sms provider down');
    nc.notify.mockRejectedValueOnce(boom);
    const { otpOptions } = build({ notificationClient: nc });
    await expect(
      otpOptions.sendPhoneOtp({ phoneNumber: '+1555', otp: '111111' })
    ).rejects.toBe(boom);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to send phone OTP via notification service:',
      boom
    );
  });

  it('logs the OTP to the console and resolves when no notification client is configured', async () => {
    const { otpOptions } = build();
    await expect(
      otpOptions.sendPhoneOtp({ phoneNumber: '+1555', otp: '999999' })
    ).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith({
      phoneNumber: '+1555',
      message: 'Your OTP: 999999',
    });
  });
});

describe('sendEmailOtp', () => {
  it('calls config.sendEmail with caseId "login.otp", fromName=appName and the otp/userName/signAction/appName variables', async () => {
    const sendEmail = makeSendEmail();
    const { otpOptions } = build({ sendEmail, appName: 'Signals' });
    await otpOptions.sendEmailOtp({
      email: 'alice@example.org',
      otp: '654321',
      user: { name: 'Alice' },
    });
    expect(sendEmail).toHaveBeenCalledWith({
      caseId: 'login.otp',
      to: 'alice@example.org',
      fromName: 'Signals',
      variables: {
        otp: '654321',
        userName: 'alice',
        signAction: 'sign in',
        appName: 'Signals',
      },
    });
  });

  it('renders the sign-up variables when there is no existing user', async () => {
    const sendEmail = makeSendEmail();
    const { otpOptions } = build({ sendEmail });
    await otpOptions.sendEmailOtp({
      email: 'new@example.org',
      otp: '222222',
      user: null,
    });
    const { variables } = sendEmail.mock.calls[0][0] as {
      variables: Record<string, string>;
    };
    expect(variables.signAction).toBe('sign up');
    expect(variables.userName).toBe('user');
  });

  it('logs AND rethrows a sendEmail failure (fail-loud OTP delivery, #1.14)', async () => {
    const boom = new Error('smtp down');
    const sendEmail = vi.fn(async (_args: Record<string, unknown>) => {
      throw boom;
    });
    const { otpOptions } = build({ sendEmail });
    await expect(
      otpOptions.sendEmailOtp({ email: 'a@b.co', otp: '1', user: null })
    ).rejects.toBe(boom);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to send email OTP via notification service:',
      boom
    );
  });

  it('falls back to a console log when config.sendEmail is not configured', async () => {
    const { otpOptions } = build();
    await expect(
      otpOptions.sendEmailOtp({ email: 'a@b.co', otp: '777777', user: null })
    ).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith({
      to: 'a@b.co',
      subject: 'Your One-Time Password',
      otp: '777777',
    });
  });

  it('falls back to the console log even when a notification client is present but sendEmail is not wired', async () => {
    const nc = makeNotificationClient();
    const { otpOptions } = build({ notificationClient: nc });
    await otpOptions.sendEmailOtp({ email: 'a@b.co', otp: '333333', user: null });
    expect(nc.notify).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith({
      to: 'a@b.co',
      subject: 'Your One-Time Password',
      otp: '333333',
    });
  });
});

describe('afterUserCreate', () => {
  const user = (over: Partial<OtpUser> = {}): OtpUser => ({
    id: 'u1',
    name: 'Alice',
    email: 'alice@example.org',
    phoneNumber: '+911234567890',
    ...over,
  });

  it('returns the payload unchanged', async () => {
    const { otpOptions } = build();
    const payload = { user: user() };
    await expect(otpOptions.afterUserCreate(payload)).resolves.toBe(payload);
  });

  // The inline welcome email + WhatsApp were moved out of this hook to
  // apps/api's `sendWelcomeNotifications` (invoked via the caller hook below) so
  // both the better-auth and Keycloak signup paths send the same welcome — see
  // apps/api/src/notifications/welcome.ts + welcome.test.ts for that coverage.
  // What remains to test here is the hook passthrough itself.
  it('runs the caller-supplied hook with the payload even without a notification client', async () => {
    const hook = vi.fn(async (_data: { user: OtpUser }) => {});
    const { otpOptions } = build({ afterUserCreate: hook });
    const payload = { user: user() };
    await otpOptions.afterUserCreate(payload);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toBe(payload);
  });

  it('never lets a hook failure fail signup — it logs and still resolves with the payload', async () => {
    const hook = vi.fn(async (_data: { user: OtpUser }) => {
      throw new Error('guardian materialization failed');
    });
    const { otpOptions } = build({ afterUserCreate: hook });
    const payload = { user: user() };
    await expect(otpOptions.afterUserCreate(payload)).resolves.toBe(payload);
    expect(errorSpy).toHaveBeenCalledWith(
      'afterUserCreate hook failed:',
      expect.any(Error)
    );
  });
});
