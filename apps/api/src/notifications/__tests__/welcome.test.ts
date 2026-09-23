import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The guarantee under test is isolation: one dead channel must not suppress the
 * other, and nothing here may ever throw into a signup or a login. That posture
 * is inherited from the better-auth hook this replaces
 * (packages/auth/src/config.ts, before G1).
 */

/** The subset of the notification-service payload these assertions care about. */
interface NotifyPayload {
  channel: string;
  template_id: string;
  to: string;
  priority: string;
  variables: Record<string, unknown>;
}

const notify = vi.fn(async (_payload: NotifyPayload): Promise<unknown> => ({}));
let clientConfigured = true;

// Mutable so each test can control both the fallback base URL and the
// per-domain bindings independently (#569) — a static object literal can't
// represent "domain resolves to nothing", which the "omits siteUrl entirely"
// test below needs. Reset in `beforeEach` to the values the pre-existing
// tests expect.
const mockNotification: { FRONTEND_BASE_URL: string | undefined } = {
  FRONTEND_BASE_URL: 'https://blue.example',
};
const mockUiHostBindings: { byDomain: Record<string, string>; warnings: string[] } = {
  byDomain: {},
  warnings: [],
};

vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => (clientConfigured ? { notify } : undefined),
}));

vi.mock('@/config', () => ({
  instance: { INSTANCE_NAME: 'Blue Dots' },
  notification: mockNotification,
  uiHostBindings: mockUiHostBindings,
}));

/**
 * The welcome EMAIL goes through the central dispatcher (#529) so its copy comes
 * from the messages file. It is the only channel: there is no WhatsApp (planned,
 * not supported) or other phone welcome. The raw client's `notify` stays mocked
 * so these tests can assert it is never called directly. This file tests channel
 * selection and failure isolation, not rendering.
 */
const dispatchEmail = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true }));

vi.mock('../email/dispatch_email', () => ({
  getDefaultEmailSender: () => (clientConfigured ? { dispatchEmail } : null),
}));

const { sendWelcomeNotifications } = await import('../welcome.js');

const makeLog = () => ({ error: vi.fn() });

const BOTH = { name: 'Asha', email: 'asha@example.org', phoneNumber: '+911234567890' };

/** Channels actually attempted, in order — email via dispatcher, anything else via notify. */
const attempted = () => [
  ...dispatchEmail.mock.calls.map(() => 'email'),
  ...notify.mock.calls.map(([p]) => p.channel),
];

beforeEach(() => {
  notify.mockClear();
  notify.mockImplementation(async () => ({}));
  dispatchEmail.mockClear();
  dispatchEmail.mockImplementation(async () => ({ ok: true }));
  clientConfigured = true;
  mockNotification.FRONTEND_BASE_URL = 'https://blue.example';
  mockUiHostBindings.byDomain = {};
});

describe('channel selection', () => {
  it('sends only the email when the user has both identifiers', async () => {
    await sendWelcomeNotifications(BOTH, makeLog());

    expect(attempted()).toEqual(['email']);
  });

  it('sends nothing for a phone-only user (no phone welcome channel)', async () => {
    // Admin-onboarded participants legitimately have email === null. WhatsApp
    // is planned, not supported, so they get no welcome message.
    await sendWelcomeNotifications(
      { name: 'Asha', email: null, phoneNumber: '+911234567890' },
      makeLog()
    );

    expect(attempted()).toEqual([]);
  });

  it('sends only email for an email-only user', async () => {
    await sendWelcomeNotifications(
      { name: 'Asha', email: 'asha@example.org', phoneNumber: null },
      makeLog()
    );

    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('is a no-op for a user with neither identifier', async () => {
    await sendWelcomeNotifications({ name: 'Asha', email: null, phoneNumber: null }, makeLog());

    expect(attempted()).toEqual([]);
  });

  it('is a no-op when no notification client is configured', async () => {
    clientConfigured = false;

    await expect(sendWelcomeNotifications(BOTH, makeLog())).resolves.toBeUndefined();
  });
});

describe('per-domain welcome copy', () => {
  const emailOnly = { name: 'Asha', email: 'asha@example.org', phoneNumber: null };

  it('uses the generic case when no domain is given', async () => {
    await sendWelcomeNotifications(emailOnly, makeLog());
    expect(dispatchEmail.mock.calls[0][0].caseId).toBe('welcome');
  });

  it('uses welcome.seeker for a seeker signup', async () => {
    await sendWelcomeNotifications(emailOnly, makeLog(), 'seeker');
    expect(dispatchEmail.mock.calls[0][0].caseId).toBe('welcome.seeker');
  });

  it('uses welcome.provider for a provider signup', async () => {
    await sendWelcomeNotifications(emailOnly, makeLog(), 'provider');
    expect(dispatchEmail.mock.calls[0][0].caseId).toBe('welcome.provider');
  });

  it('folds service_provider into the provider copy', async () => {
    await sendWelcomeNotifications(emailOnly, makeLog(), 'service_provider');
    expect(dispatchEmail.mock.calls[0][0].caseId).toBe('welcome.provider');
  });
});

describe('failure isolation', () => {
  it('never throws and logs once when the email send rejects', async () => {
    dispatchEmail.mockRejectedValue(new Error('notification service down'));
    const log = makeLog();

    await expect(sendWelcomeNotifications(BOTH, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('message content', () => {
  it('addresses the user by name and names the instance', async () => {
    await sendWelcomeNotifications(BOTH, makeLog());

    // Copy itself lives in the messages file; what this asserts is that the
    // dispatcher is handed the right case and the right substitution values.
    expect(dispatchEmail).toHaveBeenCalledWith({
      caseId: 'welcome',
      to: 'asha@example.org',
      fromName: 'Blue Dots',
      variables: {
        userName: 'Asha',
        appName: 'Blue Dots',
        siteUrl: 'https://blue.example',
        teamName: 'Blue Dots',
      },
    });
  });
});

describe('per-domain CTA (#569)', () => {
  it('links the welcome mail to the signup domain portal', async () => {
    mockUiHostBindings.byDomain = { seeker: 'https://seeker.example.org' };

    await sendWelcomeNotifications(
      { name: 'Asha', email: 'asha@example.com', phoneNumber: null },
      makeLog(),
      'seeker'
    );

    const dispatched = dispatchEmail.mock.calls[0]?.[0] as
      | { variables?: Record<string, unknown> }
      | undefined;
    expect(dispatched?.variables?.siteUrl).toBe('https://seeker.example.org/auth/login');
  });

  it('omits siteUrl entirely when the domain resolves to nothing', async () => {
    // No mapping and no FRONTEND_BASE_URL: renderSiteLink(undefined) must be
    // able to fall back to the words "the platform" rather than a dead anchor.
    mockUiHostBindings.byDomain = {};
    mockNotification.FRONTEND_BASE_URL = undefined;

    await sendWelcomeNotifications(
      { name: 'Asha', email: 'asha@example.com', phoneNumber: null },
      makeLog(),
      'nosuchdomain'
    );

    const dispatched = dispatchEmail.mock.calls[0]?.[0] as
      | { variables?: Record<string, unknown> }
      | undefined;
    expect(dispatched?.variables).not.toHaveProperty('siteUrl');
  });
});
