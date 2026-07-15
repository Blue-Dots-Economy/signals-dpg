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

async function fillBaseFields() {
  await userEvent.type(screen.getByLabelText(/guardian's name/i), 'Asha Guardian');
  await userEvent.click(screen.getByRole('radio', { name: /phone/i }));
  await userEvent.type(
    screen.getByLabelText(/guardian's phone number/i),
    '+911234567890',
  );
}

describe('GuardianFormStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps submit disabled until the guardian declaration checkbox is checked', async () => {
    await renderForm(vi.fn());
    await fillBaseFields();

    const submit = screen.getByRole('button', { name: /send guardian confirmation/i });
    expect(submit).toBeDisabled();

    await userEvent.click(
      screen.getByLabelText(/i declare that the details above belong to my parent or guardian/i),
    );
    expect(submit).toBeEnabled();
  });

  it('submits guardian details and calls onSubmitted when otpSent is true', async () => {
    submitGuardian.mockResolvedValue({ otpSent: true });
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);
    await fillBaseFields();
    await userEvent.click(
      screen.getByLabelText(/i declare that the details above belong to my parent or guardian/i),
    );
    await userEvent.click(screen.getByRole('button', { name: /send guardian confirmation/i }));

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

  it('highlights the contact field and blocks submit until same-contact is acknowledged, when the guardian contact equals the ward\'s own phone', async () => {
    const onSubmitted = vi.fn();
    await renderForm(onSubmitted);

    await userEvent.type(screen.getByLabelText(/guardian's name/i), 'Asha Guardian');
    await userEvent.click(screen.getByRole('radio', { name: /phone/i }));
    // Same as the ward's own phone (mocked in auth-context above).
    await userEvent.type(screen.getByLabelText(/guardian's phone number/i), '+919000000000');

    expect(
      screen.getByText(/same as your own contact — are you okay with that\?/i),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByLabelText(/i declare that the details above belong to my parent or guardian/i),
    );
    const submit = screen.getByRole('button', { name: /send guardian confirmation/i });
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
    await fillBaseFields();
    await userEvent.click(
      screen.getByLabelText(/i declare that the details above belong to my parent or guardian/i),
    );
    await userEvent.click(screen.getByRole('button', { name: /send guardian confirmation/i }));

    await waitFor(() =>
      expect(
        screen.getAllByText(/same as your own contact — are you okay with that\?/i).length,
      ).toBeGreaterThan(0),
    );
    expect(onSubmitted).not.toHaveBeenCalled();

    // The submit stays blocked until the newly-surfaced ack box is checked.
    const submit = screen.getByRole('button', { name: /send guardian confirmation/i });
    expect(submit).toBeDisabled();
  });
});
