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

// The T&C / Privacy links open an in-app ConsentModal via this hook (react-query
// backed); the form tests never open it, so a null config is enough.
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
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

/** Fill name + a (non-ward) phone. Consent is captured via the gate popup on
 * submit; with a null consent config (see mock) the form submits directly. */
async function fillValid() {
  await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
  await userEvent.type(screen.getByLabelText(/guardian phone number/i), '9876543210');
}

describe('GuardianFormStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Send OTP disabled until name + a contact are given', async () => {
    await renderForm(vi.fn());
    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    expect(submit).toBeDisabled(); // no contact yet

    // Consent is captured in the popup on submit, not a pre-req to enable.
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '9876543210');
    expect(submit).toBeEnabled();
  });

  it('guardian phone takes only the 10-digit national number (+91 fixed prefix)', async () => {
    await renderForm(vi.fn());
    const phone = screen.getByLabelText(/guardian phone number/i) as HTMLInputElement;
    await userEvent.type(phone, '80954 44625abc99');
    expect(phone.value).toBe('8095444625');
  });

  it('submits the phone (E.164) when only a phone is given', async () => {
    submitGuardian.mockResolvedValue({ otpSent: true });
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);
    await fillValid();
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitGuardian).toHaveBeenCalledWith({
        network: 'blue_dot',
        brand: 'standard',
        guardianName: 'Asha Guardian',
        guardianPhone: '+919876543210',
        guardianDeclarationAccepted: true,
      }),
    );
    expect(onSubmitted).toHaveBeenCalled();
  });

  it('sends BOTH contacts when email and phone are given (server picks the OTP channel)', async () => {
    submitGuardian.mockResolvedValue({ otpSent: true });
    await renderForm(vi.fn());
    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    await userEvent.type(screen.getByLabelText(/guardian email/i), 'guardian@example.com');
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitGuardian).toHaveBeenCalledWith(
        expect.objectContaining({
          guardianEmail: 'guardian@example.com',
          guardianPhone: '+919876543210',
        }),
      ),
    );
  });

  it('hard-blocks (no submit) when the guardian phone equals the ward\'s own', async () => {
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);

    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    // Same as the ward's own phone (mocked in auth-context above).
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '9000000000');

    expect(screen.getByText(/can't be the same as your own/i)).toBeInTheDocument();

    // No acknowledgement path — the submit stays disabled.
    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();
    expect(screen.queryByLabelText(/yes, that's okay/i)).not.toBeInTheDocument();
    expect(submitGuardian).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('surfaces a hard error + disables submit on a 409 SAME_CONTACT_NOT_ALLOWED response', async () => {
    submitGuardian.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: 'SAME_CONTACT_NOT_ALLOWED' } },
    });
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);
    await fillValid();
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getAllByText(/can't be the same as your own/i).length).toBeGreaterThan(0),
    );
    expect(onSubmitted).not.toHaveBeenCalled();

    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();
  });
});
