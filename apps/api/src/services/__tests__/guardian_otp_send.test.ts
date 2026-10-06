import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspect } from 'node:util';
import { NotifyTransportError, type NotifyEvent, type NotifyResult } from '@dpg/notification';

const { supportTeamName } = vi.hoisted(() => ({ supportTeamName: { value: 'Bluedots Inc' as string | undefined } }));

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    authConfig: { ...actual.authConfig, create_test_otp: false },
    supportConfig: {
      ...actual.supportConfig,
      get teamName() {
        return supportTeamName.value;
      },
    },
  };
});

const ACCEPTED: NotifyResult = {
  ok: true,
  status: 202,
  body: { notification_event_id: 'ne-1', correlation_id: 'c-1' },
};
const send = vi.fn(async (_event: NotifyEvent): Promise<NotifyResult> => ACCEPTED);
const getNotificationClient = vi.fn<() => { send: typeof send } | undefined>();
vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => getNotificationClient(),
}));

import { defaultGuardianOtpSend, GuardianOtpError } from '@/services/guardian_otp';

const log = { error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  send.mockImplementation(async () => ACCEPTED);
  getNotificationClient.mockReturnValue({ send });
  supportTeamName.value = 'Bluedots Inc';
});

const sentEvent = (): NotifyEvent => send.mock.calls[0][0];

async function expectNoOtpProvider(p: Promise<unknown>): Promise<GuardianOtpError> {
  const err = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GuardianOtpError);
  expect((err as GuardianOtpError).code).toBe('NO_OTP_PROVIDER');
  return err as GuardianOtpError;
}

describe('defaultGuardianOtpSend', () => {
  it('sends a phone-only contact as to: {phone}, urgent, OTP only in variables.message', async () => {
    await defaultGuardianOtpSend({
      contact: '+919800000000',
      contactType: 'phone',
      otp: '000111',
      scenario: { kind: 'action', actionType: 'connect', stage: 'initiate' },
      variables: { parentName: 'Asha', providerOrgName: 'Acme' },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentEvent()).toEqual({
      event_type: 'guardian.otp.action',
      domain: null,
      to: { phone: '+919800000000' },
      variables: {
        message: '000111',
        parentName: 'Asha',
        domain: 'Bluedots Inc',
        org: 'Acme',
        teamName: 'Bluedots Inc',
      },
      priority: 'urgent',
    });
  });

  it('sends an email contact as to: {email}', async () => {
    await defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' });
    expect(sentEvent()).toEqual({
      event_type: 'guardian.otp.generic',
      domain: null,
      to: { email: 'a@b.co' },
      variables: { message: '123456' },
      priority: 'urgent',
    });
  });

  it('never sends a template, channel, subject or html field', async () => {
    await defaultGuardianOtpSend({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '123456',
      scenario: { kind: 'account' },
      variables: {},
    });
    expect(Object.keys(sentEvent()).sort()).toEqual(['domain', 'event_type', 'priority', 'to', 'variables']);
  });

  it('falls back to "Blue Dots" as teamName when no support teamName is configured', async () => {
    supportTeamName.value = undefined;
    await defaultGuardianOtpSend({
      contact: 'a@b.co',
      contactType: 'email',
      otp: '123456',
      scenario: { kind: 'profile' },
      variables: {},
    });
    expect(sentEvent().variables.teamName).toBe('Blue Dots');
  });

  it('hard-fails with NO_OTP_PROVIDER when no notification client is configured', async () => {
    getNotificationClient.mockReturnValue(undefined);
    await expectNoOtpProvider(
      defaultGuardianOtpSend({ contact: '+919876543210', contactType: 'phone', otp: '123456' }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('ok:false (e.g. 422 no_policy) → NO_OTP_PROVIDER, without leaking the code or contact', async () => {
    send.mockResolvedValueOnce({ ok: false, status: 422, error: 'no_policy', kind: 'configuration' });
    const err = await expectNoOtpProvider(
      defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '987654', log }),
    );
    const dump = inspect(err, { depth: 5 });
    expect(dump).toContain('no_policy');
    expect(dump).not.toContain('987654');
    expect(dump).not.toContain('a@b.co');
  });

  it('a transport error → NO_OTP_PROVIDER', async () => {
    send.mockRejectedValueOnce(new NotifyTransportError('fetch failed: TypeError'));
    const err = await expectNoOtpProvider(
      defaultGuardianOtpSend({ contact: '+919876543210', contactType: 'phone', otp: '987654', log }),
    );
    expect(inspect(err, { depth: 5 })).not.toContain('987654');
  });

  it('rethrows an unexpected error unchanged (a defect, not a provider outage)', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(
      defaultGuardianOtpSend({ contact: '+919876543210', contactType: 'phone', otp: '123456' }),
    ).rejects.toThrow('boom');
  });

  describe('failure logging (the route turns the error into a reply without logging it)', () => {
    it('logs an NS refusal with event_type, status and error only', async () => {
      send.mockResolvedValueOnce({ ok: false, status: 422, error: 'no_policy', kind: 'configuration' });
      await expectNoOtpProvider(
        defaultGuardianOtpSend({ contact: '+919876543210', contactType: 'phone', otp: '987654', log }),
      );
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        { event_type: 'guardian.otp.generic', status: 422, error: 'no_policy' },
        expect.stringContaining('ns_rejected'),
      );
      const dump = inspect(log.error.mock.calls, { depth: 5 });
      expect(dump).not.toContain('987654');
      expect(dump).not.toContain('9876543210');
    });

    it('logs a transport failure with event_type and kind only', async () => {
      send.mockRejectedValueOnce(new NotifyTransportError('fetch failed: TypeError'));
      await expectNoOtpProvider(
        defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '987654', log }),
      );
      expect(log.error).toHaveBeenCalledWith(
        { event_type: 'guardian.otp.generic', kind: 'transport', error: 'fetch failed: TypeError' },
        expect.stringContaining('ns_unreachable'),
      );
      const dump = inspect(log.error.mock.calls, { depth: 5 });
      expect(dump).not.toContain('987654');
      expect(dump).not.toContain('a@b.co');
    });

    it('logs and refuses a stored phone that is not E.164, without sending', async () => {
      await expectNoOtpProvider(
        defaultGuardianOtpSend({ contact: '12345', contactType: 'phone', otp: '987654', log }),
      );
      expect(send).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        { event_type: 'guardian.otp.generic', reason: 'guardian_phone_not_e164' },
        expect.any(String),
      );
      expect(inspect(log.error.mock.calls)).not.toContain('12345');
    });

    it('sends a legacy stored phone in its E.164 form', async () => {
      await defaultGuardianOtpSend({ contact: '9876543210', contactType: 'phone', otp: '1', log });
      expect(sentEvent().to).toEqual({ phone: '+919876543210' });
    });

    it('falls back to a pino-shaped error line on stdout when no logger is passed', async () => {
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      send.mockResolvedValueOnce({ ok: false, status: 422, error: 'no_policy', kind: 'configuration' });
      await expectNoOtpProvider(defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '987654' }));
      const lines = spy.mock.calls.map(([chunk]) => String(chunk));
      spy.mockRestore();
      const line = lines.find((l) => l.includes('ns_rejected'));
      expect(line).toBeDefined();
      expect(line!.endsWith('\n')).toBe(true);
      expect(JSON.parse(line!)).toMatchObject({
        level: 50,
        time: expect.any(Number),
        msg: 'guardian otp: ns_rejected',
        event_type: 'guardian.otp.generic',
        status: 422,
        error: 'no_policy',
      });
      expect(line).not.toContain('987654');
      expect(line).not.toContain('a@b.co');
    });
  });
});
