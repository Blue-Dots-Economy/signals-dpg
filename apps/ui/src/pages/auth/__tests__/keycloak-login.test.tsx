import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Build 2's merge-safety property: with `VITE_AUTH_PROVIDER` unset, /auth/login
 * still renders the OTP screen and nothing OIDC-related runs. Plus the happy
 * and unhappy paths of the Keycloak screen itself.
 */

const CURRENT_YEAR = new Date().getFullYear();

// The login screen is now chosen from the API's auth config, not a build-time
// env var, so the hook is what gets stubbed.
let keycloakEnabled = false;
let configLoading = false;
let signupAllowed = true;
vi.mock('@/hooks/use-auth-config', () => ({
  useAuthConfig: () => ({
    config: {
      selfSignupAllowed: signupAllowed,
      loginChannels: ['phone', 'email'],
      authProvider: keycloakEnabled ? 'keycloak' : 'betterauth',
      keycloak: keycloakEnabled
        ? { url: 'http://localhost:8080', realm: 'bluedots', clientId: 'signals-ui' }
        : null,
    },
    isLoading: configLoading,
    isKeycloakLogin: keycloakEnabled,
  }),
}));

const startKeycloakLogin = vi.fn(async () => {});
const completeKeycloakLogin = vi.fn(async () => {});

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    isAuthenticated: false,
    isKeycloakLogin: keycloakEnabled,
    startKeycloakLogin,
    completeKeycloakLogin,
    checkUser: vi.fn(),
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const completeOidcLogin =
  vi.fn<() => Promise<{ accessToken: string; returnTo?: string }>>();
vi.mock('@/lib/oidc-client', () => ({
  completeOidcLogin: (...args: unknown[]) => completeOidcLogin(...(args as [])),
}));

// The OTP screen fetches instance auth config and the network on mount; stub
// both so the "toggle off" case doesn't reach for a real API.
vi.mock('@/lib/auth-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-api')>()),
  fetchAuthConfig: vi
    .fn()
    .mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] }),
  signupWithKeycloak: (body: SignupBody) => signupWithKeycloak(body),
}));
vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfig: vi.fn().mockResolvedValue({
    id: 'blue_dot',
    domains: [
      { id: 'seeker', guardian_consent_required: true },
      { id: 'provider', guardian_consent_required: false },
    ],
  }),
}));

type SignupBody = {
  name: string;
  email?: string;
  phoneNumber?: string;
  domain?: string;
  age?: number;
};
const signupWithKeycloak =
  vi.fn<(body: SignupBody) => Promise<{ ok: true; alreadyRegistered: boolean }>>();

// AuthShell renders the footer, which reads consent config through React Query.
const fetchConsentConfigs = vi.fn<() => Promise<unknown[]>>();
const getConsentStatusByIdentifier =
  vi.fn<() => Promise<{ statuses: { terms: string[]; privacy: string[] } }>>();
type AcceptBody = { source: string; items: Array<{ category: string; version: string }> };
const acceptConsent = vi.fn<(body: AcceptBody) => Promise<{ ok: boolean }>>();
const getConsentStatus =
  vi.fn<() => Promise<{ statuses: { terms: string[]; privacy: string[] } }>>();
vi.mock('@/lib/consent-api', () => ({
  fetchConsentConfigs: () => fetchConsentConfigs(),
  getConsentStatusByIdentifier: () => getConsentStatusByIdentifier(),
  getConsentStatus: () => getConsentStatus(),
  acceptConsent: (body: AcceptBody) => acceptConsent(body),
}));

// Stub the pre-auth guardian flow so we assert the panel's gating wiring, not
// the child's internals — those have their own tests.
const guardianComplete = vi.fn();
vi.mock('@/components/consent/u18/signup-guardian-flow', () => ({
  SignupGuardianFlow: (props: {
    domain: string;
    age: number;
    identifier: { email?: string; phoneNumber?: string };
    onComplete: () => void;
  }) => {
    guardianComplete.mockImplementation(props.onComplete);
    return (
      <div
        data-testid="signup-guardian-flow"
        data-domain={props.domain}
        data-age={String(props.age)}
        data-identifier={props.identifier.email ?? props.identifier.phoneNumber ?? ''}
      >
        <button type="button" onClick={props.onComplete}>guardian done</button>
      </div>
    );
  },
}));

// Stub the modal so we assert the panel's gating wiring, not the child's
// internals — those have their own tests.
const consentAcceptSpy = vi.fn();
vi.mock('@/components/consent/consent-modal', () => ({
  ConsentModal: (props: { onAccept: () => void }) => {
    consentAcceptSpy.mockImplementation(props.onAccept);
    return (
      <div data-testid="consent-modal">
        <button type="button" onClick={props.onAccept}>
          accept consent
        </button>
      </div>
    );
  },
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

const { LoginPage } = await import('../login-page.js');
const { OidcCallbackPage } = await import('../oidc-callback-page.js');

const wrap = (ui: React.ReactElement, path: string) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/auth/login" element={ui} />
        <Route path="/auth/callback" element={ui} />
        <Route path="/profile/new" element={<div>profile form</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

const renderAt = (ui: React.ReactElement, path = '/auth/login') => render(wrap(ui, path));

beforeEach(() => {
  keycloakEnabled = false;
  configLoading = false;
  signupAllowed = true;
  startKeycloakLogin.mockClear().mockResolvedValue(undefined);
  completeKeycloakLogin.mockClear().mockResolvedValue(undefined);
  completeOidcLogin.mockClear().mockResolvedValue({ accessToken: 'tok', returnTo: undefined });
  signupWithKeycloak.mockClear().mockResolvedValue({ ok: true, alreadyRegistered: false });
  // Default: consent already accepted for the current version, so no gate.
  fetchConsentConfigs.mockReset().mockResolvedValue([]);
  getConsentStatusByIdentifier
    .mockReset()
    .mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  acceptConsent.mockClear().mockResolvedValue({ ok: true });
  // Default: nothing outstanding, so the callback's login-time gate stays shut.
  getConsentStatus.mockReset().mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  guardianComplete.mockClear();
  localStorage.clear();
});

/** A consent config whose current versions are NOT yet accepted. */
const CONSENT_CONFIGS = [
  {
    brand: null,
    schema: {
      documents: {
        terms: { current_version: 'v2', title: 'Terms', body: 'terms body' },
        privacy: { current_version: 'v2', title: 'Privacy', body: 'privacy body' },
      },
    },
  },
];

describe('LoginPage provider switch', () => {
  it('renders the OTP screen when the toggle is off', () => {
    renderAt(<LoginPage />);

    // The OTP screen's identifier field; the Keycloak panel has no inputs.
    expect(document.querySelector('input')).not.toBeNull();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('renders the Keycloak panel when the toggle is on', () => {
    keycloakEnabled = true;

    renderAt(<LoginPage />);

    expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
    expect(document.querySelector('input')).toBeNull();
  });
});

describe('KeycloakLoginPanel', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('redirects to Keycloak on click', async () => {
    renderAt(<LoginPage />);

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalledWith('/'));
  });

  it('round-trips the ?redirect= target so a deep link survives login', async () => {
    renderAt(<LoginPage />, '/auth/login?redirect=%2Fprofile%2Fnew');

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalledWith('/profile/new'));
  });

  it('surfaces a redirect failure instead of hanging on a spinner', async () => {
    startKeycloakLogin.mockRejectedValueOnce(new Error('Keycloak is not configured'));

    renderAt(<LoginPage />);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Keycloak is not configured')).toBeTruthy();
    // Re-enabled, so the user can retry.
    expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
  });
});

describe('OidcCallbackPage', () => {
  // You only reach the callback when Keycloak is the provider, and the page now
  // requires the server to advertise it before touching the single-use code.
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('exchanges the code, resolves the user, and lands on home', async () => {
    renderAt(<OidcCallbackPage />, '/auth/callback');

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
    expect(completeOidcLogin).toHaveBeenCalledOnce();
    expect(completeKeycloakLogin).toHaveBeenCalledOnce();
  });

  it('honours the returnTo carried through Keycloak state', async () => {
    completeOidcLogin.mockResolvedValueOnce({
      accessToken: 'tok',
      returnTo: '/profile/new',
    });

    renderAt(<OidcCallbackPage />, '/auth/callback');

    await waitFor(() => expect(screen.getByText('profile form')).toBeTruthy());
  });

  it('exchanges the single-use code exactly once', async () => {
    // StrictMode double-invokes effects; a second exchange of a spent code
    // fails, so a phantom error would show up in dev only.
    const { rerender } = renderAt(<OidcCallbackPage />, '/auth/callback');
    rerender(wrap(<OidcCallbackPage />, '/auth/callback'));

    await waitFor(() => expect(completeOidcLogin).toHaveBeenCalledTimes(1));
  });

  it("shows the API's own message when provisioning refuses the login", async () => {
    // This is how SELF_SIGNUP_DISABLED / USER_BANNED reach the user: as the
    // API's message on GET /api/v1/auth/me, not a generic failure.
    completeKeycloakLogin.mockRejectedValueOnce({
      response: {
        data: {
          code: 'SELF_SIGNUP_DISABLED',
          message: 'Self sign-up is disabled on this instance.',
        },
      },
    });

    renderAt(<OidcCallbackPage />, '/auth/callback');

    expect(
      await screen.findByText('Self sign-up is disabled on this instance.')
    ).toBeTruthy();
  });

  it('falls back to a generic message when the failure carries none', async () => {
    completeOidcLogin.mockRejectedValueOnce({});

    renderAt(<OidcCallbackPage />, '/auth/callback');

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
  });
});

describe('OidcCallbackPage — the redirect-loop regression', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('does not exchange the code while the auth config is still loading', async () => {
    // The bug: the callback page is entered by a full-page redirect, so the
    // OIDC client must be rebuilt from the server's Keycloak details. Firing
    // before /api/v1/auth/config resolved built it from `undefined`, threw
    // "Keycloak is not configured", and — because the single-use guard was
    // already set — never retried. The user then bounced between the error and
    // Keycloak's still-valid SSO session.
    configLoading = true;

    renderAt(<OidcCallbackPage />, '/auth/callback');

    // Still on the spinner, and crucially the single-use code is untouched.
    await waitFor(() => expect(screen.getByText(/signing you in/i)).toBeTruthy());
    expect(completeOidcLogin).not.toHaveBeenCalled();
    expect(screen.queryByText(/not configured/i)).toBeNull();
  });

  it('exchanges exactly once, after the config arrives', async () => {
    configLoading = true;
    const { rerender } = renderAt(<OidcCallbackPage />, '/auth/callback');
    expect(completeOidcLogin).not.toHaveBeenCalled();

    // Config resolves.
    configLoading = false;
    rerender(wrap(<OidcCallbackPage />, '/auth/callback'));

    await waitFor(() => expect(completeOidcLogin).toHaveBeenCalledTimes(1));
  });

  it('reports an unconfigured instance distinctly from a failed sign-in', async () => {
    // Config loaded but advertises no Keycloak: either the API isn't in a
    // Keycloak mode, or the config request failed outright.
    keycloakEnabled = false;

    renderAt(<OidcCallbackPage />, '/auth/callback');

    expect(await screen.findByText(/single sign-on isn't available/i)).toBeTruthy();
    expect(completeOidcLogin).not.toHaveBeenCalled();
  });
});

describe('KeycloakLoginPanel — existing vs new user chooser', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('offers both choices, and neither acts until picked', async () => {
    renderAt(<LoginPage />);

    expect(await screen.findByText(/existing user/i)).toBeTruthy();
    expect(screen.getByText(/new here/i)).toBeTruthy();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('sends an existing user straight to Keycloak', async () => {
    renderAt(<LoginPage />);

    await userEvent.click(await screen.findByText(/existing user/i));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalledWith('/'));
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('hides the signup choice when the instance is gated', async () => {
    // selfSignupAllowed comes from the API; a gated instance must not offer it.
    keycloakEnabled = true;
    signupAllowed = false;

    renderAt(<LoginPage />);

    expect(await screen.findByText(/existing user/i)).toBeTruthy();
    expect(screen.queryByText(/new here/i)).toBeNull();
  });

  it('collects name, identifier, domain and DOB, then signs in', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.type(screen.getByLabelText(/date of birth/i), '2005-04-02');

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    const [body] = signupWithKeycloak.mock.calls[0];
    expect(body.name).toBe('Asha Rao');
    expect(body.phoneNumber).toContain('9876543210');
    expect(body.age).toBe(CURRENT_YEAR - 2005);
    // Signup is followed immediately by the normal OIDC login.
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('refuses to submit without a name', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/please enter your name/i)).toBeTruthy();
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('surfaces the API refusal message', async () => {
    signupWithKeycloak.mockRejectedValueOnce({
      response: { data: { code: 'SIGNUP_RATE_LIMITED', message: 'Too many sign-up attempts.' } },
    });

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/too many sign-up attempts/i)).toBeTruthy();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('still signs in when the identifier is already registered', async () => {
    signupWithKeycloak.mockResolvedValueOnce({ ok: true, alreadyRegistered: true });

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });
});

describe('terms & privacy gate on registration', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    fetchConsentConfigs.mockResolvedValue(CONSENT_CONFIGS);
    // Nothing accepted yet → the gate must open.
    getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  });

  const fillSignupForm = async () => {
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  };

  it('shows the consent modal BEFORE creating the account', async () => {
    renderAt(<LoginPage />);
    await fillSignupForm();

    expect(await screen.findByTestId('consent-modal')).toBeTruthy();
    // Ordering is the point: nothing is created until terms are accepted.
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('creates the account and signs in once accepted', async () => {
    renderAt(<LoginPage />);
    await fillSignupForm();
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('parks the acceptance so it survives the Keycloak redirect', async () => {
    // The accept endpoint is authenticated, so it can't be written yet.
    renderAt(<LoginPage />);
    await fillSignupForm();
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(localStorage.getItem('pendingConsent')).not.toBeNull());
    const parked = JSON.parse(localStorage.getItem('pendingConsent') as string);
    expect(parked.source).toBe('signup');
    expect(parked.items.map((i: { category: string }) => i.category).sort()).toEqual([
      'privacy',
      'terms',
    ]);
    // Not written pre-login.
    expect(acceptConsent).not.toHaveBeenCalled();
  });

  it('skips the gate when the current versions are already accepted', async () => {
    getConsentStatusByIdentifier.mockResolvedValue({
      statuses: { terms: ['v2'], privacy: ['v2'] },
    });

    renderAt(<LoginPage />);
    await fillSignupForm();

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('fails open when the consent pre-check errors', async () => {
    // Same posture as the OTP flow: a consent-service blip must not block
    // registration; the user is re-prompted next login.
    getConsentStatusByIdentifier.mockRejectedValue(new Error('consent service down'));

    renderAt(<LoginPage />);
    await fillSignupForm();

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });
});

describe('OidcCallbackPage — flushing the parked consent', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('writes the parked acceptance once the session exists', async () => {
    const parked = {
      network: 'blue_dot',
      brand: null,
      source: 'signup',
      items: [{ category: 'terms', version: 'v2' }],
    };
    localStorage.setItem('pendingConsent', JSON.stringify(parked));

    renderAt(<OidcCallbackPage />, '/auth/callback');

    await waitFor(() => expect(acceptConsent).toHaveBeenCalledWith(parked));
    // Read-once: cleared so it can't be replayed onto a later login.
    expect(localStorage.getItem('pendingConsent')).toBeNull();
    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
  });

  it('does nothing when there is no parked consent', async () => {
    renderAt(<OidcCallbackPage />, '/auth/callback');

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
    expect(acceptConsent).not.toHaveBeenCalled();
  });

  it('still signs the user in when persisting the consent fails', async () => {
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({ network: 'blue_dot', brand: null, source: 'signup', items: [] })
    );
    acceptConsent.mockRejectedValueOnce(new Error('write failed'));

    renderAt(<OidcCallbackPage />, '/auth/callback');

    // Signed in regardless — the gate re-prompts next login.
    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
  });
});

describe('OidcCallbackPage — landing is not conditional on the effect surviving', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('lands on / even when the page re-renders while consent is being written', async () => {
    // In the app, completeKeycloakLogin() calls setUser(), which re-renders this
    // page. Any dep identity change then runs the effect cleanup. If navigation
    // is gated on that flag, the user is stranded on the spinner despite being
    // fully signed in — which is exactly what the consent write's extra await
    // exposed.
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({ network: 'blue_dot', brand: null, source: 'signup', items: [] })
    );
    let resolveAccept: (v: { ok: boolean }) => void = () => {};
    acceptConsent.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveAccept = resolve; })
    );

    const { rerender } = renderAt(<OidcCallbackPage />, '/auth/callback');
    await waitFor(() => expect(acceptConsent).toHaveBeenCalled());

    // Simulate the re-render that the session update causes.
    rerender(wrap(<OidcCallbackPage />, '/auth/callback'));
    resolveAccept({ ok: true });

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
  });
});

describe('OidcCallbackPage — consent write cannot stall the landing', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands the user anyway when the consent write hangs', async () => {
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({ network: 'blue_dot', brand: null, source: 'signup', items: [] })
    );
    // Never resolves.
    acceptConsent.mockImplementationOnce(() => new Promise(() => {}));

    renderAt(<OidcCallbackPage />, '/auth/callback');
    await waitFor(() => expect(acceptConsent).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(8500);

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
  });
});

describe('U18 guardian capture on the Keycloak signup path', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  const fillSignup = async (opts: { domain: string; dob: string }) => {
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(`^${opts.domain}$`, 'i') })
    );
    await userEvent.type(screen.getByLabelText(/date of birth/i), opts.dob);
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  };

  it('runs the guardian flow BEFORE creating the account for a gated minor', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', dob: '2015-04-02' });

    const flow = await screen.findByTestId('signup-guardian-flow');
    expect(flow.getAttribute('data-domain')).toBe('seeker');
    expect(flow.getAttribute('data-age')).toBe(String(CURRENT_YEAR - 2015));
    // Ordering is the point: nothing exists until the guardian is verified.
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('creates the account once the guardian is verified', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', dob: '2015-04-02' });
    await userEvent.click(await screen.findByRole('button', { name: /guardian done/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('does NOT show the ordinary consent gate for a minor', async () => {
    // The guardian flow records terms/privacy guardian-sourced, so stacking the
    // ordinary gate on top would double-ask and mis-attribute the source.
    fetchConsentConfigs.mockResolvedValue(CONSENT_CONFIGS);
    getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [], privacy: [] } });

    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', dob: '2015-04-02' });

    expect(await screen.findByTestId('signup-guardian-flow')).toBeTruthy();
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('skips the guardian flow for an ADULT in a gated domain', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', dob: '1990-04-02' });

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
  });

  it('skips the guardian flow for a minor in an UNGATED domain', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'provider', dob: '2015-04-02' });

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
  });
});

describe('OidcCallbackPage — login-time consent re-prompt', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    fetchConsentConfigs.mockResolvedValue(CONSENT_CONFIGS);
  });

  it('gates a returning user whose accepted version is stale', async () => {
    // The gap this closes: better-auth gates at every login, the Keycloak
    // chooser has no identifier to pre-check, so a migrated user or anyone who
    // signed up before a version bump was never re-prompted.
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v1'], privacy: ['v1'] } });

    renderAt(<OidcCallbackPage />, '/auth/callback');

    expect(await screen.findByTestId('consent-modal')).toBeTruthy();
    // Held on the callback — not landed yet.
    expect(screen.queryByText('home')).toBeNull();
  });

  it('writes the acceptance and lands the user', async () => {
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v1'], privacy: ['v1'] } });

    renderAt(<OidcCallbackPage />, '/auth/callback');
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(acceptConsent).toHaveBeenCalled());
    const [body] = acceptConsent.mock.calls[0];
    // A returning user, not a signup.
    expect(body.source).toBe('login');
    expect(body.items).toHaveLength(2);
    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
  });

  it('does not gate when the current versions are already accepted', async () => {
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v2'], privacy: ['v2'] } });

    renderAt(<OidcCallbackPage />, '/auth/callback');

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('fails open when the status check errors — never blocks a completed login', async () => {
    getConsentStatus.mockRejectedValue(new Error('consent service down'));

    renderAt(<OidcCallbackPage />, '/auth/callback');

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('lands the user even when persisting the acceptance fails', async () => {
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v1'], privacy: ['v1'] } });
    acceptConsent.mockRejectedValueOnce(new Error('write failed'));

    renderAt(<OidcCallbackPage />, '/auth/callback');
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
  });
});

describe('guardian capture identifier normalisation', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('keys the guardian capture on the E.164 phone, not the raw input', async () => {
    // The pre-auth guardian capture is keyed on a hash of the identifier, and the
    // server only trims — it does NOT convert to E.164. At first login the token
    // carries the E.164 number, so a capture keyed on the national form never
    // matches and materializeSignupGuardian silently no-ops: the user sees
    // "verified", the account is created, and the guardian record is dropped.
    await userEvent.click(await (async () => {
      renderAt(<LoginPage />);
      return screen.findByText(/new here/i);
    })());
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(await screen.findByRole('button', { name: /^seeker$/i }));
    await userEvent.type(screen.getByLabelText(/date of birth/i), '2015-04-02');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    const flow = await screen.findByTestId('signup-guardian-flow');
    expect(flow.getAttribute('data-identifier')).toBe('+919876543210');
  });

  it('sends the same E.164 identifier on to signup', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(await screen.findByRole('button', { name: /^provider$/i }));
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    // Must be the SAME value the guardian capture would have used, or the two
    // halves of the signup key on different identifiers.
    expect(signupWithKeycloak.mock.calls[0][0].phoneNumber).toBe('+919876543210');
  });
});
