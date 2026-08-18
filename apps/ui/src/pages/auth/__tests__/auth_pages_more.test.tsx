import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { pickBirthYear } from '@/test/pick-dob';
import type { ConsentConfigDocument } from '@dpg/schemas';

// Batch 2 companion to login-page.test.tsx / otp-page.test.tsx. Everything
// here targets branches those files do NOT reach: the server-driven channel
// gating, the self-signup / domain / consent copy, the existing-user birth-year
// pre-check, the OTP resend + wrong-code paths, and the raw OtpInput
// paste/backspace/arrow-key behaviour.

// vi.hoisted keeps every mock handle (and the mutable router state) defined
// BEFORE the hoisted vi.mock factories run, so no factory can touch an
// uninitialised binding.
const mocks = vi.hoisted(() => ({
  // auth-api
  checkUser: vi.fn(),
  requestOtp: vi.fn(),
  fetchAuthConfig: vi.fn(),
  u18Precheck: vi.fn(),
  // network-api / served-binding
  fetchNetworkConfig: vi.fn(),
  getServedScope: vi.fn(),
  // consent-api
  fetchConsentConfigs: vi.fn(),
  getConsentStatusByIdentifier: vi.fn(),
  acceptConsent: vi.fn(),
  submitU18Dob: vi.fn(),
  getU18Status: vi.fn(),
  // auth context / otp page collaborators
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  resolveHeldDomains: vi.fn(),
  setUserDomains: vi.fn(),
  fetchMyProfilesLite: vi.fn(),
  // router
  navigate: vi.fn(),
  locationState: null as Record<string, unknown> | null,
  // resend countdown (the real hook ticks on a 1s interval; drive it directly
  // so the resend button can be exercised without fake timers)
  countdown: 60,
  restartCountdown: vi.fn(),
}));

vi.mock('@/lib/auth-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-api')>()),
  checkUser: (...a: unknown[]) => mocks.checkUser(...a),
  requestOtp: (...a: unknown[]) => mocks.requestOtp(...a),
  fetchAuthConfig: () => mocks.fetchAuthConfig(),
  u18Precheck: (...a: unknown[]) => mocks.u18Precheck(...a),
}));
vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfig: (...a: unknown[]) => mocks.fetchNetworkConfig(...a),
}));
vi.mock('@/lib/served-binding', async (orig) => ({
  ...(await orig<typeof import('@/lib/served-binding')>()),
  getServedScope: () => mocks.getServedScope(),
}));
vi.mock('@/lib/consent-api', () => ({
  fetchConsentConfigs: (...a: unknown[]) => mocks.fetchConsentConfigs(...a),
  getConsentStatusByIdentifier: (...a: unknown[]) => mocks.getConsentStatusByIdentifier(...a),
  acceptConsent: (...a: unknown[]) => mocks.acceptConsent(...a),
  submitU18Dob: (...a: unknown[]) => mocks.submitU18Dob(...a),
  getU18Status: (...a: unknown[]) => mocks.getU18Status(...a),
}));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ verifyOtp: mocks.verifyOtp, signOut: mocks.signOut }),
}));
// evaluateDomainGate stays real (pure); only the network probe is stubbed.
vi.mock('@/lib/domain-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/domain-gate')>()),
  resolveHeldDomains: (...a: unknown[]) => mocks.resolveHeldDomains(...a),
}));
vi.mock('@/lib/user-api', () => ({
  setUserDomains: (...a: unknown[]) => mocks.setUserDomains(...a),
}));
vi.mock('@/lib/login-profiles', () => ({
  fetchMyProfilesLite: (...a: unknown[]) => mocks.fetchMyProfilesLite(...a),
}));
vi.mock('@/hooks/use-resend-countdown', () => ({
  useResendCountdown: () => ({
    countdown: mocks.countdown,
    restart: mocks.restartCountdown,
  }),
}));
vi.mock('@/theme/theme-provider', async () => {
  const { resolveTheme } = await import('@/theme/network-themes');
  return {
    useNetworkTheme: () => ({
      themeId: 'blue_dot',
      theme: resolveTheme('blue_dot'),
      brand: 'standard',
    }),
  };
});
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ state: mocks.locationState }),
}));
// Test doubles for the two heavy child flows: assert the PAGE's wiring (is the
// gate rendered? does it hold back the OTP? what do the callbacks do?) without
// dragging in Radix/dialog internals that have their own suites.
vi.mock('@/components/consent/consent-modal', () => ({
  ConsentModal: (p: { onAccept?: () => void }) => (
    <div data-testid="consent-gate">
      <button type="button" onClick={() => p.onAccept?.()}>
        accept-consent
      </button>
    </div>
  ),
}));
vi.mock('@/components/consent/u18/signup-guardian-flow', () => ({
  SignupGuardianFlow: (p: { onBack: () => void }) => (
    <div data-testid="signup-guardian-flow">
      <button type="button" onClick={p.onBack}>
        guardian-back
      </button>
    </div>
  ),
}));
vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (p: { initialStep?: string; onLogout: () => void }) => (
    <div data-testid="u18-guardian-flow" data-step={p.initialStep}>
      <button type="button" onClick={p.onLogout}>
        guardian-logout
      </button>
    </div>
  ),
}));

const CURRENT_YEAR = new Date().getFullYear();

const UNGATED_DOMAINS = [
  { id: 'seeker', description: 'Job seeker' },
  { id: 'provider', description: 'Job provider' },
];

const GATED_DOMAINS = [
  { id: 'seeker', description: 'Job seeker', guardian_consent_required: true },
  { id: 'provider', description: 'Job provider' },
];

function contentDoc(currentVersion: number) {
  return {
    current_version: currentVersion,
    versions: [
      {
        version: currentVersion,
        title: `Doc v${currentVersion}`,
        content: 'Body copy',
        effective_from: '2026-01-01',
      },
    ],
  };
}

const CONSENT_CONFIG: ConsentConfigDocument = {
  documents: {
    terms: contentDoc(2),
    privacy: contentDoc(1),
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I agree', effective_from: '2026-01-01' }],
    },
  },
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Toaster />
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function renderLogin() {
  const { LoginPage } = await import('../login-page');
  renderWithProviders(<LoginPage />);
  await waitFor(() => expect(mocks.fetchAuthConfig).toHaveBeenCalled());
  // The LoginPage wrapper resolves the instance's auth provider before either
  // login screen mounts (keycloak split), showing a spinner meanwhile. Wait
  // for the OTP identifier step to actually be on screen; the generous timeout
  // covers the hook's one retry (~1s backoff) when a test rejects the config.
  await screen.findByRole('button', { name: /^continue$/i }, { timeout: 5000 });
}

async function renderOtp() {
  const { OtpPage } = await import('../otp-page');
  renderWithProviders(<OtpPage />);
}

/** Submit a full code through the REAL OtpInput (one paste fills all six). */
function submitOtpCode(code = '123456') {
  const boxes = screen.getAllByRole('textbox');
  fireEvent.paste(boxes[0], { clipboardData: { getData: () => code } });
}

const cta = () => screen.getByRole('button', { name: /^continue$/i });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locationState = null;
  mocks.countdown = 60;
  mocks.getServedScope.mockReturnValue(null);
  // Default auth config: null (not undefined — React Query rejects undefined
  // data) so useAuthConfig falls back to gated + both channels, matching the
  // old direct-fetch fail-safe. Tests that care override with a real value.
  mocks.fetchAuthConfig.mockResolvedValue(null);
  mocks.requestOtp.mockResolvedValue({ ok: true, user: false });
  mocks.fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: UNGATED_DOMAINS });
  // Default: consent config exists and both current versions are already
  // accepted, so the T&C gate stays out of the way unless a test opts in.
  mocks.fetchConsentConfigs.mockResolvedValue([{ brand: null, schema: CONSENT_CONFIG }]);
  mocks.getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [2], privacy: [1] } });
  mocks.u18Precheck.mockResolvedValue({ requiresDob: false });
  mocks.verifyOtp.mockResolvedValue(undefined);
  mocks.resolveHeldDomains.mockResolvedValue([]);
  mocks.acceptConsent.mockResolvedValue(undefined);
  mocks.submitU18Dob.mockResolvedValue(undefined);
  mocks.setUserDomains.mockResolvedValue(undefined);
  mocks.fetchMyProfilesLite.mockResolvedValue([
    { item_id: 'p1', item_domain: 'seeker', lifecycle_status: 'live' },
  ]);
});

describe('OtpInput — paste, backspace and arrow keys', () => {
  it('advances focus digit by digit and reports the code once the last box is filled', async () => {
    const onComplete = vi.fn();
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={onComplete} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(6);

    for (const [i, digit] of [...'135790'].entries()) {
      await userEvent.type(boxes[i], digit);
      if (i < 5) expect(boxes[i + 1]).toHaveFocus();
      // Not complete until the final box is filled.
      if (i < 5) expect(onComplete).not.toHaveBeenCalled();
    }

    expect(boxes.map((b) => b.value).join('')).toBe('135790');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('135790');
  });

  it('ignores a non-digit keystroke: the box stays empty and focus does not advance', async () => {
    const onComplete = vi.fn();
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={onComplete} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    await userEvent.type(boxes[0], 'a');
    expect(boxes[0].value).toBe('');
    expect(boxes[0]).toHaveFocus();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('keeps only the LAST character when a box receives more than one', async () => {
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={vi.fn()} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    fireEvent.change(boxes[0], { target: { value: '89' } });
    expect(boxes[0].value).toBe('9');
  });

  it('pasting a full code fills every box, reports it, and parks focus on the last box', async () => {
    const onComplete = vi.fn();
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={onComplete} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    fireEvent.paste(boxes[0], { clipboardData: { getData: () => '246813' } });

    expect(boxes.map((b) => b.value).join('')).toBe('246813');
    expect(onComplete).toHaveBeenCalledWith('246813');
    expect(boxes[5]).toHaveFocus();
  });

  it('pasting a PARTIAL code fills the prefix, focuses the first empty box, and does not report', async () => {
    const onComplete = vi.fn();
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={onComplete} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    fireEvent.paste(boxes[0], { clipboardData: { getData: () => '123' } });

    expect(boxes.map((b) => b.value)).toEqual(['1', '2', '3', '', '', '']);
    expect(boxes[3]).toHaveFocus();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('strips separators and truncates an over-long pasted code to six digits', async () => {
    const onComplete = vi.fn();
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={onComplete} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    fireEvent.paste(boxes[0], { clipboardData: { getData: () => 'code: 12-34 5678' } });

    expect(boxes.map((b) => b.value).join('')).toBe('123456');
    expect(onComplete).toHaveBeenCalledWith('123456');
  });

  it('a paste with no digits at all leaves every box untouched', async () => {
    const onComplete = vi.fn();
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={onComplete} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    fireEvent.paste(boxes[0], { clipboardData: { getData: () => 'no digits here' } });

    expect(boxes.every((b) => b.value === '')).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('backspace in an EMPTY box steps focus back without clearing the previous digit', async () => {
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={vi.fn()} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    await userEvent.type(boxes[0], '7');
    expect(boxes[1]).toHaveFocus();

    await userEvent.keyboard('{Backspace}');
    expect(boxes[0]).toHaveFocus();
    // The earlier digit survives — backspace on an empty box only navigates.
    expect(boxes[0].value).toBe('7');
  });

  it('backspace in a FILLED box clears that box and keeps focus there', async () => {
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={vi.fn()} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    await userEvent.type(boxes[0], '7');
    boxes[0].focus();
    await userEvent.keyboard('{Backspace}');

    expect(boxes[0].value).toBe('');
    expect(boxes[0]).toHaveFocus();
  });

  it('backspace on the FIRST box does not wrap focus anywhere', async () => {
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={vi.fn()} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    boxes[0].focus();
    await userEvent.keyboard('{Backspace}');
    expect(boxes[0]).toHaveFocus();
  });

  it('arrow keys are NOT wired to box navigation — only backspace moves focus', async () => {
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={vi.fn()} />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];

    boxes[2].focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowRight}{ArrowUp}{ArrowDown}');

    // Documented behaviour: the component's keydown handler only special-cases
    // Backspace, so arrows leave focus (and the digits) exactly where they were.
    expect(boxes[2]).toHaveFocus();
    expect(boxes.every((b) => b.value === '')).toBe(true);
  });

  it('disabled blocks every box', async () => {
    const { OtpInput } = await import('@/components/auth/otp-input');
    render(<OtpInput onComplete={vi.fn()} disabled />);
    const boxes = screen.getAllByRole('textbox');
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box).toBeDisabled();
    }
  });
});

describe('LoginPage — login channels come from GET /api/v1/auth/config', () => {
  it('email-only: renders the email field with email-only copy and no channel toggle', async () => {
    mocks.fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['email'] });
    await renderLogin();

    // The page defaults to phone mode, then corrects itself to the only
    // allowed channel once the server config lands.
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByLabelText(/mobile number/i)).toBeNull();
    expect(screen.getByText(/continue with your email to receive a verification code/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^email$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^phone$/i })).toBeNull();
  });

  it('phone-only: renders phone-only sub-copy', async () => {
    mocks.fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone'] });
    await renderLogin();

    expect(
      await screen.findByText(/continue with your mobile number to receive a verification code/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
  });

  it('both channels: shows the toggle, the combined copy, and swaps the field on switch', async () => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
    await renderLogin();

    expect(screen.getByText(/continue with email or mobile to receive a verification code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^phone$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByLabelText(/mobile number/i)).toBeNull();
  });

  it('switching channel clears a stale signup-gated state', async () => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: false,
      loginChannels: ['phone', 'email'],
    });
    mocks.checkUser.mockResolvedValue({ userExists: false });
    await renderLogin();

    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());
    expect(await screen.findByText(/user doesn't exist\. please contact your administrator/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));

    expect(screen.queryByText(/user doesn't exist\. please contact your administrator/i)).toBeNull();
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('when the auth-config request fails, both channels are offered and signup is treated as gated', async () => {
    mocks.fetchAuthConfig.mockRejectedValue(new Error('config down'));
    mocks.checkUser.mockResolvedValue({ userExists: false });
    await renderLogin();

    // Fail-safe default: the toggle is present (both channels)...
    expect(await screen.findByRole('button', { name: /^email$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^phone$/i })).toBeInTheDocument();

    // ...and an unknown identifier is blocked rather than silently signed up.
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());

    expect(await screen.findByText(/user doesn't exist\. please contact your administrator/i)).toBeInTheDocument();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
  });
});

describe('LoginPage — client-side identifier validation', () => {
  beforeEach(() => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
  });

  it('rejects a malformed email before any network call', async () => {
    await renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));
    await userEvent.type(screen.getByLabelText('Email'), 'asha@nope');
    await userEvent.click(cta());

    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
    expect(mocks.checkUser).not.toHaveBeenCalled();
  });

  it('rejects a 10-digit number that is not a valid Indian mobile prefix', async () => {
    await renderLogin();
    await userEvent.type(screen.getByLabelText(/mobile number/i), '1234567890');
    // Ten digits, so the CTA is enabled — validation happens on submit.
    expect(cta()).toBeEnabled();
    await userEvent.click(cta());

    expect(
      await screen.findByText(/enter a valid 10-digit mobile number \(starting with 6, 7, 8, or 9\)/i),
    ).toBeInTheDocument();
    expect(mocks.checkUser).not.toHaveBeenCalled();
  });
});

describe('LoginPage — signup step copy', () => {
  beforeEach(() => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
    mocks.checkUser.mockResolvedValue({ userExists: false });
  });

  it('names the channel in the "account not found" prompt and switches to create-account copy', async () => {
    await renderLogin();
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());

    expect(
      await screen.findByText(/no account exists with this phone number\. fill in the details below/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /create your account/i })).toBeInTheDocument();
    expect(screen.getByText(/enter your phone number and name to get started/i)).toBeInTheDocument();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
  });

  it('surfaces a config error (not "select your domain") when no domain options loaded', async () => {
    mocks.fetchNetworkConfig.mockRejectedValue(new Error('schema registry down'));
    await renderLogin();

    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());
    await userEvent.type(await screen.findByLabelText(/your name/i), 'Asha');
    await userEvent.click(cta());

    expect(await screen.findByText(/could not load sign-up options/i)).toBeInTheDocument();
    expect(screen.queryByText(/please select your domain to continue/i)).toBeNull();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
  });

  it('asks for the domain specifically when the multi-domain picker is shown but unset', async () => {
    await renderLogin();

    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());
    await userEvent.type(await screen.findByLabelText(/your name/i), 'Asha');
    await userEvent.click(cta());

    expect(await screen.findByText(/please select your domain to continue/i)).toBeInTheDocument();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
  });
});

describe('LoginPage — terms/privacy gate before the OTP', () => {
  beforeEach(() => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
    mocks.checkUser.mockResolvedValue({ userExists: true });
  });

  async function submitReturningUser() {
    await renderLogin();
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());
  }

  it('holds the OTP behind the consent gate, then sends it (with the pending consent) on accept', async () => {
    mocks.getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [], privacy: [] } });
    await submitReturningUser();

    expect(await screen.findByTestId('consent-gate')).toBeInTheDocument();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
    // Now that the user is known to exist the CTA promises the code directly.
    expect(screen.getByRole('button', { name: /send otp/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
    expect(screen.getByText(/enter your phone number to sign in/i)).toBeInTheDocument();
    // Phone is normalized to E.164 for the status lookup, or a returning user
    // would be re-prompted on every login.
    expect(mocks.getConsentStatusByIdentifier).toHaveBeenCalledWith({
      network: 'blue_dot',
      phone: '+919876543210',
    });

    await userEvent.click(screen.getByRole('button', { name: 'accept-consent' }));

    await waitFor(() => expect(mocks.requestOtp).toHaveBeenCalledWith({ phoneNumber: '+919876543210' }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/auth/otp',
      expect.objectContaining({
        state: expect.objectContaining({
          userExists: true,
          pendingConsent: {
            network: 'blue_dot',
            brand: null,
            source: 'login',
            items: [
              { category: 'terms', version: 2 },
              { category: 'privacy', version: 1 },
            ],
          },
        }),
      }),
    );
  });

  it('only gates the documents whose current version is missing', async () => {
    mocks.getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [2], privacy: [] } });
    await submitReturningUser();

    await screen.findByTestId('consent-gate');
    await userEvent.click(screen.getByRole('button', { name: 'accept-consent' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/auth/otp',
      expect.objectContaining({
        state: expect.objectContaining({
          pendingConsent: expect.objectContaining({
            items: [{ category: 'privacy', version: 1 }],
          }),
        }),
      }),
    );
  });

  it('skips the gate entirely when both current versions are already accepted', async () => {
    await submitReturningUser();

    await waitFor(() => expect(mocks.requestOtp).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-gate')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/auth/otp',
      expect.objectContaining({ state: expect.objectContaining({ pendingConsent: null }) }),
    );
  });

  it('fails open when the consent pre-check errors — the OTP still goes out, ungated', async () => {
    mocks.getConsentStatusByIdentifier.mockRejectedValue(new Error('consent service down'));
    await submitReturningUser();

    await waitFor(() => expect(mocks.requestOtp).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-gate')).toBeNull();
  });

  it('surfaces a send failure instead of navigating to the OTP screen', async () => {
    mocks.requestOtp.mockRejectedValue(new Error('sms gateway down'));
    await submitReturningUser();

    expect(await screen.findByText(/couldn't send verification code/i)).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalledWith('/auth/otp', expect.anything());
  });
});

describe('LoginPage — existing user missing a birth year (u18 pre-check)', () => {
  beforeEach(() => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
    mocks.checkUser.mockResolvedValue({ userExists: true });
    mocks.fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_DOMAINS });
  });

  async function submitAndReachDobStep() {
    await renderLogin();
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());
    expect(await screen.findByText(/please confirm your birth year/i)).toBeInTheDocument();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
  }

  it('shows the confirm-birth-year step (not the signup wording) and holds the OTP', async () => {
    mocks.u18Precheck.mockResolvedValue({ requiresDob: true });
    await submitAndReachDobStep();

    expect(mocks.u18Precheck).toHaveBeenCalledWith('blue_dot', { phoneNumber: '+919876543210' });
    // The signup variant of the copy must NOT be used for an existing user.
    expect(screen.queryByText(/to create an account, please provide/i)).toBeNull();
    // The login form is replaced by the step.
    expect(screen.queryByLabelText(/mobile number/i)).toBeNull();
  });

  it('an existing MINOR is told to verify first, then guardian — and gets the OTP with their age', async () => {
    mocks.u18Precheck.mockResolvedValue({ requiresDob: true });
    await submitAndReachDobStep();

    await pickBirthYear(2015);
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(
      await screen.findByText(/first verify your number, then a guardian will confirm your account/i),
    ).toBeInTheDocument();
    // The pre-auth guardian flow is for NEW signups only.
    expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
    await waitFor(() => expect(mocks.requestOtp).toHaveBeenCalled());
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/auth/otp',
      expect.objectContaining({
        state: expect.objectContaining({
          userExists: true,
          // No domain for an existing user — only the age is carried forward.
          signupExtras: { domain: '', age: CURRENT_YEAR - 2015 },
          pendingConsent: null,
        }),
      }),
    );
  });

  it('an existing ADULT clears the step and continues through the ordinary consent path', async () => {
    mocks.u18Precheck.mockResolvedValue({ requiresDob: true });
    mocks.getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [], privacy: [] } });
    await submitAndReachDobStep();

    await pickBirthYear(1985);
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // Adults get the terms gate; minors never do.
    expect(await screen.findByTestId('consent-gate')).toBeInTheDocument();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'accept-consent' }));

    await waitFor(() => expect(mocks.requestOtp).toHaveBeenCalled());
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/auth/otp',
      expect.objectContaining({
        state: expect.objectContaining({ signupExtras: { domain: '', age: CURRENT_YEAR - 1985 } }),
      }),
    );
  });

  it('fails open when the pre-check errors: no birth-year step, straight to the OTP', async () => {
    mocks.u18Precheck.mockRejectedValue(new Error('precheck down'));
    await renderLogin();

    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());

    await waitFor(() => expect(mocks.requestOtp).toHaveBeenCalled());
    expect(screen.queryByText(/please confirm your birth year/i)).toBeNull();
  });
});

describe('LoginPage — guardian step back navigation and wrong-portal notice', () => {
  it('Back on the pre-auth guardian flow returns to the birth-year step with the OTP still unsent', async () => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
    mocks.checkUser.mockResolvedValue({ userExists: false });
    mocks.fetchNetworkConfig.mockResolvedValue({ id: 'blue_dot', domains: GATED_DOMAINS });
    await renderLogin();

    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(cta());
    await userEvent.type(await screen.findByLabelText(/your name/i), 'Asha');
    await userEvent.click(screen.getByRole('button', { name: /^seeker$/i }));
    await userEvent.click(cta());

    expect(await screen.findByText(/to create an account, please provide/i)).toBeInTheDocument();
    await pickBirthYear(2015);
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByTestId('signup-guardian-flow')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'guardian-back' }));

    expect(await screen.findByText(/to create an account, please provide/i)).toBeInTheDocument();
    expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
    expect(mocks.requestOtp).not.toHaveBeenCalled();
  });

  it('explains the wrong-portal bounce and clears the router state so it cannot re-fire', async () => {
    mocks.fetchAuthConfig.mockResolvedValue({
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
    });
    mocks.locationState = { wrongPortalDomain: 'provider' };
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      await renderLogin();

      expect(
        await screen.findByText(
          /this account already has a profile in the provider domain\. please sign in through the provider portal\./i,
        ),
      ).toBeInTheDocument();
      expect(replaceState).toHaveBeenCalledWith({}, '');
      // The login form is still usable underneath the notice.
      expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
    } finally {
      replaceState.mockRestore();
    }
  });
});

describe('OtpPage — resend', () => {
  beforeEach(() => {
    mocks.locationState = { userExists: true, phoneNumber: '+919876543210' };
    mocks.getU18Status.mockResolvedValue({ isMinor: false });
  });

  it('shows the countdown instead of a resend button while the timer is running', async () => {
    mocks.countdown = 42;
    await renderOtp();

    expect(screen.getByText(/resend code in 42s/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resend code$/i })).toBeNull();
  });

  it('re-requests the code, restarts the countdown and confirms it once the timer hits zero', async () => {
    mocks.countdown = 0;
    await renderOtp();

    await userEvent.click(screen.getByRole('button', { name: /^resend code$/i }));

    await waitFor(() =>
      expect(mocks.requestOtp).toHaveBeenCalledWith({ phoneNumber: '+919876543210' }),
    );
    expect(mocks.restartCountdown).toHaveBeenCalled();
    expect(await screen.findByText(/check your messages for the new 6-digit verification code/i)).toBeInTheDocument();
  });

  it('reports a resend failure inline and does not restart the countdown', async () => {
    mocks.countdown = 0;
    mocks.requestOtp.mockRejectedValue(new Error('gateway down'));
    await renderOtp();

    await userEvent.click(screen.getByRole('button', { name: /^resend code$/i }));

    expect(await screen.findByText(/couldn't send a new code/i)).toBeInTheDocument();
    expect(
      screen.getByText(/something went wrong while requesting a new verification code/i),
    ).toBeInTheDocument();
    expect(mocks.restartCountdown).not.toHaveBeenCalled();
  });

  it('a successful resend clears a previous wrong-code error', async () => {
    mocks.countdown = 0;
    mocks.verifyOtp.mockRejectedValue(new Error('bad code'));
    await renderOtp();

    submitOtpCode();
    expect(await screen.findByText(/incorrect verification code/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^resend code$/i }));

    await waitFor(() => expect(screen.queryByText(/incorrect verification code/i)).toBeNull());
  });
});

describe('OtpPage — wrong code', () => {
  beforeEach(() => {
    mocks.locationState = { userExists: true, phoneNumber: '+919876543210' };
    mocks.getU18Status.mockResolvedValue({ isMinor: false });
  });

  it('shows the incorrect-code alert and stays on the page', async () => {
    mocks.verifyOtp.mockRejectedValue(new Error('invalid otp'));
    await renderOtp();

    submitOtpCode('000000');

    expect(await screen.findByText(/incorrect verification code/i)).toBeInTheDocument();
    expect(
      screen.getByText(/the code you entered doesn't match\. double-check your messages/i),
    ).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalledWith('/', { replace: true });
    // The boxes are re-enabled so the user can retry.
    await waitFor(() => expect(screen.getAllByRole('textbox')[0]).toBeEnabled());
  });

  it('passes the entered code and the signup name through to verifyOtp', async () => {
    mocks.locationState = { userExists: false, phoneNumber: '+919876543210', name: 'Asha K' };
    await renderOtp();

    submitOtpCode('135790');

    await waitFor(() =>
      expect(mocks.verifyOtp).toHaveBeenCalledWith({ phoneNumber: '+919876543210' }, '135790', 'Asha K'),
    );
  });

  it('omits the name for a returning user', async () => {
    await renderOtp();

    submitOtpCode('246813');

    await waitFor(() =>
      expect(mocks.verifyOtp).toHaveBeenCalledWith({ phoneNumber: '+919876543210' }, '246813', undefined),
    );
  });
});

describe('OtpPage — missing router state', () => {
  it('bounces back to login and renders nothing when no identifier was carried over', async () => {
    mocks.locationState = null;
    await renderOtp();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/auth/login'));
    expect(screen.queryByText(/enter verification code/i)).toBeNull();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('uses the email as the on-screen identifier when signing in by email', async () => {
    mocks.locationState = { userExists: true, email: 'asha@example.in' };
    mocks.getU18Status.mockResolvedValue({ isMinor: false });
    await renderOtp();

    expect(screen.getByText('asha@example.in')).toBeInTheDocument();
    submitOtpCode();
    await waitFor(() =>
      expect(mocks.verifyOtp).toHaveBeenCalledWith({ email: 'asha@example.in' }, '123456', undefined),
    );
  });
});

describe('OtpPage — per-domain portal gate', () => {
  beforeEach(() => {
    mocks.locationState = { userExists: true, phoneNumber: '+919876543210' };
    mocks.getU18Status.mockResolvedValue({ isMinor: false });
    mocks.getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
  });

  it('signs out and bounces a user who holds a profile in an unserved domain', async () => {
    mocks.resolveHeldDomains.mockResolvedValue(['provider']);
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    expect(mocks.navigate).toHaveBeenCalledWith('/auth/login', {
      replace: true,
      state: { wrongPortalDomain: 'provider' },
    });
    expect(mocks.navigate).not.toHaveBeenCalledWith('/', { replace: true });
    // Bounced before any post-login work.
    expect(mocks.fetchMyProfilesLite).not.toHaveBeenCalled();
    expect(mocks.getU18Status).not.toHaveBeenCalled();
  });

  it('lets a user whose only profile is in a served domain through', async () => {
    mocks.resolveHeldDomains.mockResolvedValue(['seeker']);
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true }));
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

describe('OtpPage — post-verify persistence', () => {
  it('persists the signup domain and the captured age for a brand-new account', async () => {
    const { getStoredSignupDomain } = await import('@/lib/signup-domain');
    mocks.locationState = {
      userExists: false,
      phoneNumber: '+919876543210',
      name: 'Asha',
      signupExtras: { domain: 'seeker', age: 15 },
    };
    mocks.fetchMyProfilesLite.mockResolvedValue([]);
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.setUserDomains).toHaveBeenCalledWith(['seeker']));
    expect(mocks.submitU18Dob).toHaveBeenCalledWith({ network: 'blue_dot', age: 15 });
    expect(getStoredSignupDomain('blue_dot')).toBe('seeker');
    // A new signup already cleared the pre-auth guardian flow.
    expect(mocks.getU18Status).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/profile/new', { replace: true }));
  });

  it('skips the age write when only a domain was captured (ungated signup)', async () => {
    mocks.locationState = {
      userExists: false,
      phoneNumber: '+919876543210',
      name: 'Ravi',
      signupExtras: { domain: 'provider' },
    };
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.setUserDomains).toHaveBeenCalledWith(['provider']));
    expect(mocks.submitU18Dob).not.toHaveBeenCalled();
  });

  it('persists an existing user\'s age without touching their domains', async () => {
    mocks.locationState = {
      userExists: true,
      phoneNumber: '+919876543210',
      signupExtras: { domain: '', age: 16 },
    };
    mocks.getU18Status.mockResolvedValue({ isMinor: true, guardianVerified: false, hasBirthData: true });
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.submitU18Dob).toHaveBeenCalledWith({ network: 'blue_dot', age: 16 }));
    expect(mocks.setUserDomains).not.toHaveBeenCalled();
    // Age now stored → the authenticated guardian step runs before home.
    expect(await screen.findByTestId('u18-guardian-flow')).toHaveAttribute('data-step', 'guardian');
  });

  it('warns but still signs in when the pending consent write fails', async () => {
    mocks.locationState = {
      userExists: true,
      phoneNumber: '+919876543210',
      pendingConsent: { network: 'blue_dot', brand: null, source: 'login', items: [] },
    };
    mocks.getU18Status.mockResolvedValue({ isMinor: false });
    mocks.acceptConsent.mockRejectedValue(new Error('consent write failed'));
    await renderOtp();

    submitOtpCode();

    expect(await screen.findByText(/could not save your consent/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('warns but still signs in when the age write fails', async () => {
    mocks.locationState = {
      userExists: true,
      phoneNumber: '+919876543210',
      signupExtras: { domain: '', age: 20 },
    };
    mocks.getU18Status.mockResolvedValue({ isMinor: false });
    mocks.submitU18Dob.mockRejectedValue(new Error('dob write failed'));
    await renderOtp();

    submitOtpCode();

    expect(await screen.findByText(/could not save your consent/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('still signs in when persisting the signup domain on the user fails', async () => {
    mocks.locationState = {
      userExists: false,
      phoneNumber: '+919876543210',
      name: 'Asha',
      signupExtras: { domain: 'seeker' },
    };
    mocks.setUserDomains.mockRejectedValue(new Error('domain write failed'));
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true }));
  });
});

describe('OtpPage — guardian gate logout', () => {
  it('signs the ward out and returns them to login', async () => {
    mocks.locationState = { userExists: true, phoneNumber: '+919876543210' };
    mocks.getU18Status.mockResolvedValue({ isMinor: true, guardianVerified: false, hasBirthData: true });
    await renderOtp();

    submitOtpCode();

    await userEvent.click(await screen.findByRole('button', { name: 'guardian-logout' }));

    expect(mocks.signOut).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith('/auth/login', { replace: true });
  });

  it('falls through to normal landing when the u18 status lookup fails', async () => {
    mocks.locationState = { userExists: true, phoneNumber: '+919876543210' };
    mocks.getU18Status.mockRejectedValue(new Error('u18 status down'));
    await renderOtp();

    submitOtpCode();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true }));
    expect(screen.queryByTestId('u18-guardian-flow')).toBeNull();
  });
});
