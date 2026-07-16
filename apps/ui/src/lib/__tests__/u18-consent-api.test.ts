import { describe, it, expect, vi } from 'vitest';
import { guardianOtpErrorOf, type GuardianOtpErrorCode } from '../action-api';

describe('U18 consent-api methods', () => {
  it('submitU18Dob POSTs to /api/v1/consent/u18/dob and returns the parsed data', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { isMinor: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { submitU18Dob } = await import('../consent-api');

    const body = { network: 'blue_dot', dateOfBirth: '2012-05-10T00:00:00.000Z' };
    await expect(submitU18Dob(body)).resolves.toEqual({ isMinor: true });
    expect(post).toHaveBeenCalledWith('/api/v1/consent/u18/dob', body);
  });

  it('submitGuardian POSTs to /api/v1/consent/u18/guardian and returns the parsed data', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { otpSent: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { submitGuardian } = await import('../consent-api');

    const body = {
      network: 'blue_dot',
      brand: 'standard',
      guardianName: 'Asha Guardian',
      guardianContact: '+919876543210',
      guardianContactType: 'phone' as const,
      guardianDeclarationAccepted: true as const,
      sameContactAcknowledged: true,
    };
    await expect(submitGuardian(body)).resolves.toEqual({ otpSent: true });
    expect(post).toHaveBeenCalledWith('/api/v1/consent/u18/guardian', body);
  });

  it('verifyGuardian POSTs to /api/v1/consent/u18/guardian/verify and returns the parsed data', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { verified: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { verifyGuardian } = await import('../consent-api');

    const body = { network: 'blue_dot', brand: null, otp: '123456' };
    await expect(verifyGuardian(body)).resolves.toEqual({ verified: true });
    expect(post).toHaveBeenCalledWith('/api/v1/consent/u18/guardian/verify', body);
  });

  it('issueProfileConsentOtp POSTs to /api/v1/consent/u18/profile-consent/issue and returns the parsed data', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { otpSent: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { issueProfileConsentOtp } = await import('../consent-api');

    const body = {
      network: 'blue_dot',
      brand: 'standard',
      item_domain: 'student',
      item_type: 'profile_1.0',
      item_id: 'item-1',
    };
    await expect(issueProfileConsentOtp(body)).resolves.toEqual({ otpSent: true });
    expect(post).toHaveBeenCalledWith('/api/v1/consent/u18/profile-consent/issue', body);
  });

  it('verifyProfileConsentOtp POSTs to /api/v1/consent/u18/profile-consent/verify and returns the parsed data', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ data: { verified: true, promoted: true } });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { verifyProfileConsentOtp } = await import('../consent-api');

    const body = {
      network: 'blue_dot',
      brand: 'standard',
      item_domain: 'student',
      item_type: 'profile_1.0',
      item_id: 'item-1',
      otp: '654321',
    };
    await expect(verifyProfileConsentOtp(body)).resolves.toEqual({
      verified: true,
      promoted: true,
    });
    expect(post).toHaveBeenCalledWith('/api/v1/consent/u18/profile-consent/verify', body);
  });
});

describe('action-api guardian_otp threading', () => {
  const performActionPayload = {
    action_type: 'apply',
    source_item: {
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      item_id: 'src-1',
    },
    target_item: {
      item_network: 'blue_dot',
      item_domain: 'employer',
      item_type: 'job_1.0',
      item_id: 'tgt-1',
      item_instance_url: 'https://instance.example.com',
    },
    requirements_snapshot: {},
  };

  it('performAction omits guardian_otp from the payload when not provided', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({
      data: { results: [{ index: 0, status: 'success', action_id: 'a1' }], summary: { total: 1, succeeded: 1, failed: 0 } },
    });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { performAction } = await import('../action-api');

    await performAction(performActionPayload);

    expect(post).toHaveBeenCalledWith('/api/v1/action/perform', [performActionPayload]);
    const sentBody = post.mock.calls[0][1][0];
    expect(sentBody).not.toHaveProperty('guardian_otp');
  });

  it('performAction includes guardian_otp in the payload when guardianOtp is passed', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({
      data: { results: [{ index: 0, status: 'success', action_id: 'a1' }], summary: { total: 1, succeeded: 1, failed: 0 } },
    });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { performAction } = await import('../action-api');

    await performAction(performActionPayload, undefined, '123456');

    expect(post).toHaveBeenCalledWith('/api/v1/action/perform', [
      { ...performActionPayload, guardian_otp: '123456' },
    ]);
  });

  it('updateActionStatus includes guardian_otp only when guardianOtp is passed', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({
      data: { results: [{ index: 0, status: 'success', action_id: 'a1' }], summary: { total: 1, succeeded: 1, failed: 0 } },
    });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { updateActionStatus } = await import('../action-api');

    const payload = { action_id: 'a1', action_status: 'accepted' };
    await updateActionStatus(payload);
    expect(post).toHaveBeenCalledWith('/api/v1/action/update-status', [payload]);

    await updateActionStatus(payload, '654321');
    expect(post).toHaveBeenCalledWith('/api/v1/action/update-status', [
      { ...payload, guardian_otp: '654321' },
    ]);
  });

  it('performActionsBulk applies guardian_otp to every payload only when passed', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({
      data: {
        results: [
          { index: 0, status: 'success', action_id: 'a1' },
          { index: 1, status: 'success', action_id: 'a2' },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      },
    });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post }) }));
    const { performActionsBulk } = await import('../action-api');

    const payloads = [performActionPayload, { ...performActionPayload, action_type: 'connect' }];
    await performActionsBulk(payloads);
    expect(post).toHaveBeenCalledWith('/api/v1/action/perform', payloads);

    await performActionsBulk(payloads, undefined, 'abcdef');
    expect(post).toHaveBeenCalledWith(
      '/api/v1/action/perform',
      payloads.map((p) => ({ ...p, guardian_otp: 'abcdef' })),
    );
  });
});

describe('guardianOtpErrorOf', () => {
  const codes: GuardianOtpErrorCode[] = [
    'GUARDIAN_OTP_REQUIRED',
    'GUARDIAN_OTP_INVALID',
    'GUARDIAN_OTP_THROTTLED',
    'GUARDIAN_OTP_RATE_LIMITED',
    'OTP_PROVIDER_UNAVAILABLE',
  ];

  it.each(codes)('classifies %s from a bulk result entry', (code) => {
    expect(guardianOtpErrorOf({ error: code })).toBe(code);
  });

  it('returns null for an unrelated error code', () => {
    expect(guardianOtpErrorOf({ error: 'ACTION_NOT_FOUND' })).toBeNull();
  });

  it('returns null for a success entry with no error field', () => {
    expect(guardianOtpErrorOf({})).toBeNull();
  });

  it('returns null for undefined/null entries', () => {
    expect(guardianOtpErrorOf(undefined)).toBeNull();
    expect(guardianOtpErrorOf(null)).toBeNull();
  });
});
