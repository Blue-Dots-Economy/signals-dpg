import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { Toaster } from 'sonner';

const verifyGuardian = vi.fn();
vi.mock('@/lib/consent-api', () => ({
  verifyGuardian: (...args: unknown[]) => verifyGuardian(...args),
}));

async function renderOtpStep(onVerified: () => void, onResend: () => Promise<void>) {
  const { GuardianOtpStep } = await import('../guardian-otp-step');
  render(
    <>
      <Toaster />
      <GuardianOtpStep
        network="blue_dot"
        brand="standard"
        onVerified={onVerified}
        onResend={onResend}
      />
    </>,
  );
}

function typeOtp(digits: string) {
  const inputs = screen.getAllByRole('textbox');
  digits.split('').forEach((d, i) => {
    fireEvent.change(inputs[i], { target: { value: d } });
  });
}

describe('GuardianOtpStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a complete 6-digit code and calls onVerified on success', async () => {
    verifyGuardian.mockResolvedValue({ verified: true });
    const onVerified = vi.fn();
    await renderOtpStep(onVerified, vi.fn());

    typeOtp('123456');

    await waitFor(() =>
      expect(verifyGuardian).toHaveBeenCalledWith({
        network: 'blue_dot',
        brand: 'standard',
        otp: '123456',
      }),
    );
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
  });

  it('shows an inline error for an invalid/expired code and does not call onVerified', async () => {
    verifyGuardian.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { error: 'INVALID_OTP' } },
    });
    const onVerified = vi.fn();
    await renderOtpStep(onVerified, vi.fn());

    typeOtp('000000');

    await waitFor(() => expect(screen.getByText(/incorrect code/i)).toBeInTheDocument());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('shows a friendly message on 429 throttling', async () => {
    verifyGuardian.mockRejectedValue({ isAxiosError: true, response: { status: 429 } });
    await renderOtpStep(vi.fn(), vi.fn());

    typeOtp('111111');

    await waitFor(() => expect(screen.getByText(/too many attempts/i)).toBeInTheDocument());
  });

  it('resends via onResend once the countdown reaches zero', async () => {
    vi.useFakeTimers();
    const onResend = vi.fn().mockResolvedValue(undefined);
    await renderOtpStep(vi.fn(), onResend);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    const resendBtn = screen.getByRole('button', { name: /resend code/i });
    await act(async () => {
      fireEvent.click(resendBtn);
      await Promise.resolve();
    });

    expect(onResend).toHaveBeenCalled();
  });
});
