import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';
import type { CreateItemPayload, Item, UpdateItemPayload } from '@/lib/item-api';

// Coverage-focused companion to `profile-form-page.test.tsx` (PageShell/create/
// edit-of-draft consent) and `profile-form-page.landmarks.test.tsx` (a11y).
// This file exercises the paths those two don't reach:
//   • the loading / no-networks / unresolved-network guards
//   • edit-mode item-load outcomes (genuine miss → redirect, fetch error → toast)
//   • the multi-role picker (pick a role, step back to it, role narrowing)
//   • the form-validity gate (hint copy + consent tick reset)
//   • handleSubmit's failure branches (403 / 401 / 409 / generic, create + edit)
//   • the pre-create guardian OTP flow for a minor on a gated domain
//     (issue → verify → finalize, plus the 409/429/503/failure branches)

// ---- Fixtures -------------------------------------------------------------

const SCHEMA: RJSFSchema = {
  type: 'object',
  properties: { 'Full Name': { type: 'string' } },
  required: ['Full Name'],
};

const SEEKER: DotNetworkDomain = {
  id: 'seeker',
  description: 'Job seeker',
  item_schemas: { 'profile_1.0': SCHEMA },
};

const PROVIDER: DotNetworkDomain = {
  id: 'provider',
  description: 'Job provider',
  item_schemas: { 'provider_1.0': SCHEMA },
  profile_completion_prompt: {
    heading: 'Post your first job',
    body: 'Providers with a complete profile get more applicants.',
  },
};

// Same seeker domain, but minors must be guardian-verified here.
const GATED_SEEKER: DotNetworkDomain = { ...SEEKER, guardian_consent_required: true };

function buildNetwork(domains: DotNetworkDomain[]): DotNetworkSchema {
  return {
    id: 'blue_dot',
    display_name: 'Blue Dots',
    description: 'test network',
    schema_standard: '1.0',
    domains,
    actions: {},
  };
}

const CONSENT_CONFIG = {
  documents: {
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I consent to creating my profile.' }],
    },
  },
};

interface PrecreateRef {
  network: string;
  brand: string | null;
  item_domain: string;
}

interface FinalizeRef extends PrecreateRef {
  item_type: string;
  item_id: string;
}

/** A plain axios-shaped rejection: `axios.isAxiosError` only checks the flag. */
function axiosError(status: number, data: Record<string, unknown>): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

/** A non-axios rejection carrying a `response` — what the page's submit reads. */
function httpError(status: number, data: Record<string, unknown>): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

// ---- Mutable module state driven by each test ------------------------------

let currentNetwork: DotNetworkSchema = buildNetwork([SEEKER]);
let networksResult: { data: DotNetworkSchema[] | undefined; isError: boolean } = {
  data: [currentNetwork],
  isError: false,
};
let resolvedResult: { data: DotNetworkSchema | undefined; isError: boolean } = {
  data: currentNetwork,
  isError: false,
};
let editItemResult: {
  data: Item | null;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
} = { data: null, isSuccess: false, isError: false, error: null };
let consentConfigResult: { config: typeof CONSENT_CONFIG | null; isLoading: boolean } = {
  config: null,
  isLoading: false,
};
let paramsMock: { id?: string } = {};
let userDomainsResult: string[] = [];

/** Point both network hooks at `net` (they must agree, as in production). */
function useNetwork(net: DotNetworkSchema): void {
  currentNetwork = net;
  networksResult = { data: [net], isError: false };
  resolvedResult = { data: net, isError: false };
}

const getServedScope = vi.fn();
const navigateMock = vi.fn();
const signOutMock = vi.fn();

const createItemMock = vi.fn(
  (_payload: CreateItemPayload): Promise<{ item_id: string; item_type: string }> =>
    Promise.resolve({ item_id: 'new-1', item_type: 'profile_1.0' }),
);
const updateItemMock = vi.fn(
  (_itemId: string, _payload: UpdateItemPayload): Promise<unknown> => Promise.resolve({}),
);
const getU18StatusMock = vi.fn(
  (_network: string): Promise<{ isMinor: boolean }> => Promise.resolve({ isMinor: false }),
);
const issueOtpMock = vi.fn(
  (_ref: PrecreateRef): Promise<{ otpSent: boolean }> => Promise.resolve({ otpSent: true }),
);
const verifyOtpMock = vi.fn(
  (_ref: PrecreateRef & { otp: string }): Promise<{ verified: boolean }> =>
    Promise.resolve({ verified: true }),
);
const finalizeMock = vi.fn(
  (_ref: FinalizeRef): Promise<{ promoted: boolean }> => Promise.resolve({ promoted: true }),
);

// ---- Mocks ----------------------------------------------------------------

// PageShell → passthrough providing the single <main> + the bar title, so the
// page's own content is assertable without the real sidebar/top-bar.
vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: {
    variant?: string;
    title?: string;
    children: React.ReactNode;
    footerSlot?: React.ReactNode;
  }) => (
    <div data-testid="shell" data-variant={p.variant}>
      <main id="main-content">
        {p.title ? <h1>{p.title}</h1> : null}
        {p.children}
      </main>
      {p.footerSlot}
    </div>
  ),
}));

// SchemaForm → a real <form id> so the action-bar's `type=submit
// form=profile-form` button submits, plus explicit validity controls so the
// invalid branch of the action bar is reachable.
vi.mock('@/components/forms/schema-form', () => ({
  SchemaForm: (p: {
    id?: string;
    onSubmit: (data: Record<string, unknown>) => void;
    onValidityChange?: (v: boolean) => void;
  }) => {
    React.useEffect(() => {
      p.onValidityChange?.(true);
    }, []);
    return (
      <form
        id={p.id}
        data-testid="schema-form"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit({ 'Full Name': 'Asha' });
        }}
      >
        <button type="button" data-testid="form-invalid" onClick={() => p.onValidityChange?.(false)}>
          report invalid
        </button>
        <button type="button" data-testid="form-valid" onClick={() => p.onValidityChange?.(true)}>
          report valid
        </button>
      </form>
    );
  },
}));

// The guardian *capture* flow (no guardian on file yet) makes its own network
// calls and is covered by its own tests — stub it down to its two outcomes.
vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (p: {
    initialStep?: string;
    onComplete: () => void;
    onNotMinor: () => void;
  }) => (
    <div data-testid="u18-setup-flow" data-initial-step={p.initialStep}>
      <button type="button" onClick={p.onComplete}>
        guardian captured
      </button>
      <button type="button" onClick={p.onNotMinor}>
        not a minor
      </button>
    </div>
  ),
}));

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => networksResult,
  useResolvedNetwork: () => resolvedResult,
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => consentConfigResult,
}));

vi.mock('@/hooks/use-profile-consent-accept', () => ({
  useProfileConsentAccept: () => ({
    accept: () => Promise.resolve(),
    dialogs: <div data-testid="consent-accept-dialogs" />,
    isPending: false,
  }),
}));

vi.mock('@/hooks/use-edit-item', () => ({
  useEditItem: () => editItemResult,
}));

vi.mock('@/hooks/use-my-items', () => ({
  useMyItems: () => ({ data: [] as Item[], isLoading: false, isFetched: true }),
}));

vi.mock('@/lib/active-profile', () => ({
  getStoredActiveProfileId: () => null,
  setStoredActiveProfileId: vi.fn(),
  clearStoredActiveProfileId: vi.fn(),
}));

vi.mock('@/lib/item-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/item-api')>()),
  createItem: (payload: CreateItemPayload) => createItemMock(payload),
  updateItem: (itemId: string, payload: UpdateItemPayload) => updateItemMock(itemId, payload),
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

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { email: 'a@example.com', phoneNumber: null, name: 'Asha' },
    signOut: () => signOutMock(),
  }),
}));

vi.mock('@/lib/served-binding', async (orig) => ({
  ...(await orig<typeof import('@/lib/served-binding')>()),
  getServedScope: () => getServedScope(),
}));

vi.mock('@/lib/user-api', () => ({
  getUserDomains: () => Promise.resolve(userDomainsResult),
}));

vi.mock('@/lib/consent-api', () => ({
  getU18Status: (network: string) => getU18StatusMock(network),
  issueProfilePrecreateOtp: (ref: PrecreateRef) => issueOtpMock(ref),
  verifyProfilePrecreateOtp: (ref: PrecreateRef & { otp: string }) => verifyOtpMock(ref),
  finalizeProfileConsent: (ref: FinalizeRef) => finalizeMock(ref),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
  useParams: () => paramsMock,
}));

// ---- Harness --------------------------------------------------------------

/** Radix marks the body `pointer-events: none` while a modal is open, which
 * user-event refuses to click through — this page's flows are dialog-driven. */
function ui() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

async function renderPage(entry = '/profile/new') {
  const { ProfileFormPage } = await import('../profile-form-page');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        {/* Toaster FIRST: sonner drops a toast published before a Toaster has
            subscribed, and this page toasts from a mount effect (the edit-mode
            "not found" / load-error paths), whose effect would otherwise run
            before a later sibling's subscription. */}
        <Toaster />
        <ProfileFormPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function liveItem(lifecycle: 'draft' | 'live' = 'live'): Item {
  return {
    item_id: 'item-1',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_network: 'blue_dot',
    item_state: { 'Full Name': 'Asha' },
    lifecycle_status: lifecycle,
  } as unknown as Item;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  useNetwork(buildNetwork([SEEKER]));
  editItemResult = { data: null, isSuccess: false, isError: false, error: null };
  consentConfigResult = { config: null, isLoading: false };
  paramsMock = {};
  userDomainsResult = [];
  getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
  createItemMock.mockResolvedValue({ item_id: 'new-1', item_type: 'profile_1.0' });
  updateItemMock.mockResolvedValue({});
  getU18StatusMock.mockResolvedValue({ isMinor: false });
  issueOtpMock.mockResolvedValue({ otpSent: true });
  verifyOtpMock.mockResolvedValue({ verified: true });
  finalizeMock.mockResolvedValue({ promoted: true });
  // The page logs load/save failures via console.error — keep the output clean
  // while still asserting it happened where that's the documented behaviour.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ---- Loading / terminal guards --------------------------------------------

describe('ProfileFormPage loading and no-network guards', () => {
  it('shows the schema-loading screen while the networks list is still in flight', async () => {
    networksResult = { data: undefined, isError: false };

    await renderPage();

    expect(await screen.findByText('Loading network schemas...')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('schema-form')).not.toBeInTheDocument();
  });

  it('reports "No networks available." when the networks list fails and nothing is served', async () => {
    networksResult = { data: undefined, isError: true };
    getServedScope.mockReturnValue(null);

    await renderPage();

    expect(await screen.findByText('No networks available.')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-action-bar')).not.toBeInTheDocument();
  });

  it('keeps a loading screen when the network id is known but its config has not resolved', async () => {
    resolvedResult = { data: undefined, isError: false };

    await renderPage();

    expect(await screen.findByText('Loading network schemas...')).toBeInTheDocument();
    expect(screen.queryByTestId('schema-form')).not.toBeInTheDocument();
  });

  it('edit mode shows the profile-loading screen until the item settles', async () => {
    paramsMock = { id: 'item-1' };
    editItemResult = { data: null, isSuccess: false, isError: false, error: null };

    await renderPage('/profile/item-1');

    expect(await screen.findByText('Loading profile...')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-action-bar')).not.toBeInTheDocument();
  });
});

// ---- Edit-mode item load outcomes -----------------------------------------

describe('ProfileFormPage edit-mode item load outcomes', () => {
  it('redirects home with a not-found toast when the item genuinely does not exist', async () => {
    paramsMock = { id: 'missing' };
    editItemResult = { data: null, isSuccess: true, isError: false, error: null };

    await renderPage('/profile/missing');

    expect(await screen.findByText('Profile not found')).toBeInTheDocument();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/?network=blue_dot'));
  });

  it('toasts (and logs) a load failure without redirecting, so the user can retry', async () => {
    paramsMock = { id: 'item-1' };
    editItemResult = { data: null, isSuccess: false, isError: true, error: new Error('boom') };

    await renderPage('/profile/item-1');

    expect(await screen.findByText("Couldn't load profile")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Failed to load profile:', expect.any(Error));
    // The load failed, so there is no schema-driven form to fill.
    expect(screen.queryByTestId('schema-form')).not.toBeInTheDocument();
  });
});

// ---- Role picker ----------------------------------------------------------

describe('ProfileFormPage role picker', () => {
  beforeEach(() => {
    useNetwork(buildNetwork([SEEKER, PROVIDER]));
    getServedScope.mockReturnValue(null);
  });

  it('lists the selectable roles and opens the picked role’s form with its completion prompt', async () => {
    await renderPage();

    expect(await screen.findByText('Choose your role on the network')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Job seeker/ })).toBeInTheDocument();
    expect(screen.queryByTestId('schema-form')).not.toBeInTheDocument();

    await ui().click(screen.getByRole('button', { name: /Job provider/ }));

    expect(
      await screen.findByRole('heading', { name: /create provider profile/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('schema-form')).toBeInTheDocument();
    // The per-domain #376 prompt wins over the generic i18n fallback.
    expect(screen.getByText('Post your first job')).toBeInTheDocument();
    expect(screen.getByText(/complete profile get more applicants/i)).toBeInTheDocument();
    expect(screen.queryByText('Complete your profile to get discovered')).not.toBeInTheDocument();
  });

  it('Cancel on a multi-role create form steps back to the picker instead of leaving the page', async () => {
    await renderPage();

    await ui().click(await screen.findByRole('button', { name: /Job seeker/ }));
    await screen.findByRole('heading', { name: /create seeker profile/i });

    await ui().click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Choose your role on the network')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('narrows the picker to the role persisted on the user and auto-selects it', async () => {
    userDomainsResult = ['provider'];

    await renderPage();

    expect(
      await screen.findByRole('heading', { name: /create provider profile/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Choose your role on the network')).not.toBeInTheDocument();
  });

  it('a single served domain skips the picker, and Cancel then leaves for home', async () => {
    getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });

    await renderPage();

    expect(
      await screen.findByRole('heading', { name: /create seeker profile/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Choose your role on the network')).not.toBeInTheDocument();

    await ui().click(screen.getByRole('button', { name: 'Cancel' }));

    expect(navigateMock).toHaveBeenCalledWith('/?network=blue_dot');
  });
});

// ---- Validity gate --------------------------------------------------------

describe('ProfileFormPage validity gate', () => {
  it('an invalid form hides consent, shows the fill-required hint, and re-validating clears the tick', async () => {
    consentConfigResult = { config: CONSENT_CONFIG, isLoading: false };

    await renderPage();

    const submit = await screen.findByRole('button', { name: 'Save & publish' });
    expect(submit).toBeDisabled();
    expect(screen.getByText('All required fields complete')).toBeInTheDocument();

    await ui().click(await screen.findByRole('checkbox', { name: /agree/i }));
    expect(submit).toBeEnabled();

    fireEvent.click(screen.getByTestId('form-invalid'));

    expect(
      await screen.findByText('Please fill in all the required fields to continue.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /agree/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & publish' })).toBeDisabled();

    fireEvent.click(screen.getByTestId('form-valid'));

    // Consent comes back UNTICKED — going invalid resets the acknowledgement.
    const tick = await screen.findByRole('checkbox', { name: /agree/i });
    expect(tick).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save & publish' })).toBeDisabled();
  });
});

// ---- Submit failure branches ---------------------------------------------

describe('ProfileFormPage submit failures', () => {
  async function submitCreate() {
    const btn = await screen.findByRole('button', { name: 'Create Profile' });
    await waitFor(() => expect(btn).toBeEnabled());
    await ui().click(btn);
  }

  it('a 403 UNSERVED_DOMAIN_BINDING surfaces the server message inline', async () => {
    createItemMock.mockRejectedValue(
      httpError(403, {
        error: 'UNSERVED_DOMAIN_BINDING',
        message: 'seeker is not served on this instance',
      }),
    );

    await renderPage();
    await submitCreate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Role not available on this instance');
    expect(alert).toHaveTextContent('seeker is not served on this instance');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('a 401 sends the user to login carrying the current path as the redirect target', async () => {
    createItemMock.mockRejectedValue(httpError(401, { error: 'UNAUTHORIZED' }));

    await renderPage('/profile/new');
    await submitCreate();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/auth/login?redirect=%2Fprofile%2Fnew'),
    );
    expect(await screen.findByText('Please sign in to continue')).toBeInTheDocument();
  });

  it('a 409 explains the profile already exists', async () => {
    createItemMock.mockRejectedValue(httpError(409, { error: 'DUPLICATE' }));

    await renderPage();
    await submitCreate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Profile already exists');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('any other create failure shows the create-failed title with the server message', async () => {
    createItemMock.mockRejectedValue(httpError(500, { message: 'database unavailable' }));

    await renderPage();
    await submitCreate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't create your profile");
    expect(alert).toHaveTextContent('database unavailable');
  });

  it('a failing edit shows the update-failed title with the generic description', async () => {
    paramsMock = { id: 'item-1' };
    editItemResult = { data: liveItem('live'), isSuccess: true, isError: false, error: null };
    updateItemMock.mockRejectedValue(httpError(500, {}));

    await renderPage('/profile/item-1');

    const btn = await screen.findByRole('button', { name: 'Update' });
    await waitFor(() => expect(btn).toBeEnabled());
    await ui().click(btn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update your profile");
    expect(alert).toHaveTextContent(/An unexpected error occurred/);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

// ---- Pre-create guardian OTP (minor on a gated domain) --------------------

describe('ProfileFormPage pre-create guardian OTP', () => {
  const OTP_TITLE = /guardian.s confirmation via otp/i;

  beforeEach(() => {
    useNetwork(buildNetwork([GATED_SEEKER]));
    getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
    consentConfigResult = { config: CONSENT_CONFIG, isLoading: false };
    getU18StatusMock.mockResolvedValue({ isMinor: true });
  });

  /** Tick the consent box once the stored U18 status has landed. */
  async function tickConsent() {
    await waitFor(() => expect(getU18StatusMock).toHaveBeenCalledWith('blue_dot'));
    await ui().click(await screen.findByRole('checkbox', { name: /agree/i }));
  }

  /** Tick consent, then confirm the interstitial so the OTP is issued. */
  async function tickAndSendCode() {
    await tickConsent();
    const notice = await screen.findByRole('dialog');
    fireEvent.click(within(notice).getByRole('button', { name: /send code to guardian/i }));
  }

  function typeOtp(digits: string) {
    const inputs = screen.getAllByRole('textbox');
    digits.split('').forEach((d, i) => {
      fireEvent.change(inputs[i], { target: { value: d } });
    });
  }

  it('blocks creation until the guardian verifies, then creates and finalizes the consent', async () => {
    await renderPage();

    const submit = await screen.findByRole('button', { name: 'Save & publish' });
    expect(submit).toBeDisabled();

    await tickConsent();

    // Ticking explains what is about to happen — no code has been sent yet.
    const notice = await screen.findByRole('dialog');
    expect(notice).toHaveTextContent('Guardian confirmation needed');
    expect(issueOtpMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/your guardian must verify with a one-time code/i),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.click(within(notice).getByRole('button', { name: /send code to guardian/i }));

    await waitFor(() =>
      expect(issueOtpMock).toHaveBeenCalledWith({
        network: 'blue_dot',
        brand: null,
        item_domain: 'seeker',
      }),
    );
    expect(await screen.findByText(OTP_TITLE)).toBeInTheDocument();

    typeOtp('123456');

    await waitFor(() =>
      expect(verifyOtpMock).toHaveBeenCalledWith({
        network: 'blue_dot',
        brand: null,
        item_domain: 'seeker',
        otp: '123456',
      }),
    );
    expect(
      await screen.findByText('Guardian verified. You can now create your profile.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument());

    const publish = screen.getByRole('button', { name: 'Save & publish' });
    await waitFor(() => expect(publish).toBeEnabled());
    await ui().click(publish);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    expect(createItemMock.mock.calls[0][0]).toMatchObject({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      consent: { category: 'profile_creation', version: 1, brand: null },
    });
    // The pre-create token is consumed AFTER the draft exists, to promote it.
    await waitFor(() =>
      expect(finalizeMock).toHaveBeenCalledWith({
        network: 'blue_dot',
        brand: null,
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_id: 'new-1',
      }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/?network=blue_dot'));
    expect(await screen.findByText('Profile created!')).toBeInTheDocument();
  });

  it('backing out of the interstitial sends no code and unticks consent', async () => {
    await renderPage();
    await tickConsent();

    const notice = await screen.findByRole('dialog');
    fireEvent.click(within(notice).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(issueOtpMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('checkbox', { name: /agree/i })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save & publish' })).toBeDisabled();
  });

  it('closing the OTP dialog unverified unticks consent so re-ticking re-issues the code', async () => {
    await renderPage();
    await tickAndSendCode();
    await screen.findByText(OTP_TITLE);

    const otpDialog = screen.getByRole('dialog');
    fireEvent.click(within(otpDialog).getByRole('button', { name: /close/i }));

    await waitFor(() => expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument());
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('checkbox', { name: /agree/i })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save & publish' })).toBeDisabled();
  });

  it('offers a sign-out escape from the OTP challenge', async () => {
    await renderPage();
    await tickAndSendCode();
    await screen.findByText(OTP_TITLE);

    fireEvent.click(screen.getByRole('button', { name: /not you\?/i }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('no guardian on file yet (409) runs the capture flow, then retries the OTP', async () => {
    issueOtpMock.mockRejectedValueOnce(axiosError(409, { error: 'GUARDIAN_REQUIRED' }));

    await renderPage();
    await tickAndSendCode();

    const setup = await screen.findByTestId('u18-setup-flow');
    expect(setup.getAttribute('data-initial-step')).toBe('guardian');
    expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument();

    fireEvent.click(within(setup).getByRole('button', { name: 'guardian captured' }));

    await waitFor(() => expect(issueOtpMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(OTP_TITLE)).toBeInTheDocument();
    expect(screen.queryByTestId('u18-setup-flow')).not.toBeInTheDocument();
  });

  it('a capture flow that resolves the ward as an adult just closes, sending no code', async () => {
    issueOtpMock.mockRejectedValueOnce(axiosError(409, { error: 'GUARDIAN_REQUIRED' }));

    await renderPage();
    await tickAndSendCode();

    const setup = await screen.findByTestId('u18-setup-flow');
    fireEvent.click(within(setup).getByRole('button', { name: 'not a minor' }));

    await waitFor(() => expect(screen.queryByTestId('u18-setup-flow')).not.toBeInTheDocument());
    expect(issueOtpMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument();
  });

  it('a rate-limited OTP issue (429) is reported and opens no challenge', async () => {
    issueOtpMock.mockRejectedValueOnce(axiosError(429, { error: 'RATE_LIMITED' }));

    await renderPage();
    await tickAndSendCode();

    expect(await screen.findByText('Too many attempts. Please try again shortly.')).toBeInTheDocument();
    expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & publish' })).toBeDisabled();
  });

  it('an unavailable OTP provider (503) is reported and opens no challenge', async () => {
    issueOtpMock.mockRejectedValueOnce(axiosError(503, { error: 'OTP_PROVIDER_UNAVAILABLE' }));

    await renderPage();
    await tickAndSendCode();

    expect(await screen.findByText(/available on this instance right now/i)).toBeInTheDocument();
    expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument();
  });

  it('a non-HTTP failure falls back to the generic error copy', async () => {
    issueOtpMock.mockRejectedValueOnce(new Error('network down'));

    await renderPage();
    await tickAndSendCode();

    expect(await screen.findByText(/An unexpected error occurred/)).toBeInTheDocument();
    expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument();
  });

  it('does not open the challenge when the server reports no code was sent', async () => {
    issueOtpMock.mockResolvedValueOnce({ otpSent: false });

    await renderPage();
    await tickAndSendCode();

    await waitFor(() => expect(issueOtpMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(OTP_TITLE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & publish' })).toBeDisabled();
  });
});
