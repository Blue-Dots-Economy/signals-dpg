import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { pickBirthYear } from '@/test/pick-dob';

const submitU18Dob = vi.fn();
const submitGuardian = vi.fn();
const verifyGuardian = vi.fn();
vi.mock('@/lib/consent-api', () => ({
  submitU18Dob: (...args: unknown[]) => submitU18Dob(...args),
  submitGuardian: (...args: unknown[]) => submitGuardian(...args),
  verifyGuardian: (...args: unknown[]) => verifyGuardian(...args),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { email: 'ward@example.com', phoneNumber: '+919000000000' },
  }),
}));

// GuardianFormStep opens its T&C / Privacy text via this hook; the flow test
// never opens it, so a null config is enough (avoids needing a QueryClient).
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
}));

function typeOtp(digits: string) {
  const inputs = screen.getAllByRole('textbox');
  digits.split('').forEach((d, i) => {
    fireEvent.change(inputs[i], { target: { value: d } });
  });
}

async function renderFlow(onComplete: () => void, onNotMinor: () => void) {
  const { U18GuardianFlow } = await import('../u18-guardian-flow');
  render(
    <>
      <Toaster />
      <U18GuardianFlow
        network="blue_dot"
        brand="standard"
        onComplete={onComplete}
        onNotMinor={onNotMinor}
      />
    </>,
  );
}

describe('U18GuardianFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('walks DOB → guardian → OTP through to onComplete for a minor', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: true });
    submitGuardian.mockResolvedValue({ otpSent: true });
    verifyGuardian.mockResolvedValue({ verified: true });
    const onComplete = vi.fn();
    const onNotMinor = vi.fn();
    await renderFlow(onComplete, onNotMinor);

    // Step 1: DOB
    await pickBirthYear(2012);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2: guardian details (name + a contact + both consents)
    await waitFor(() => expect(screen.getByLabelText(/guardian name/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3: OTP
    await waitFor(() => expect(screen.getAllByRole('textbox').length).toBe(6));
    typeOtp('123456');

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onNotMinor).not.toHaveBeenCalled();
  });

  it('calls onNotMinor and skips the guardian steps when the DOB step resolves an adult', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: false });
    const onComplete = vi.fn();
    const onNotMinor = vi.fn();
    await renderFlow(onComplete, onNotMinor);

    await pickBirthYear(1990);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(onNotMinor).toHaveBeenCalled());
    expect(screen.queryByLabelText(/guardian's name/i)).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
