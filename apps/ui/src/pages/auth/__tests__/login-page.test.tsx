import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pickDob } from '@/test/pick-dob';

const checkUser = vi.fn();
const requestOtp = vi.fn();
const fetchAuthConfig = vi.fn();
const fetchNetworkConfig = vi.fn();
const navigateMock = vi.fn();

const NETWORK_DOMAINS = [
  { id: 'seeker', description: 'Job seeker' },
  { id: 'provider', description: 'Job provider' },
];

vi.mock('@/lib/auth-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-api')>()),
  checkUser: (...a: unknown[]) => checkUser(...a),
  requestOtp: (...a: unknown[]) => requestOtp(...a),
  fetchAuthConfig: () => fetchAuthConfig(),
}));
vi.mock('@/theme/theme-provider', async () => {
  const { resolveTheme } = await import('@/theme/network-themes');
  return {
    useNetworkTheme: () => ({ themeId: 'blue_dot', theme: resolveTheme('blue_dot'), brand: 'standard' }),
  };
});
vi.mock('@/lib/consent-api', () => ({
  fetchConsentConfigs: vi.fn().mockResolvedValue([]),
  getConsentStatusByIdentifier: vi.fn().mockResolvedValue({ statuses: { terms: [], privacy: [] } }),
}));
vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfig: (...a: unknown[]) => fetchNetworkConfig(...a),
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));
// Stub the pre-auth guardian flow so we can assert LoginPage's gating wiring
// (does it render the flow, with which props, and does it hold back the OTP?)
// without pulling in the child's internals — those have their own tests.
const signupGuardianOnComplete = vi.fn();
vi.mock('@/components/consent/u18/signup-guardian-flow', () => ({
  SignupGuardianFlow: (props: { domain: string; birthYear: number; onComplete: () => void }) => {
    signupGuardianOnComplete.mockImplementation(props.onComplete);
    return (
      <div
        data-testid="signup-guardian-flow"
        data-domain={props.domain}
        data-birth-year={props.birthYear}
      />
    );
  },
}));

// A gated domain ("seeker") + an ungated one ("provider") for the U18 tests.
const GATED_NETWORK_DOMAINS = [
  { id: 'seeker', description: 'Job seeker', guardian_consent_required: true },
  { id: 'provider', description: 'Job provider' },
];

async function renderPage() {
  const { LoginPage } = await import('../login-page');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestOtp.mockResolvedValue({ ok: true, user: false });
    fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: NETWORK_DOMAINS });
  });

  it('renders only the phone input when loginChannels is ["phone"]', async () => {
    fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone'] });
    await renderPage();
    await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());
    // With a single channel, the whole pill toggle is hidden — neither button renders.
    expect(screen.queryByRole('button', { name: /^email$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^phone$/i })).toBeNull();
  });

  it('blocks an unknown identifier when self-signup is gated (no OTP requested)', async () => {
    fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: false, loginChannels: ['phone', 'email'] });
    checkUser.mockResolvedValue({ userExists: false });
    await renderPage();
    await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

    await waitFor(() => expect(checkUser).toHaveBeenCalled());
    expect(requestOtp).not.toHaveBeenCalled();
    // The "contact your administrator" copy is produced only by the signup-gate branch (inline
    // signup_disabled_message + toast_signup_disabled_desc) — asserting on it (rather
    // than just requestOtp not being called) distinguishes the gate from the
    // separate name-required guard, which also skips requestOtp but never renders
    // this message.
    expect(await screen.findAllByText(/contact your administrator/i)).not.toHaveLength(0);
  });

  it('clears the stale signup-blocked state once a fresh submission resolves to an existing user', async () => {
    // Regression test: signupBlocked must be re-evaluated on every submission,
    // not just on mode toggle. Submitting an unknown identifier first gates
    // the form; editing the field (without touching the phone/email toggle)
    // to an identifier that DOES exist and resubmitting must drop the gated
    // copy and proceed to the OTP flow.
    fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: false, loginChannels: ['phone', 'email'] });
    checkUser.mockResolvedValueOnce({ userExists: false });
    await renderPage();
    await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

    const input = screen.getByLabelText(/mobile/i);
    await userEvent.type(input, '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

    await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText(/contact your administrator/i)).not.toHaveLength(0);

    checkUser.mockResolvedValueOnce({ userExists: true });
    await userEvent.clear(input);
    await userEvent.type(input, '9123456789');
    await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

    await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(requestOtp).toHaveBeenCalled());
    expect(screen.queryByText(/contact your administrator/i)).toBeNull();
  });

  describe('signup domain + DOB capture', () => {
    it('shows domain + DOB fields for a brand-new signup', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      // Not shown before any identifier is checked.
      expect(screen.queryByLabelText(/your domain/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /date of birth/i })).toBeNull();

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      await waitFor(() => expect(checkUser).toHaveBeenCalled());
      expect(await screen.findByLabelText(/your domain/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /date of birth/i })).toBeInTheDocument();
    });

    it('never shows domain + DOB fields when logging in as a returning user', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: true });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9123456789');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      expect(screen.queryByLabelText(/your domain/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /date of birth/i })).toBeNull();
      expect(screen.queryByLabelText(/your name/i)).toBeNull();
    });

    it('blocks signup submission until domain and DOB are filled in, alongside the name', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));
      await screen.findByLabelText(/your domain/i);

      // Name only — domain + DOB (still-empty required selects) block even
      // an in-browser submit attempt; requestOtp is never reached.
      await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      expect(requestOtp).not.toHaveBeenCalled();

      // Fill everything — submission proceeds.
      await userEvent.selectOptions(screen.getByLabelText(/your domain/i), 'seeker');
      await pickDob(/date of birth/i, 2010, 5);
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
    });

    it('maps the selected DOB month/year onto the OTP-step navigation state as numbers', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
      await userEvent.selectOptions(screen.getByLabelText(/your domain/i), 'provider');
      await pickDob(/date of birth/i, 2010, 5);
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
        '/auth/otp',
        expect.objectContaining({
          state: expect.objectContaining({
            signupExtras: { domain: 'provider', birthMonth: 5, birthYear: 2010 },
          }),
        }),
      ));
    });
  });

  describe('U18 pre-auth guardian gate (option A)', () => {
    it('a minor signing up in a guardian-gated domain sees the guardian flow BEFORE their own OTP', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_NETWORK_DOMAINS });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
      await userEvent.selectOptions(screen.getByLabelText(/your domain/i), 'seeker');
      await pickDob(/date of birth/i, 2015, 5); // minor
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      // Guardian flow renders; the ward's OTP is held back.
      const flow = await screen.findByTestId('signup-guardian-flow');
      expect(flow).toHaveAttribute('data-domain', 'seeker');
      expect(flow).toHaveAttribute('data-birth-year', '2015');
      expect(requestOtp).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();

      // Once the guardian is verified, the ward's OTP is sent + navigation runs.
      signupGuardianOnComplete();
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
        '/auth/otp',
        expect.objectContaining({
          state: expect.objectContaining({
            signupExtras: { domain: 'seeker', birthMonth: 5, birthYear: 2015 },
            pendingConsent: null,
          }),
        }),
      ));
    });

    it('an ADULT in a guardian-gated domain skips the guardian flow and proceeds to OTP', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_NETWORK_DOMAINS });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Ravi');
      await userEvent.selectOptions(screen.getByLabelText(/your domain/i), 'seeker');
      await pickDob(/date of birth/i, 1990, 5); // adult
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
    });
  });
});
