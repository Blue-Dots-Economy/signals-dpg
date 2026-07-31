import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The post-login completion steps the OTP flow performs in `otp-page.tsx` but
 * the OIDC callback originally did not — gaps G3 (durable domains/age), G4 (the
 * U18 guardian gate) and G7 (the wrong-portal domain gate) of
 * docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md.
 *
 * These assert the callback's *orchestration*: which steps run, in what order,
 * and what stops the user landing. The children (guardian flow, consent modal)
 * and the pure helpers have their own tests.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('@/hooks/use-auth-config', () => ({
  useAuthConfig: () => ({
    config: {
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
      authProvider: 'keycloak',
      keycloak: { url: 'http://kc', realm: 'bluedots', clientId: 'signals-ui' },
    },
    isLoading: false,
    isKeycloakLogin: true,
  }),
}));

const completeKeycloakLogin = vi.fn(async () => {});
const signOut = vi.fn(async () => {});
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ completeKeycloakLogin, signOut }),
}));

const completeOidcLogin = vi.fn(async () => ({ returnTo: '/dashboard' }));
vi.mock('@/lib/oidc-client', () => ({
  completeOidcLogin: () => completeOidcLogin(),
}));

vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({ themeId: 'blue_dot', brand: 'standard' }),
}));

// ── the seams under test ───────────────────────────────────────────────────
let servedScope: { network: string; domains: string[] } | null = null;
vi.mock('@/lib/served-binding', () => ({ getServedScope: () => servedScope }));

const resolveHeldDomains = vi.fn(async () => [] as string[]);
vi.mock('@/lib/domain-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/domain-gate')>()),
  resolveHeldDomains: () => resolveHeldDomains(),
}));

const takePendingSignupExtras =
  vi.fn<() => { domain: string; age?: number } | null>(() => null);
vi.mock('@/lib/pending-signup-extras', () => ({
  takePendingSignupExtras: () => takePendingSignupExtras(),
}));

const takePendingConsent = vi.fn<() => unknown>(() => null);
vi.mock('@/lib/pending-consent', () => ({
  takePendingConsent: () => takePendingConsent(),
}));

const setUserDomains = vi.fn(async (_domains: string[]) => ['seeker']);
vi.mock('@/lib/user-api', () => ({ setUserDomains: (d: string[]) => setUserDomains(d) }));

const setStoredSignupDomain = vi.fn();
vi.mock('@/lib/signup-domain', () => ({
  setStoredSignupDomain: (n: string, d: string) => setStoredSignupDomain(n, d),
}));

const submitU18Dob = vi.fn(async (_body: { network: string; age: number }) => ({ ok: true }));
const getU18Status = vi.fn(async () => ({
  hasBirthData: false,
  isMinor: false,
  guardianVerified: false,
}));
const acceptConsent = vi.fn(async (_body: unknown) => ({ ok: true }));
const fetchConsentConfigs = vi.fn(async () => [] as unknown[]);
const getConsentStatus = vi.fn(async () => ({ statuses: { terms: [], privacy: [] } }));
vi.mock('@/lib/consent-api', () => ({
  acceptConsent: (b: unknown) => acceptConsent(b),
  fetchConsentConfigs: () => fetchConsentConfigs(),
  getConsentStatus: () => getConsentStatus(),
  getU18Status: () => getU18Status(),
  submitU18Dob: (b: { network: string; age: number }) => submitU18Dob(b),
}));

vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (props: { initialStep: string; onComplete: () => void }) => (
    <div data-testid="u18-guardian-flow" data-initial-step={props.initialStep}>
      <button type="button" onClick={props.onComplete}>
        guardian done
      </button>
    </div>
  ),
}));

vi.mock('@/components/consent/consent-modal', () => ({
  ConsentModal: () => <div data-testid="consent-modal" />,
}));

vi.mock('@/components/layout/auth-shell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { OidcCallbackPage } = await import('../oidc-callback-page');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OidcCallbackPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  servedScope = null;
  resolveHeldDomains.mockResolvedValue([]);
  takePendingSignupExtras.mockReturnValue(null);
  takePendingConsent.mockReturnValue(null);
  setUserDomains.mockResolvedValue(['seeker']);
  submitU18Dob.mockResolvedValue({ ok: true });
  getU18Status.mockResolvedValue({
    hasBirthData: false,
    isMinor: false,
    guardianVerified: false,
  });
  getConsentStatus.mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  fetchConsentConfigs.mockResolvedValue([]);
  completeOidcLogin.mockResolvedValue({ returnTo: '/dashboard' });
});

describe('G7 — wrong-portal domain gate', () => {
  it('signs a user out and bounces them when they hold an unserved domain', async () => {
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
    resolveHeldDomains.mockResolvedValue(['provider']);

    renderPage();

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith('/auth/login', {
      replace: true,
      state: { wrongPortalDomain: 'provider' },
    });
    // Nothing may be written for a user who is being turned away.
    expect(setUserDomains).not.toHaveBeenCalled();
    expect(getU18Status).not.toHaveBeenCalled();
  });

  it('lands a user who holds only served domains', async () => {
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
    resolveHeldDomains.mockResolvedValue(['seeker']);

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it('is skipped entirely when the deployment has no served scope', async () => {
    servedScope = null;

    renderPage();

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(resolveHeldDomains).not.toHaveBeenCalled();
  });
});

describe('G3 — durable domains/age write', () => {
  it('persists the parked domain and hands it to the profile form', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker' });

    renderPage();

    await waitFor(() => expect(setUserDomains).toHaveBeenCalledWith(['seeker']));
    expect(setStoredSignupDomain).toHaveBeenCalledWith('blue_dot', 'seeker');
  });

  it('persists the age when one was captured', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker', age: 15 });

    renderPage();

    await waitFor(() =>
      expect(submitU18Dob).toHaveBeenCalledWith({ network: 'blue_dot', age: 15 })
    );
  });

  it('does not submit an age for an ungated signup that captured none', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'provider' });

    renderPage();

    await waitFor(() => expect(setUserDomains).toHaveBeenCalled());
    expect(submitU18Dob).not.toHaveBeenCalled();
  });

  it('still lands the user when the domain write fails', async () => {
    // Best-effort: profile-form falls back to held items if unset.
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker' });
    setUserDomains.mockRejectedValue(new Error('network'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('still lands the user when the age write fails', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker', age: 15 });
    submitU18Dob.mockRejectedValue(new Error('network'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('writes nothing for a returning user with nothing parked', async () => {
    takePendingSignupExtras.mockReturnValue(null);

    renderPage();

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(setUserDomains).not.toHaveBeenCalled();
    expect(submitU18Dob).not.toHaveBeenCalled();
  });
});

describe('G4 — authenticated U18 guardian gate', () => {
  it('holds an unverified minor on the guardian flow instead of landing them', async () => {
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    const flow = await screen.findByTestId('u18-guardian-flow');
    // Birth data already stored → skip straight to the guardian step.
    expect(flow.getAttribute('data-initial-step')).toBe('guardian');
    expect(navigate).not.toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('starts at the DOB step when no birth data is stored', async () => {
    // The Keycloak chooser has no pre-login step to collect it, unlike the OTP
    // flow's u18Precheck — so the callback must be able to ask here.
    getU18Status.mockResolvedValue({
      hasBirthData: false,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    const flow = await screen.findByTestId('u18-guardian-flow');
    expect(flow.getAttribute('data-initial-step')).toBe('dob');
  });

  it('does not gate a minor whose guardian is already verified', async () => {
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: true,
    });

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
    expect(screen.queryByTestId('u18-guardian-flow')).toBeNull();
  });

  it('falls through and lands the user when the status lookup fails', async () => {
    // The server-side go-live gate is the real fail-closed control.
    getU18Status.mockRejectedValue(new Error('status down'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('skips the adult consent gate for a gated minor', async () => {
    // #453: the guardian flow records their consent guardian-sourced, so the
    // adult terms/privacy screens must not also be shown.
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    await screen.findByTestId('u18-guardian-flow');
    expect(screen.queryByTestId('consent-modal')).toBeNull();
    expect(getConsentStatus).not.toHaveBeenCalled();
  });
});

describe('ordering', () => {
  it('applies the parked age before checking U18 status', async () => {
    // Otherwise a fresh minor's age is not yet stored and the gate reports
    // isMinor:false, silently skipping the guardian capture.
    const order: string[] = [];
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker', age: 15 });
    submitU18Dob.mockImplementation(async () => {
      order.push('submitU18Dob');
      return { ok: true };
    });
    getU18Status.mockImplementation(async () => {
      order.push('getU18Status');
      return { hasBirthData: true, isMinor: false, guardianVerified: false };
    });

    renderPage();

    await waitFor(() => expect(getU18Status).toHaveBeenCalled());
    expect(order).toEqual(['submitU18Dob', 'getU18Status']);
  });

  it('runs the domain gate before any write', async () => {
    const order: string[] = [];
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
    resolveHeldDomains.mockImplementation(async () => {
      order.push('domainGate');
      return [];
    });
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker' });
    setUserDomains.mockImplementation(async () => {
      order.push('setUserDomains');
      return ['seeker'];
    });

    renderPage();

    await waitFor(() => expect(setUserDomains).toHaveBeenCalled());
    expect(order).toEqual(['domainGate', 'setUserDomains']);
  });
});
