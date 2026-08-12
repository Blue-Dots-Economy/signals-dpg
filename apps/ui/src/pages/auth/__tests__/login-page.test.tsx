import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pickBirthYear } from '@/test/pick-dob';

const CURRENT_YEAR = new Date().getFullYear();

const checkUser = vi.fn();
const requestOtp = vi.fn();
const fetchAuthConfig = vi.fn();
const fetchNetworkConfig = vi.fn();
const navigateMock = vi.fn();
const getServedScope = vi.fn();

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
vi.mock('@/lib/served-binding', async (orig) => ({
  ...(await orig<typeof import('@/lib/served-binding')>()),
  getServedScope: () => getServedScope(),
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
  SignupGuardianFlow: (props: { domain: string; age: number; onComplete: () => void }) => {
    signupGuardianOnComplete.mockImplementation(props.onComplete);
    return (
      <div
        data-testid="signup-guardian-flow"
        data-domain={props.domain}
        data-age={String(props.age)}
      />
    );
  },
}));

// A gated domain ("seeker") + an ungated one ("provider") for the U18 tests.
const GATED_NETWORK_DOMAINS = [
  { id: 'seeker', description: 'Job seeker', guardian_consent_required: true },
  { id: 'provider', description: 'Job provider' },
];

// A provider whose go-live gates omit `consent_required` (#344): a signup on it
// must skip the terms/privacy pre-check and go straight to OTP.
const CONSENT_FREE_NETWORK_DOMAINS = [
  { id: 'seeker', description: 'Job seeker' },
  { id: 'provider', description: 'Job provider', go_live_required: ['schema_required'] },
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
    // Default: no served-binding scope → combined mode (all domains), matching
    // the pre-existing tests. Individual tests override for a single-domain portal.
    getServedScope.mockReturnValue(null);
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

  it('mobile field takes only the 10-digit national number (+91 is a fixed prefix)', async () => {
    fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
    await renderPage();
    await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

    const input = screen.getByLabelText(/mobile/i) as HTMLInputElement;
    const cta = screen.getByRole('button', { name: /^continue$/i });

    // Fewer than 10 digits → CTA stays disabled.
    await userEvent.type(input, '96204');
    expect(cta).toBeDisabled();

    // Letters + formatting stripped; capped at 10 digits; CTA enables at 10.
    await userEvent.type(input, '21129abc99');
    expect(input.value).toBe('9620421129');
    expect(cta).toBeEnabled();
  });

  describe('signup form: name + domain only (DOB is a separate gated step)', () => {
    it('shows the domain field but NOT a DOB field on the signup form', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      expect(screen.queryByText(/your domain/i)).toBeNull();

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      await waitFor(() => expect(checkUser).toHaveBeenCalled());
      expect(await screen.findByText(/your domain/i)).toBeInTheDocument();
      // DOB is never on the form — it's a separate step for gated domains only.
      expect(screen.queryByRole('button', { name: /date of birth/i })).toBeNull();
    });

    it('never shows domain/name fields when logging in as a returning user', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: true });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9123456789');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      expect(screen.queryByText(/your domain/i)).toBeNull();
      expect(screen.queryByLabelText(/your name/i)).toBeNull();
    });

    it('blocks signup submission until name + domain are filled in (no DOB on the form)', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));
      await screen.findByText(/your domain/i);

      // Name only — the still-empty required domain select blocks submission.
      await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
      expect(requestOtp).not.toHaveBeenCalled();

      // Name + domain (ungated) — submission proceeds straight to OTP, no DOB.
      await userEvent.click(screen.getByRole('button', { name: /^provider$/i }));
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
    });

    it('an ungated domain skips the DOB step entirely and carries no birth data', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_NETWORK_DOMAINS });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Ravi');
      await userEvent.click(screen.getByRole('button', { name: /^provider$/i })); // ungated
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

      // No DOB step shown; goes straight to OTP with a domain-only signupExtras.
      expect(screen.queryByText(/to create an account/i)).toBeNull();
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
        '/auth/otp',
        expect.objectContaining({
          state: expect.objectContaining({ signupExtras: { domain: 'provider' } }),
        }),
      ));
    });

    it('a signup on a consent-free domain skips the terms/privacy pre-check and goes straight to OTP (#344)', async () => {
      const { getConsentStatusByIdentifier } = await import('@/lib/consent-api');
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: CONSENT_FREE_NETWORK_DOMAINS });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Ravi');
      await userEvent.click(screen.getByRole('button', { name: /^provider$/i })); // consent-free
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

      // Straight to OTP — and the consent pre-check (only reached via
      // runConsentThenOtp) is skipped because the domain omits consent_required.
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      expect(vi.mocked(getConsentStatusByIdentifier)).not.toHaveBeenCalled();
    });

    it('a single-served-domain portal hides the picker and auto-carries that domain', async () => {
      // Provider-only (split) portal: VITE_SERVED_BINDINGS scopes to one domain.
      getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['provider'] });
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      // Name field appears, but the one-option "Your Domain" picker does NOT.
      await screen.findByLabelText(/your name/i);
      expect(screen.queryByText(/your domain/i)).toBeNull();

      // No domain click needed — it's auto-selected from the served binding —
      // so name-only submission proceeds to OTP carrying { domain: 'provider' }.
      await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
        '/auth/otp',
        expect.objectContaining({
          state: expect.objectContaining({ signupExtras: { domain: 'provider' } }),
        }),
      ));
    });
  });

  describe('U18 gated DOB step + guardian gate (option A)', () => {
    it('a gated domain shows the DOB step; a minor then sees the guardian flow BEFORE their own OTP', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_NETWORK_DOMAINS });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
      await userEvent.click(screen.getByRole('button', { name: /^seeker$/i })); // gated
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

      // The DOB step appears (gated domain); the OTP is not yet sent.
      expect(await screen.findByText(/to create an account/i)).toBeInTheDocument();
      expect(requestOtp).not.toHaveBeenCalled();

      // Pick a minor birth year + Continue → guardian flow renders, OTP still held.
      await pickBirthYear(2015);
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

      const flow = await screen.findByTestId('signup-guardian-flow');
      expect(flow).toHaveAttribute('data-domain', 'seeker');
      expect(flow).toHaveAttribute('data-age', String(CURRENT_YEAR - 2015));
      expect(requestOtp).not.toHaveBeenCalled();
      expect(navigateMock).not.toHaveBeenCalled();

      // Guardian verified → the ward's OTP is sent + navigation runs, carrying
      // the age and no adult consent (recorded guardian-sourced).
      signupGuardianOnComplete();
      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
        '/auth/otp',
        expect.objectContaining({
          state: expect.objectContaining({
            signupExtras: expect.objectContaining({ domain: 'seeker', age: CURRENT_YEAR - 2015 }),
            pendingConsent: null,
          }),
        }),
      ));
    });

    it('an ADULT in a gated domain clears the DOB step and proceeds to OTP without the guardian flow', async () => {
      fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] });
      checkUser.mockResolvedValue({ userExists: false });
      fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_NETWORK_DOMAINS });
      await renderPage();
      await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

      await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
      await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));
      await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(1));

      await userEvent.type(screen.getByLabelText(/your name/i), 'Ravi');
      await userEvent.click(screen.getByRole('button', { name: /^seeker$/i })); // gated
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

      expect(await screen.findByText(/to create an account/i)).toBeInTheDocument();
      await pickBirthYear(1990); // adult
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

      await waitFor(() => expect(requestOtp).toHaveBeenCalled());
      expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
        '/auth/otp',
        expect.objectContaining({
          state: expect.objectContaining({
            signupExtras: expect.objectContaining({ domain: 'seeker', age: CURRENT_YEAR - 1990 }),
          }),
        }),
      ));
    });
  });
});
