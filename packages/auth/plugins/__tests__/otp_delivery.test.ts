import { describe, it, expect, vi } from 'vitest';
import { APIError } from 'better-auth/api';
import { deliverOtp } from '../otp_delivery';

const baseDeps = () => ({
  otp: '123456',
  user: null,
  storage: { delete: vi.fn(async () => {}) },
  sendPhoneOtp: vi.fn(async () => {}),
  sendEmailOtp: vi.fn(async () => {}),
});

describe('deliverOtp', () => {
  it('sends a phone OTP and does not touch storage on success', async () => {
    const d = baseDeps();
    await deliverOtp({
      ...d,
      phoneNumber: '+911234567890',
      storageKey: 'otp:phone:+911234567890',
    });
    expect(d.sendPhoneOtp).toHaveBeenCalledWith({
      phoneNumber: '+911234567890',
      otp: '123456',
    });
    expect(d.sendEmailOtp).not.toHaveBeenCalled();
    expect(d.storage.delete).not.toHaveBeenCalled();
  });

  it('sends an email OTP on success', async () => {
    const d = baseDeps();
    await deliverOtp({ ...d, email: 'a@b.co', storageKey: 'otp:email:a@b.co' });
    expect(d.sendEmailOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      otp: '123456',
      user: null,
    });
    expect(d.storage.delete).not.toHaveBeenCalled();
  });

  it('throws OTP_DELIVERY_FAILED and drops the stored OTP when the phone send fails', async () => {
    const d = baseDeps();
    d.sendPhoneOtp.mockRejectedValueOnce(new Error('sms provider down'));
    const key = 'otp:phone:+911234567890';
    await expect(
      deliverOtp({ ...d, phoneNumber: '+911234567890', storageKey: key }),
    ).rejects.toMatchObject({ body: { code: 'OTP_DELIVERY_FAILED' } });
    expect(d.storage.delete).toHaveBeenCalledWith(key);
  });

  it('surfaces the failure with a 502 status', async () => {
    const d = baseDeps();
    d.sendEmailOtp.mockRejectedValueOnce(new Error('smtp refused'));
    let caught: unknown;
    try {
      await deliverOtp({ ...d, email: 'a@b.co', storageKey: 'otp:email:a@b.co' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).statusCode).toBe(502);
  });

  it('awaits the email send — a rejected email (not fire-and-forget) fails the delivery', async () => {
    const d = baseDeps();
    // Regression for the original bug: sendEmailOtp was invoked without await,
    // so a rejection was invisible and the endpoint still reported success.
    d.sendEmailOtp.mockRejectedValueOnce(new Error('async email failure'));
    await expect(
      deliverOtp({ ...d, email: 'a@b.co', storageKey: 'otp:email:a@b.co' }),
    ).rejects.toBeInstanceOf(APIError);
    expect(d.storage.delete).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing storage on failure (still throws)', async () => {
    const d = baseDeps();
    d.sendPhoneOtp.mockRejectedValueOnce(new Error('boom'));
    await expect(
      deliverOtp({
        ...d,
        storage: null,
        phoneNumber: '+911234567890',
        storageKey: 'otp:phone:+911234567890',
      }),
    ).rejects.toBeInstanceOf(APIError);
  });
});
