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

  it('an empty Continue shows each missing field under it and sends nothing', async () => {
    await renderForm(vi.fn());
    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(screen.getByText('Guardian Name is required.')).toBeInTheDocument();
    expect(screen.getByText("Enter your guardian's email or phone number.")).toBeInTheDocument();
    const name = screen.getByLabelText(/guardian name/i);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-describedby', 'u18-guardian-name-error');
    expect(submitGuardian).not.toHaveBeenCalled();

    await userEvent.type(name, 'Asha Guardian');
    expect(screen.queryByText('Guardian Name is required.')).toBeNull();
  });

  it('a partial phone shows "Invalid entry" once the field is left', async () => {
    await renderForm(vi.fn());
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '98765');
    expect(screen.queryByText(/Invalid entry/)).toBeNull();
    await userEvent.tab();
    expect(
      screen.getByText('Invalid entry. Please enter a valid Guardian Phone Number.'),
    ).toBeInTheDocument();
  });

  it('puts a server field rejection under that field', async () => {
    submitGuardian.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { message: 'body/guardianEmail Invalid email' } },
    });
    await renderForm(vi.fn());
    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    await userEvent.type(screen.getByLabelText(/guardian email/i), 'a@b');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(
      await screen.findByText('Invalid entry. Please enter a valid Guardian Email.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/body\/guardianEmail/)).toBeNull();
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

    // No acknowledgement path — a click sends nothing.
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
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

    // Resubmitting the same contact is refused without another request.
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(submitGuardian).toHaveBeenCalledTimes(1);
  });
});
