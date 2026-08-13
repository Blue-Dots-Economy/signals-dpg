import { describe, it, expect, vi, beforeEach } from 'vitest';

const { supportTeamName } = vi.hoisted(() => ({ supportTeamName: { value: 'Bluedots Inc' as string | undefined } }));

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    authConfig: { ...actual.authConfig, create_test_otp: false },
    // Force the fallback so the SMS template assertion is deterministic (the
    // env carries a placeholder SMS_TEMPLATE_ID in CI/local).
    notification: { ...actual.notification, SMS_TEMPLATE_ID: undefined },
    supportConfig: {
      ...actual.supportConfig,
      get teamName() {
        return supportTeamName.value;
      },
    },
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

const dispatchEmail = vi.fn(async (_args: unknown) => ({ ok: true }));
const getDefaultEmailSender = vi.fn<() => { dispatchEmail: typeof dispatchEmail } | null>();
vi.mock('@/notifications/email/dispatch_email', () => ({
  getDefaultEmailSender: () => getDefaultEmailSender(),
}));

import { defaultGuardianOtpSend, GuardianOtpError } from '@/services/guardian_otp';

beforeEach(() => {
  vi.clearAllMocks();
  getNotificationClient.mockReturnValue({ notify });
  getDefaultEmailSender.mockReturnValue({ dispatchEmail });
  supportTeamName.value = 'Bluedots Inc';
});

describe('defaultGuardianOtpSend', () => {
  it('sends a phone OTP over the sms channel to the contact', async () => {
    await defaultGuardianOtpSend({ contact: '+911', contactType: 'phone', otp: '123456' });
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0];
    expect(payload.channel).toBe('sms');
    expect(payload.to).toBe('+911');
    // Single generic DLT OTP template — code only, via `message` (like login).
    expect(payload.variables.message).toBe('123456');
  });

  it('SMS always uses the single generic OTP template (code only), ignoring scenario/vars', async () => {
    await defaultGuardianOtpSend({
      contact: '+911',
      contactType: 'phone',
      otp: '000111',
      scenario: { kind: 'action', actionType: 'connect', stage: 'initiate' },
      variables: { parentName: 'Asha', providerOrgName: 'Acme' },
    });
    const payload = notify.mock.calls[0][0];
    expect(payload.channel).toBe('sms');
    expect(payload.template_id).toBe('login_otp');
    // Only the code goes to SMS — no parent-facing vars (DLT template is fixed).
    expect(payload.variables).toEqual({ message: '000111' });
  });

  it('hard-fails with NO_OTP_PROVIDER when no notification client is configured (sms)', async () => {
    getNotificationClient.mockReturnValue(undefined);
    await expect(
      defaultGuardianOtpSend({ contact: '+911', contactType: 'phone', otp: '123456' }),
    ).rejects.toBeInstanceOf(GuardianOtpError);
  });

  it('hard-fails with NO_OTP_PROVIDER when no notification client is configured (email)', async () => {
    getNotificationClient.mockReturnValue(undefined);
    await expect(
      defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' }),
    ).rejects.toBeInstanceOf(GuardianOtpError);
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('hard-fails with NO_OTP_PROVIDER when a client exists but no email sender is configured', async () => {
    getDefaultEmailSender.mockReturnValue(null);
    await expect(
      defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' }),
    ).rejects.toBeInstanceOf(GuardianOtpError);
    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it('dispatches otp.generic through the central sender when no scenario is given', async () => {
    await defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' });
    expect(notify).not.toHaveBeenCalled();
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    const args = dispatchEmail.mock.calls[0][0] as {
      caseId: string;
      to: string;
      fromName: string;
      variables: Record<string, string>;
    };
    expect(args.caseId).toBe('otp.generic');
    expect(args.to).toBe('a@b.co');
    expect(args.variables.otp).toBe('123456');
  });

  it('dispatches the mapped guardian.* case + variables for a scenario', async () => {
    await defaultGuardianOtpSend({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '123456',
      scenario: { kind: 'action', actionType: 'apply', stage: 'accept' },
      variables: { parentName: 'Asha', providerOrgName: 'Acme' },
    });
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    const args = dispatchEmail.mock.calls[0][0] as {
      caseId: string;
      to: string;
      fromName: string;
      variables: Record<string, string>;
    };
    expect(args.caseId).toBe('guardian.action');
    expect(args.to).toBe('a@b.co');
    expect(args.variables).toMatchObject({
      otp: '123456',
      parentName: 'Asha',
      org: 'Acme',
    });
  });

  it('uses the configured support teamName as fromName (and the guardian.* variable)', async () => {
    await defaultGuardianOtpSend({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '123456',
      scenario: { kind: 'account' },
      variables: {},
    });
    const args = dispatchEmail.mock.calls[0][0] as { fromName: string; variables: Record<string, string> };
    expect(args.fromName).toBe('Bluedots Inc');
    expect(args.variables.teamName).toBe('Bluedots Inc');
  });

  it('falls back to "Blue Dots" as fromName when no support teamName is configured', async () => {
    supportTeamName.value = undefined;
    await defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' });
    const args = dispatchEmail.mock.calls[0][0] as { fromName: string };
    expect(args.fromName).toBe('Blue Dots');
  });

  it('propagates a dispatchEmail failure (critical case) exactly like the old direct notify() did', async () => {
    dispatchEmail.mockRejectedValueOnce(new Error('notification service down'));
    await expect(
      defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' }),
    ).rejects.toThrow('notification service down');
  });
});
