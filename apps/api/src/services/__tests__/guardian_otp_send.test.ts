import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    authConfig: { ...actual.authConfig, create_test_otp: false },
  };
});

const notify = vi.fn(
  async (args: {
    channel: string;
    template_id: string;
    to: string;
    priority: string;
    variables: Record<string, string>;
  }) => {},
);
const getNotificationClient = vi.fn<() => { notify: typeof notify } | undefined>();
vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => getNotificationClient(),
}));

import { defaultGuardianOtpSend, GuardianOtpError } from '@/services/guardian_otp';

beforeEach(() => {
  vi.clearAllMocks();
  getNotificationClient.mockReturnValue({ notify });
});

describe('defaultGuardianOtpSend', () => {
  it('sends a phone OTP over the sms channel to the contact', async () => {
    await defaultGuardianOtpSend({ contact: '+911', contactType: 'phone', otp: '123456' });
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0];
    expect(payload.channel).toBe('sms');
    expect(payload.to).toBe('+911');
    expect(payload.variables.otp).toBe('123456');
  });

  it('sends an email OTP over the email channel', async () => {
    await defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' });
    const payload = notify.mock.calls[0][0];
    expect(payload.channel).toBe('email');
    expect(payload.to).toBe('a@b.co');
  });

  it('hard-fails with NO_OTP_PROVIDER when no client is configured', async () => {
    getNotificationClient.mockReturnValue(undefined);
    await expect(
      defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' }),
    ).rejects.toBeInstanceOf(GuardianOtpError);
  });

  it('selects the per-scenario template id and merges template variables (#294)', async () => {
    await defaultGuardianOtpSend({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '123456',
      scenario: 'apply_accept',
      variables: { parentName: 'Asha', providerOrgName: 'Acme' },
    });
    const payload = notify.mock.calls[0][0];
    expect(payload.template_id).toBe('guardian_otp_apply_accept_email');
    expect(payload.variables).toEqual({ parentName: 'Asha', providerOrgName: 'Acme', otp: '123456' });
  });

  it('falls back to the generic template when no scenario is supplied', async () => {
    await defaultGuardianOtpSend({ contact: '+911', contactType: 'phone', otp: '000111' });
    expect(notify.mock.calls[0][0].template_id).toBe('guardian_otp_sms');
  });
});
