import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { ConsentConfigDocument } from '@dpg/schemas';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

// --- Mocks -----------------------------------------------------------------
//
// Everything below the components under test that talks to the network is
// mocked at the `@/lib/consent-api` boundary (one shared axios instance lives
// under it — never mock axios internals). The consent-config hook and the
// network theme are mocked because they're plain config reads the flows only
// consume; `sonner` stays REAL so toast copy is asserted in the DOM via a
// mounted <Toaster />.

const consentConfigState = vi.hoisted(() => ({
  config: null as unknown,
  isLoading: false,
}));
const themeState = vi.hoisted(() => ({ themeId: 'blue_dot', brand: 'standard' }));
const authState = vi.hoisted(() => ({ signOut: vi.fn() }));
// Props captured from the mocked guardian dialog / capture flow so the tests can
// drive the callbacks exactly as the real components would.
const captured = vi.hoisted(() => ({
  otp: null as null | {
    onSubmitOtp: (otp: string) => Promise<void>;
    onOpenChange: (open: boolean) => void;
    onLogout: () => void;
  },
  flow: null as null | { onComplete: () => void; onNotMinor: () => void; onLogout: () => void },
}));

vi.mock('@/lib/consent-api', () => ({
  startSignupGuardian: vi.fn(),
  verifySignupGuardian: vi.fn(),
  submitGuardian: vi.fn(),
  verifyGuardian: vi.fn(),
  getConsentStatus: vi.fn(),
  acceptProfileConsent: vi.fn(),
  issueProfileConsentOtp: vi.fn(),
  verifyProfileConsentOtp: vi.fn(),
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({
    config: consentConfigState.config,
    isLoading: consentConfigState.isLoading,
  }),
}));

vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({
    themeId: themeState.themeId,
    brand: themeState.brand,
    theme: { name: 'Blue Dot' },
  }),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    // Deliberately DIFFERENT from the signup identifiers used below: the
    // pre-auth signup flow must compare against the ward's signup identifier,
    // not a session user (there is no session yet).
    user: { email: 'session@example.com', phoneNumber: '+919111111111' },
    signOut: authState.signOut,
  }),
}));

vi.mock('@/components/actions/guardian-otp-dialog', () => ({
  GuardianOtpDialog: (props: {
    open: boolean;
    onSubmitOtp: (otp: string) => Promise<void>;
    onOpenChange: (open: boolean) => void;
    onLogout: () => void;
  }) => {
    captured.otp = {
      onSubmitOtp: props.onSubmitOtp,
      onOpenChange: props.onOpenChange,
      onLogout: props.onLogout,
    };
    return props.open ? <div data-testid="guardian-otp-dialog">Enter guardian code</div> : null;
  },
}));

vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (props: {
    onComplete: () => void;
    onNotMinor: () => void;
    onLogout: () => void;
  }) => {
    captured.flow = {
      onComplete: props.onComplete,
      onNotMinor: props.onNotMinor,
      onLogout: props.onLogout,
    };
    return <div data-testid="u18-guardian-capture">Guardian capture</div>;
  },
}));

import {
  startSignupGuardian,
  verifySignupGuardian,
  getConsentStatus,
  acceptProfileConsent,
  issueProfileConsentOtp,
  verifyProfileConsentOtp,
} from '@/lib/consent-api';
import { SignupGuardianFlow } from '@/components/consent/u18/signup-guardian-flow';
import { useConsentGate } from '@/hooks/use-consent-gate';
import {
  useProfileConsentAccept,
  type UseProfileConsentAcceptResult,
} from '@/hooks/use-profile-consent-accept';

// --- Fixtures --------------------------------------------------------------

function contentDoc(version: number, title: string, content: string) {
  return {
    current_version: version,
    versions: [{ version, title, content, effective_from: '2024-01-01' }],
  };
}

function statementDoc(statement: string) {
  return {
    current_version: 1,
    versions: [{ version: 1, statement, effective_from: '2024-01-01' }],
  };
}

/** Consent config with a distinct U18 document set (spec D9) so the guardian
 * gate can be checked for showing the minor copy, not the adult copy. */
const u18ConsentConfig: ConsentConfigDocument = {
  documents: {
    terms: contentDoc(1, 'Adult Terms v1', 'Adult terms body.'),
    privacy: contentDoc(1, 'Adult Privacy v1', 'Adult privacy body.'),
    profile_creation: statementDoc('I agree to create a profile.'),
  },
  u18_documents: {
    terms: contentDoc(1, 'U18 Terms v1', 'Guardian-facing under-18 terms.'),
    privacy: contentDoc(1, 'U18 Privacy v1', 'Guardian-facing under-18 privacy.'),
    profile_creation: statementDoc('Guardian confirms this profile.'),
    guardian_declaration: statementDoc('I declare these are my guardian details.'),
  },
};

/** Consent config whose terms/privacy sit at the given current versions — the
 * only part `useConsentGate` reads. */
function gateConfig(termsVersion: number, privacyVersion: number): ConsentConfigDocument {
  return {
    documents: {
      terms: contentDoc(termsVersion, `Terms v${termsVersion}`, 'terms body'),
      privacy: contentDoc(privacyVersion, `Privacy v${privacyVersion}`, 'privacy body'),
      profile_creation: statementDoc('I agree to create a profile.'),
    },
  };
}

function axiosError(status: number, code?: string) {
  return Object.assign(new Error(`http ${status}`), {
    isAxiosError: true,
    response: { status, data: code ? { error: code } : {} },
  });
}

// Reset every piece of shared module state before EVERY test in the file, so no
// describe depends on another having run (the suite is also run file-parallel).
beforeEach(() => {
  vi.clearAllMocks();
  themeState.themeId = 'blue_dot';
  themeState.brand = 'standard';
  consentConfigState.config = null;
  consentConfigState.isLoading = false;
  captured.otp = null;
  captured.flow = null;
});

// --- SignupGuardianFlow (pre-auth, during signup) --------------------------

function renderSignupFlow(
  overrides: Partial<React.ComponentProps<typeof SignupGuardianFlow>> = {},
) {
  const props: React.ComponentProps<typeof SignupGuardianFlow> = {
    network: 'blue_dot',
    domain: 'student',
    brand: 'standard',
    identifier: { email: 'ward@example.com' },
    age: 16,
    onComplete: vi.fn(),
    ...overrides,
  };
  render(
    <>
      <Toaster />
      <SignupGuardianFlow {...props} />
    </>,
  );
  return props;
}

/** Fill the guardian form with a name + a guardian phone that is NOT the ward's. */
function fillGuardian(phone = '9876543210') {
  fireEvent.change(screen.getByLabelText(/guardian name/i), {
    target: { value: 'Asha Guardian' },
  });
  fireEvent.change(screen.getByLabelText(/guardian phone number/i), { target: { value: phone } });
}

function typeOtp(digits: string) {
  const inputs = screen.getAllByRole('textbox');
  digits.split('').forEach((d, i) => {
    fireEvent.change(inputs[i], { target: { value: d } });
  });
}

/**
 * Distance from a real desktop dialog's top edge to the reader (header +
 * progress tracker + border + padding) — matches production geometry
 * measured directly in Chromium (see task-3-report.md, fix round 3).
 * Stubbed via `getBoundingClientRect`, NOT `offsetTop`/`offsetHeight`:
 * offsetTop is relative to the nearest *positioned* ancestor (this dialog's
 * own `fixed` wrapper, not the scroller), which made the gate permanently
 * unreachable in every real browser while offsetTop-based stubs stayed
 * green here.
 */
const READER_VIEWPORT_TOP = 149;

function stubRect(el: Element, top: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () =>
      ({
        top,
        height,
        bottom: top + height,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
    configurable: true,
  });
}

describe('SignupGuardianFlow (pre-auth U18 signup)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs guardian details → guardian OTP → explicit hand-off to the ward\'s own verification', async () => {
    vi.mocked(startSignupGuardian).mockResolvedValue({ otpSent: true });
    vi.mocked(verifySignupGuardian).mockResolvedValue({ verified: true });
    const onComplete = vi.fn();
    renderSignupFlow({ onComplete });

    // Step 1: guardian details, with the under-18 explanation.
    expect(screen.getByRole('heading', { name: /guardian details/i })).toBeInTheDocument();
    expect(screen.getByText(/you're under 18/i)).toBeInTheDocument();

    fillGuardian();
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // The ward's signup identifier + age (not a session) go on the wire; the
    // brand is not part of the pre-auth signup body.
    await waitFor(() =>
      expect(startSignupGuardian).toHaveBeenCalledWith({
        network: 'blue_dot',
        domain: 'student',
        email: 'ward@example.com',
        age: 16,
        guardianName: 'Asha Guardian',
        guardianPhone: '+919876543210',
        guardianDeclarationAccepted: true,
      }),
    );

    // Step 2: guardian OTP.
    expect(
      await screen.findByRole('heading', { name: /confirm with your guardian/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/guardian name/i)).not.toBeInTheDocument();

    typeOtp('123456');
    await waitFor(() =>
      expect(verifySignupGuardian).toHaveBeenCalledWith({
        network: 'blue_dot',
        email: 'ward@example.com',
        otp: '123456',
      }),
    );

    // Step 3: an EXPLICIT hand-off — the ward's own verification never starts
    // silently, they have to click Continue.
    expect(
      await screen.findByRole('heading', { name: /guardian confirmed/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/verify your account to finish signing up/i)).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('compares the guardian contact against the ward\'s SIGNUP identifier, not any session user', async () => {
    renderSignupFlow({ identifier: { phoneNumber: '+919000000000' } });

    // The mocked session user's phone (+919111111111) is irrelevant pre-auth —
    // it must NOT be treated as the ward's own contact.
    fillGuardian('9111111111');
    expect(screen.queryByText(/can't be the same as your own/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();

    // The signup phone itself is a hard block — a ward can't be their own guardian.
    fireEvent.change(screen.getByLabelText(/guardian phone number/i), {
      target: { value: '9000000000' },
    });
    expect(screen.getByText(/can't be the same as your own/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(startSignupGuardian).not.toHaveBeenCalled();
  });

  it('gates the send behind the blocking U18 consent popup and only then submits', async () => {
    consentConfigState.config = u18ConsentConfig;
    vi.mocked(startSignupGuardian).mockResolvedValue({ otpSent: true });
    renderSignupFlow();

    fillGuardian();
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // Nothing is sent yet: the guardian must read + accept first.
    expect(startSignupGuardian).not.toHaveBeenCalled();
    expect(screen.getByText(/review & accept to continue/i)).toBeInTheDocument();
    // The U18 document set is what's shown, not the adult copy.
    expect(screen.getByText('Guardian-facing under-18 terms.')).toBeInTheDocument();
    expect(screen.queryByText('Adult terms body.')).not.toBeInTheDocument();

    // The checkbox only unlocks once the reader has scrolled through every
    // document (`useReadProgress`); happy-dom lays nothing out, so stub the
    // scroller as fully read, the same technique consent-gate.test.tsx uses.
    const reader = screen.getByTestId('consent-reader');
    Object.defineProperty(reader, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(reader, 'clientHeight', { value: 200, configurable: true });

    function stubReaderAt(scrollTop: number) {
      Object.defineProperty(reader, 'scrollTop', {
        value: scrollTop,
        writable: true,
        configurable: true,
      });
      stubRect(reader, READER_VIEWPORT_TOP, 200);
      for (const [id, contentTop] of [['privacy', 0], ['terms', 300]] as const) {
        const section = reader.querySelector<HTMLElement>(`[data-consent-section="${id}"]`)!;
        stubRect(section, READER_VIEWPORT_TOP + contentTop - scrollTop, 300);
      }
      fireEvent.scroll(reader);
    }

    // Fix round 3 regression pin: with REAL (non-zero, getBoundingClientRect
    // -based) geometry and the reader genuinely NOT yet scrolled, the
    // checkbox must stay locked -- an offsetTop-based regression (reading
    // position relative to the dialog's own `fixed` wrapper instead of the
    // scroller) would have unlocked it here regardless of scroll position.
    stubReaderAt(0);
    expect(screen.getByRole('checkbox')).toBeDisabled();

    stubReaderAt(400);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /accept & continue/i }));

    await waitFor(() => expect(startSignupGuardian).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole('heading', { name: /confirm with your guardian/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/review & accept to continue/i)).not.toBeInTheDocument();
  });

  it('keeps the ward on the guardian step with an inline error on 409 GUARDIAN_WARD_LIMIT', async () => {
    vi.mocked(startSignupGuardian).mockRejectedValue(axiosError(409, 'GUARDIAN_WARD_LIMIT'));
    renderSignupFlow();

    fillGuardian();
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/already linked to the maximum number of accounts/i)).toBeInTheDocument();
    // Still on the guardian step — no OTP step, so no dead end.
    expect(screen.getByRole('heading', { name: /guardian details/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/guardian name/i)).toHaveValue('Asha Guardian');
  });

  it('offers Back to the birth-year step without sending anything', async () => {
    const onBack = vi.fn();
    renderSignupFlow({ onBack });
    await userEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(startSignupGuardian).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /guardian details/i })).toBeInTheDocument();
  });

  it('does not offer Back when no onBack is given', () => {
    renderSignupFlow();
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
  });

  it('resends by re-submitting the captured guardian details (no re-collection)', async () => {
    // Fake timers: the resend control only appears once the 60s countdown ends.
    // RTL's waitFor can't see fake timers, so this test uses fireEvent + act only.
    vi.useFakeTimers();
    vi.mocked(startSignupGuardian).mockResolvedValue({ otpSent: true });
    renderSignupFlow();

    fillGuardian();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    expect(startSignupGuardian).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/resend code in 60s/i)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /resend code/i }));
      await Promise.resolve();
    });

    expect(startSignupGuardian).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(startSignupGuardian).mock.calls;
    expect(calls[1][0]).toEqual(calls[0][0]);
    // Countdown restarts, so the button can't be hammered.
    expect(screen.getByText(/resend code in 60s/i)).toBeInTheDocument();
  });
});

// --- useConsentGate --------------------------------------------------------

let gateClient: QueryClient;
function gateWrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={gateClient}>{children}</QueryClientProvider>;
}

describe('useConsentGate', () => {
  beforeEach(() => {
    gateClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('needs every category whose CURRENT version the user has not accepted', async () => {
    consentConfigState.config = gateConfig(2, 3);
    // The ward accepted terms v1 (superseded) and privacy v3 (current).
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [1], privacy: [3] } });

    const { result } = renderHook(() => useConsentGate(), { wrapper: gateWrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.needed).toEqual(['terms']);
    expect(result.current.currentVersions).toEqual({ terms: 2, privacy: 3 });
    expect(getConsentStatus).toHaveBeenCalledWith('blue_dot');
  });

  it('needs both categories when neither current version is on record', async () => {
    consentConfigState.config = gateConfig(1, 1);
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [], privacy: [] } });

    const { result } = renderHook(() => useConsentGate(), { wrapper: gateWrapper });

    await waitFor(() => expect(result.current.needed).toEqual(['terms', 'privacy']));
  });

  it('gates nothing once both current versions are accepted', async () => {
    consentConfigState.config = gateConfig(2, 2);
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [1, 2], privacy: [2] } });

    const { result } = renderHook(() => useConsentGate(), { wrapper: gateWrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.needed).toEqual([]);
  });

  it('gates nothing (and exposes no versions) while the consent config is unavailable', async () => {
    consentConfigState.config = null;
    consentConfigState.isLoading = true;
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [], privacy: [] } });

    const { result } = renderHook(() => useConsentGate(), { wrapper: gateWrapper });

    // Fail-open on the GATE (never block on a config we couldn't read) but with
    // no derived versions to accept against.
    expect(result.current.needed).toEqual([]);
    expect(result.current.currentVersions).toBeNull();
    expect(result.current.config).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(getConsentStatus).toHaveBeenCalled());
  });

  it('does not read consent status until a network id is known', async () => {
    consentConfigState.config = gateConfig(1, 1);
    themeState.themeId = '';
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [], privacy: [] } });

    const { result } = renderHook(() => useConsentGate(), { wrapper: gateWrapper });

    await waitFor(() => expect(result.current.needed).toEqual([]));
    expect(getConsentStatus).not.toHaveBeenCalled();
  });

  it('refetch re-reads status so the gate clears after an acceptance', async () => {
    consentConfigState.config = gateConfig(2, 1);
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [1], privacy: [1] } });

    const { result } = renderHook(() => useConsentGate(), { wrapper: gateWrapper });
    await waitFor(() => expect(result.current.needed).toEqual(['terms']));

    // The user accepts terms v2 elsewhere; the gate must clear on refetch.
    vi.mocked(getConsentStatus).mockResolvedValue({ statuses: { terms: [1, 2], privacy: [1] } });
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.needed).toEqual([]));
    expect(getConsentStatus).toHaveBeenCalledTimes(2);
  });
});

// --- useProfileConsentAccept ----------------------------------------------

const network = 'blue_dot';
// Raw network config as cached by useNetworkConfig: `guardian_consent_required`
// is a plain domain field the hook reads straight from the cache.
const rawNetworkConfig = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'browse', guardian_consent_required: false },
  ],
} as unknown as DotNetworkSchema;

let acceptClient: QueryClient;
function acceptWrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={acceptClient}>{children}</QueryClientProvider>;
}

let hookResult: UseProfileConsentAcceptResult;
/** Mounts the hook AND its `dialogs` node (renderHook alone never renders it),
 * plus a real sonner Toaster so toast copy is observable in the DOM. */
function AcceptHarness() {
  hookResult = useProfileConsentAccept();
  return (
    <>
      <Toaster />
      {hookResult.dialogs}
    </>
  );
}

function minorArgs(itemId: string, domain = 'seeker', extra: Record<string, unknown> = {}) {
  return {
    network,
    brand: null,
    item: { item_id: itemId, item_domain: domain, item_type: 'profile_1.0' },
    version: 1,
    isMinor: true,
    onDone: vi.fn(),
    ...extra,
  };
}

describe('useProfileConsentAccept — gating and failure branches', () => {
  beforeEach(() => {
    acceptClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    acceptClient.setQueryData(queryKeys.networkConfig(network), rawNetworkConfig);
  });

  it('a minor on an UNGATED domain self-accepts and is told the profile is live', async () => {
    vi.mocked(acceptProfileConsent).mockResolvedValue({ recorded: 1 });
    const onDone = vi.fn();
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-ungated', 'browse', { onDone }));
    });

    expect(issueProfileConsentOtp).not.toHaveBeenCalled();
    expect(acceptProfileConsent).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'p-ungated', item_domain: 'browse', version: 1 }),
    );
    // draft → live promotion (#464): the consented id is seeded into the cache
    // and the user is told, once.
    expect(acceptClient.getQueryData(queryKeys.profileConsent(network))).toEqual(
      new Set(['p-ungated']),
    );
    expect(await screen.findByText(/your profile is now live/i)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(hookResult.guardianActive).toBe(false);
  });

  it('fails CLOSED when the network config is not cached: a minor never self-accepts', async () => {
    acceptClient.removeQueries({ queryKey: queryKeys.networkConfig(network) });
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: true });
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-noconfig'));
    });

    expect(acceptProfileConsent).not.toHaveBeenCalled();
    expect(issueProfileConsentOtp).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'p-noconfig' }),
    );
    expect(await screen.findByTestId('guardian-otp-dialog')).toBeInTheDocument();
  });

  it('surfaces an unavailable message (not silence) when the server sends no code', async () => {
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: false });
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-nosend'));
    });

    expect(await screen.findByText(/isn't available on this instance right now/i)).toBeInTheDocument();
    // Nothing opened, so the user isn't stuck behind an empty dialog.
    expect(screen.queryByTestId('guardian-otp-dialog')).not.toBeInTheDocument();
    expect(hookResult.guardianActive).toBe(false);
  });

  it('tells the ward to retry later when guardian OTP issuing is rate limited (429)', async () => {
    vi.mocked(issueProfileConsentOtp).mockRejectedValue(axiosError(429));
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-429'));
    });

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-otp-dialog')).not.toBeInTheDocument();
    expect(acceptProfileConsent).not.toHaveBeenCalled();
  });

  it('reports an unconfigured instance when guardian OTP issuing returns 503', async () => {
    vi.mocked(issueProfileConsentOtp).mockRejectedValue(axiosError(503, 'NO_OTP_PROVIDER'));
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-503'));
    });

    expect(await screen.findByText(/isn't available on this instance right now/i)).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-otp-dialog')).not.toBeInTheDocument();
  });

  it('falls back to the generic error for an unexpected issuing failure', async () => {
    vi.mocked(issueProfileConsentOtp).mockRejectedValue(axiosError(500));
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-500'));
    });

    expect(await screen.findByText(/an unexpected error occurred/i)).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-otp-dialog')).not.toBeInTheDocument();
  });

  it('a failed adult self-accept errors without recording consent or finishing', async () => {
    vi.mocked(acceptProfileConsent).mockRejectedValue(axiosError(500));
    const onDone = vi.fn();
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept({
        network,
        brand: null,
        item: { item_id: 'p-adult-fail', item_domain: 'seeker', item_type: 'profile_1.0' },
        version: 1,
        isMinor: false,
        onDone,
      });
    });

    expect(await screen.findByText(/an unexpected error occurred/i)).toBeInTheDocument();
    // The caller keeps its own prompt open to retry: no onDone, no cache seed.
    expect(onDone).not.toHaveBeenCalled();
    expect(acceptClient.getQueryData(queryKeys.profileConsent(network))).toBeUndefined();
    expect(hookResult.isPending).toBe(false);
  });

  it('capturing a guardian re-issues the OTP and signals a U18-status re-sync', async () => {
    vi.mocked(issueProfileConsentOtp)
      .mockRejectedValueOnce(axiosError(409, 'GUARDIAN_REQUIRED'))
      .mockResolvedValue({ otpSent: true });
    const onGuardianStatusChanged = vi.fn();
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-capture', 'seeker', { onGuardianStatusChanged }));
    });

    // No guardian on file → the capture flow opens instead of the OTP dialog.
    expect(await screen.findByTestId('u18-guardian-capture')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-otp-dialog')).not.toBeInTheDocument();
    expect(hookResult.guardianActive).toBe(true);

    await act(async () => {
      captured.flow!.onComplete();
    });

    expect(onGuardianStatusChanged).toHaveBeenCalledTimes(1);
    expect(issueProfileConsentOtp).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId('guardian-otp-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('u18-guardian-capture')).not.toBeInTheDocument();
    // Still never a ward self-accept.
    expect(acceptProfileConsent).not.toHaveBeenCalled();
  });

  it('dismissing the guardian OTP dialog releases the guardian lock', async () => {
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: true });
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-dismiss'));
    });
    expect(await screen.findByTestId('guardian-otp-dialog')).toBeInTheDocument();
    expect(hookResult.guardianActive).toBe(true);

    await act(async () => {
      captured.otp!.onOpenChange(false);
    });

    expect(screen.queryByTestId('guardian-otp-dialog')).not.toBeInTheDocument();
    expect(hookResult.guardianActive).toBe(false);
    expect(verifyProfileConsentOtp).not.toHaveBeenCalled();
  });

  it('an invalid guardian code keeps the dialog open and records nothing', async () => {
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: true });
    vi.mocked(verifyProfileConsentOtp).mockRejectedValue(axiosError(400, 'INVALID_OTP'));
    const onDone = vi.fn();
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-badotp', 'seeker', { onDone }));
    });
    expect(await screen.findByTestId('guardian-otp-dialog')).toBeInTheDocument();

    // The hook must NOT swallow the error — the dialog shows its own inline
    // error and stays open for a retry.
    await expect(
      act(async () => {
        await captured.otp!.onSubmitOtp('000000');
      }),
    ).rejects.toThrow();

    expect(screen.getByTestId('guardian-otp-dialog')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(acceptClient.getQueryData(queryKeys.profileConsent(network))).toBeUndefined();
  });

  it('logging out from the guardian dialog signs the ward out', async () => {
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: true });
    render(<AcceptHarness />, { wrapper: acceptWrapper });

    await act(async () => {
      await hookResult.accept(minorArgs('p-logout'));
    });
    expect(await screen.findByTestId('guardian-otp-dialog')).toBeInTheDocument();

    act(() => {
      captured.otp!.onLogout();
    });

    expect(authState.signOut).toHaveBeenCalledTimes(1);
  });
});

