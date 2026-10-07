import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspect } from 'node:util';
import { NotifyTransportError, USER_WELCOME, type NotifyEvent, type NotifyResult } from '@dpg/notification';

/**
 * The welcome is ONE `user.welcome` event: the notification service's policy
 * (mode `all`) fans it out to email and WhatsApp for whichever contact points
 * `to` carries. The guarantee under test is that nothing here may ever throw
 * into a signup or a login.
 */

const ACCEPTED: NotifyResult = {
  ok: true,
  status: 202,
  body: { notification_event_id: 'ne-1', correlation_id: 'c-1' },
};
const send = vi.fn(async (_event: NotifyEvent): Promise<NotifyResult> => ACCEPTED);
let clientConfigured = true;

// Mutable so each test can control both the fallback base URL and the
// per-domain bindings independently (#569).
const mockNotification: { FRONTEND_BASE_URL: string | undefined } = {
  FRONTEND_BASE_URL: 'https://blue.example',
};
const mockUiHostBindings: { byDomain: Record<string, string>; warnings: string[] } = {
  byDomain: {},
  warnings: [],
};

vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => (clientConfigured ? { send } : undefined),
}));

vi.mock('@/config', () => ({
  instance: { INSTANCE_NAME: 'Blue Dots' },
  notification: mockNotification,
  uiHostBindings: mockUiHostBindings,
}));

const { sendWelcomeNotifications, welcomeIdempotencyKey } = await import('../welcome.js');

const makeLog = () => ({ error: vi.fn(), warn: vi.fn() });

const BOTH = { userId: 'u-1', name: 'Asha', email: 'asha@example.org', phoneNumber: '+911234567890' };

const sentEvent = (): NotifyEvent => send.mock.calls[0][0];

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async () => ACCEPTED);
  clientConfigured = true;
  mockNotification.FRONTEND_BASE_URL = 'https://blue.example';
  mockUiHostBindings.byDomain = {};
});

describe('the user.welcome event', () => {
  it('sends one event carrying both contact points, so the policy fans out to email + WhatsApp', async () => {
    await sendWelcomeNotifications(BOTH, makeLog());

    expect(send).toHaveBeenCalledTimes(1);
    expect(sentEvent()).toEqual({
      event_type: USER_WELCOME,
      domain: null,
      to: { email: 'asha@example.org', phone: '+911234567890' },
      variables: {
        userName: 'Asha',
        appName: 'Blue Dots',
        teamName: 'Blue Dots',
        siteUrl: 'https://blue.example',
        '1': 'Asha',
      },
      priority: 'urgent',
      idempotency_key: 'user.welcome:u-1',
    });
  });

  it('carries the signup domain when known', async () => {
    await sendWelcomeNotifications(BOTH, makeLog(), 'seeker');
    expect(sentEvent().domain).toBe('seeker');
  });

  it('sends a phone-only user to: {phone}', async () => {
    await sendWelcomeNotifications({ ...BOTH, email: null }, makeLog());
    expect(sentEvent().to).toEqual({ phone: '+911234567890' });
  });

  it('sends an email-only user to: {email}', async () => {
    await sendWelcomeNotifications({ ...BOTH, phoneNumber: null }, makeLog());
    expect(sentEvent().to).toEqual({ email: 'asha@example.org' });
  });

  it('falls back to "user" for a nameless user in both the email and WhatsApp variables', async () => {
    await sendWelcomeNotifications({ ...BOTH, name: '' }, makeLog());
    expect(sentEvent().variables).toMatchObject({ userName: 'user', '1': 'user' });
  });

  it('is a no-op for a user with neither identifier', async () => {
    await sendWelcomeNotifications({ ...BOTH, email: null, phoneNumber: null }, makeLog());
    expect(send).not.toHaveBeenCalled();
  });

  it('is a no-op when no notification client is configured', async () => {
    clientConfigured = false;
    await expect(sendWelcomeNotifications(BOTH, makeLog())).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('phone is normalised to E.164 (R14)', () => {
  it('normalises a stored bare 10-digit phone instead of dropping it', async () => {
    const log = makeLog();
    await sendWelcomeNotifications({ ...BOTH, phoneNumber: '9876543210' }, log);
    expect(sentEvent().to).toEqual({ email: 'asha@example.org', phone: '+919876543210' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('still welcomes a phone-only user whose stored phone is spaced/dashed', async () => {
    await sendWelcomeNotifications({ ...BOTH, email: null, phoneNumber: ' 98765-43210 ' }, makeLog());
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentEvent().to).toEqual({ phone: '+919876543210' });
  });

  it('drops an unusable phone from `to` and warns welcome_phone_dropped without PII', async () => {
    const log = makeLog();
    await sendWelcomeNotifications({ ...BOTH, phoneNumber: '12345' }, log);
    expect(sentEvent().to).toEqual({ email: 'asha@example.org' });
    expect(log.warn).toHaveBeenCalledWith({ event_type: USER_WELCOME }, expect.stringContaining('welcome_phone_dropped'));
    expect(log.error).not.toHaveBeenCalled();
    const dump = inspect(log.warn.mock.calls);
    expect(dump).not.toContain('12345');
    expect(dump).not.toContain('asha@example.org');
  });

  it('sends nothing when the only contact is an unusable phone', async () => {
    const log = makeLog();
    await sendWelcomeNotifications({ ...BOTH, email: null, phoneNumber: 'abc' }, log);
    expect(send).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('idempotency (R12): one welcome per user', () => {
  it('the key is per user, not per occurrence, so a repeat for the same user collapses', async () => {
    await sendWelcomeNotifications(BOTH, makeLog());
    await sendWelcomeNotifications(BOTH, makeLog(), 'seeker');
    expect(send.mock.calls[0][0].idempotency_key).toBe(send.mock.calls[1][0].idempotency_key);
  });

  it('two users get two keys', () => {
    expect(welcomeIdempotencyKey('u-1')).not.toBe(welcomeIdempotencyKey('u-2'));
  });

  it('stays within the 128-character key limit for a UUID user id', () => {
    expect(welcomeIdempotencyKey('0f8fad5b-d9cb-469f-a165-70867728950e').length).toBeLessThanOrEqual(128);
  });
});

describe('per-domain CTA (#569) and the no-siteUrl rule (F2-2)', () => {
  it('links the welcome to the signup domain portal', async () => {
    mockUiHostBindings.byDomain = { seeker: 'https://seeker.example.org' };
    await sendWelcomeNotifications({ ...BOTH, phoneNumber: null }, makeLog(), 'seeker');
    expect(sentEvent().variables.siteUrl).toBe('https://seeker.example.org/auth/login');
  });

  it('skips the send (and logs) when siteUrl is unresolvable and there is no phone', async () => {
    mockNotification.FRONTEND_BASE_URL = undefined;
    const log = makeLog();
    await sendWelcomeNotifications({ ...BOTH, phoneNumber: null }, log, 'nosuchdomain');
    expect(send).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(inspect(log.error.mock.calls)).not.toContain('asha@example.org');
  });

  it('drops the email from `to` (WhatsApp still goes) when siteUrl is unresolvable but there is a phone', async () => {
    mockNotification.FRONTEND_BASE_URL = undefined;
    await sendWelcomeNotifications(BOTH, makeLog(), 'nosuchdomain');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentEvent().to).toEqual({ phone: '+911234567890' });
    expect(sentEvent().variables).not.toHaveProperty('siteUrl');
  });
});

describe('failure handling', () => {
  it('logs and swallows an ok:false refusal, without the recipient or variable values', async () => {
    send.mockResolvedValueOnce({ ok: false, status: 422, error: 'no_policy', kind: 'configuration' });
    const log = makeLog();
    await expect(sendWelcomeNotifications(BOTH, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    const dump = inspect(log.error.mock.calls, { depth: 5 });
    expect(dump).toContain('no_policy');
    expect(dump).not.toContain('asha@example.org');
    expect(dump).not.toContain('+911234567890');
    expect(dump).not.toContain('Asha');
  });

  it('logs and swallows a transport error', async () => {
    send.mockRejectedValueOnce(new NotifyTransportError('fetch failed: TypeError'));
    const log = makeLog();
    await expect(sendWelcomeNotifications(BOTH, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('never throws on an unexpected error either', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    const log = makeLog();
    await expect(sendWelcomeNotifications(BOTH, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
