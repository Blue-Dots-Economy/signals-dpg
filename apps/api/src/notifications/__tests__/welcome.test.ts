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

vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => (clientConfigured ? { notify } : undefined),
}));

vi.mock('@/config', () => ({ instance: { INSTANCE_NAME: 'Blue Dots' } }));

const { sendWelcomeNotifications } = await import('../welcome.js');

const makeLog = () => ({ error: vi.fn() });

const BOTH = { name: 'Asha', email: 'asha@example.org', phoneNumber: '+911234567890' };

beforeEach(() => {
  notify.mockClear();
  notify.mockImplementation(async () => ({}));
  clientConfigured = true;
});

describe('channel selection', () => {
  it('sends email and WhatsApp when the user has both identifiers', async () => {
    await sendWelcomeNotifications(BOTH, makeLog());

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map(([p]) => p.channel)).toEqual(['email', 'whatsapp']);
  });

  it('sends only WhatsApp for a phone-only user', async () => {
    // The case that matters after the write-path change: admin-onboarded
    // participants legitimately have email === null.
    await sendWelcomeNotifications(
      { name: 'Asha', email: null, phoneNumber: '+911234567890' },
      makeLog()
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].channel).toBe('whatsapp');
  });

  it('sends only email for an email-only user', async () => {
    await sendWelcomeNotifications(
      { name: 'Asha', email: 'asha@example.org', phoneNumber: null },
      makeLog()
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].channel).toBe('email');
  });

  it('is a no-op for a user with neither identifier', async () => {
    await sendWelcomeNotifications({ name: 'Asha', email: null, phoneNumber: null }, makeLog());

    expect(notify).not.toHaveBeenCalled();
  });

  it('is a no-op when no notification client is configured', async () => {
    clientConfigured = false;

    await expect(sendWelcomeNotifications(BOTH, makeLog())).resolves.toBeUndefined();
  });
});

describe('failure isolation', () => {
  it('still sends WhatsApp when the email send rejects', async () => {
    notify.mockRejectedValueOnce(new Error('smtp down'));
    const log = makeLog();

    await sendWelcomeNotifications(BOTH, log);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0].channel).toBe('whatsapp');
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('never throws when every channel rejects', async () => {
    notify.mockRejectedValue(new Error('notification service down'));
    const log = makeLog();

    await expect(sendWelcomeNotifications(BOTH, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});

describe('message content', () => {
  it('addresses the user by name and names the instance', async () => {
    await sendWelcomeNotifications(BOTH, makeLog());

    const email = notify.mock.calls[0][0];
    const emailVars = email.variables as { html: string; fromName: string };
    expect(email.to).toBe('asha@example.org');
    expect(emailVars.html).toContain('Asha');
    expect(emailVars.html).toContain('Blue Dots');
    expect(emailVars.fromName).toContain('Blue Dots');

    // WhatsApp is a pre-approved content template; the name is variable "1".
    const wa = notify.mock.calls[1][0];
    const waVars = wa.variables as {
      contentSid: string;
      contentVariables: Record<string, string>;
    };
    expect(wa.to).toBe('+911234567890');
    expect(waVars.contentSid).toBe('HX3f2a5d7e4a18e5664124592a12a154eb');
    expect(waVars.contentVariables['1']).toBe('Asha');
  });
});
