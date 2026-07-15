import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitGuardian = vi.fn();
vi.mock('@/lib/consent-api', () => ({
  submitGuardian: (...args: unknown[]) => submitGuardian(...args),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { email: 'ward@example.com', phoneNumber: '+919000000000' },
  }),
}));

async function renderForm(onSubmitted: (body: unknown) => void) {
  const { GuardianFormStep } = await import('../guardian-form-step');
  render(
    <>
      <Toaster />
      <GuardianFormStep network="blue_dot" brand="standard" onSubmitted={onSubmitted} />
    </>,
  );
}

/** Fill name + a (non-ward) phone and tick both consent checkboxes. */
async function fillValid() {
  await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
  await userEvent.type(screen.getByLabelText(/guardian phone number/i), '+911234567890');
  await userEvent.click(screen.getByLabelText(/i accept the terms and conditions/i));
  await userEvent.click(screen.getByLabelText(/i consent to data privacy policy/i));
}

describe('GuardianFormStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Send OTP disabled until name + a contact + both consents are given', async () => {
    await renderForm(vi.fn());
    const submit = screen.getByRole('button', { name: /send otp/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '+911234567890');
    expect(submit).toBeDisabled(); // consents not ticked yet

    await userEvent.click(screen.getByLabelText(/i accept the terms and conditions/i));
    expect(submit).toBeDisabled(); // only one consent
    await userEvent.click(screen.getByLabelText(/i consent to data privacy policy/i));
    expect(submit).toBeEnabled();
  });

  it('sanitizes the guardian phone to digits + a single leading "+"', async () => {
    await renderForm(vi.fn());
    const phone = screen.getByLabelText(/guardian phone number/i) as HTMLInputElement;
    await userEvent.type(phone, '+91 80954-44625abc');
    expect(phone.value).toBe('+918095444625');
  });

  it('submits with the phone contact when only a phone is given', async () => {
    submitGuardian.mockResolvedValue({ otpSent: true });
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);
    await fillValid();
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }));

    await waitFor(() =>
      expect(submitGuardian).toHaveBeenCalledWith({
        network: 'blue_dot',
        brand: 'standard',
        guardianName: 'Asha Guardian',
        guardianContact: '+911234567890',
        guardianContactType: 'phone',
        guardianDeclarationAccepted: true,
      }),
    );
    expect(onSubmitted).toHaveBeenCalled();
  });

  it('prefers email for the OTP contact when both email and phone are given', async () => {
    submitGuardian.mockResolvedValue({ otpSent: true });
    await renderForm(vi.fn());
    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    await userEvent.type(screen.getByLabelText(/guardian email/i), 'guardian@example.com');
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '+911234567890');
    await userEvent.click(screen.getByLabelText(/i accept the terms and conditions/i));
    await userEvent.click(screen.getByLabelText(/i consent to data privacy policy/i));
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }));

    await waitFor(() =>
      expect(submitGuardian).toHaveBeenCalledWith(
        expect.objectContaining({
          guardianContact: 'guardian@example.com',
          guardianContactType: 'email',
        }),
      ),
    );
  });

  it('warns + blocks until same-contact is acknowledged when the guardian phone equals the ward\'s own', async () => {
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);

    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    // Same as the ward's own phone (mocked in auth-context above).
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '+919000000000');
    await userEvent.click(screen.getByLabelText(/i accept the terms and conditions/i));
    await userEvent.click(screen.getByLabelText(/i consent to data privacy policy/i));

    expect(
      screen.getByText(/same as your own contact — are you okay with that\?/i),
    ).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /send otp/i });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByLabelText(/yes, that's okay/i));
    expect(submit).toBeEnabled();

    submitGuardian.mockResolvedValue({ otpSent: true });
    await userEvent.click(submit);
    await waitFor(() =>
      expect(submitGuardian).toHaveBeenCalledWith(
        expect.objectContaining({ sameContactAcknowledged: true }),
      ),
    );
  });

  it('re-surfaces the same-contact warning on a 409 SAME_CONTACT_NEEDS_ACK response', async () => {
    submitGuardian.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: 'SAME_CONTACT_NEEDS_ACK' } },
    });
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);
    await fillValid();
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }));

    await waitFor(() =>
      expect(
        screen.getAllByText(/same as your own contact — are you okay with that\?/i).length,
      ).toBeGreaterThan(0),
    );
    expect(onSubmitted).not.toHaveBeenCalled();

    const submit = screen.getByRole('button', { name: /send otp/i });
    expect(submit).toBeDisabled();
  });
});
