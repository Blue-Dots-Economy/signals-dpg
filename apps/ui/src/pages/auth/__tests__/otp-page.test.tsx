import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const verifyOtp = vi.fn();
const signOut = vi.fn();
const getU18Status = vi.fn();
const navigateMock = vi.fn();
const fetchMyProfilesLite = vi.fn();

// Mutable location state the page reads (set per test before render).
let currentState: Record<string, unknown> | null = null;

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ verifyOtp, signOut }),
}));
vi.mock('@/theme/theme-provider', async () => {
  const { resolveTheme } = await import('@/theme/network-themes');
  return {
    useNetworkTheme: () => ({ themeId: 'blue_dot', theme: resolveTheme('blue_dot'), brand: 'standard' }),
  };
});
vi.mock('@/lib/consent-api', () => ({
  acceptConsent: vi.fn().mockResolvedValue(undefined),
  submitU18Dob: vi.fn().mockResolvedValue(undefined),
  getU18Status: (...a: unknown[]) => getU18Status(...a),
}));
vi.mock('@/lib/served-binding', () => ({ getServedScope: () => null }));
vi.mock('@/lib/user-api', () => ({ setUserDomains: vi.fn().mockResolvedValue(undefined) }));
// #376: post-login profile check. Default (set in beforeEach) is a live
// profile → lands on home; individual tests override to exercise the redirect.
vi.mock('@/lib/login-profiles', () => ({
  fetchMyProfilesLite: (...a: unknown[]) => fetchMyProfilesLite(...a),
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
  useLocation: () => ({ state: currentState }),
}));
// Stub the guardian flow — assert OtpPage's wiring (does it render it, with
// which step, and does it hold back home?) without the child's internals.
vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (p: { initialStep?: string }) => (
    <div data-testid="u18-guardian-flow" data-step={p.initialStep} />
  ),
}));
// Stub the OTP input to a single button that submits a code.
vi.mock('@/components/auth/otp-input', () => ({
  OtpInput: (p: { onComplete: (otp: string) => void }) => (
    <button data-testid="otp-submit" onClick={() => p.onComplete('000000')}>submit</button>
  ),
}));

import { OtpPage } from '@/pages/auth/otp-page';

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OtpPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyOtp.mockResolvedValue(undefined);
  // Default: user already has a completed (live) profile → no redirect, land home.
  fetchMyProfilesLite.mockResolvedValue([
    { item_id: 'p1', item_domain: 'seeker', lifecycle_status: 'live' },
  ]);
});

describe('OtpPage — existing-minor guardian gate (#453)', () => {
  it('holds an existing unverified minor on the guardian flow instead of home', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ hasBirthData: true, isMinor: true, guardianVerified: false });

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(screen.getByTestId('u18-guardian-flow')).toBeInTheDocument());
    // Birth data already stored → skip the DOB step.
    expect(screen.getByTestId('u18-guardian-flow').getAttribute('data-step')).toBe('guardian');
    // Must NOT have navigated to home.
    expect(navigateMock).not.toHaveBeenCalledWith('/', { replace: true });
  });

  it('starts the guardian flow at the DOB step when no birth data is stored', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ hasBirthData: false, isMinor: true, guardianVerified: false });

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(screen.getByTestId('u18-guardian-flow')).toBeInTheDocument());
    expect(screen.getByTestId('u18-guardian-flow').getAttribute('data-step')).toBe('dob');
  });

  it('sends an existing adult straight to home (no guardian flow)', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ hasBirthData: true, isMinor: false, guardianVerified: false });

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(screen.queryByTestId('u18-guardian-flow')).not.toBeInTheDocument();
  });

  it('does not gate an already guardian-verified minor', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ hasBirthData: true, isMinor: true, guardianVerified: true });

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(screen.queryByTestId('u18-guardian-flow')).not.toBeInTheDocument();
  });

  it('does not run the u18 status check for a brand-new signup', async () => {
    currentState = { userExists: false, phoneNumber: '+911234', name: 'New User' };

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(getU18Status).not.toHaveBeenCalled();
  });
});

describe('OtpPage — first-time profile redirect (#376)', () => {
  it('sends a user with no completed profile to the create page', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ isMinor: false });
    fetchMyProfilesLite.mockResolvedValue([]); // no profiles

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/profile/new', { replace: true }));
    expect(navigateMock).not.toHaveBeenCalledWith('/', { replace: true });
  });

  it('sends a user with only a draft profile to that draft\'s edit page', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ isMinor: false });
    fetchMyProfilesLite.mockResolvedValue([
      { item_id: 'draft1', item_domain: 'seeker', lifecycle_status: 'draft' },
    ]);

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/profile/draft1/edit', { replace: true }));
  });

  it('a retired-only user stays on the map (retired counts as already set up)', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ isMinor: false });
    // fetchMyProfilesLite includes retired (via include_retired), so a retired
    // profile is seen here and the user is NOT nudged to create a new one.
    fetchMyProfilesLite.mockResolvedValue([
      { item_id: 'r1', item_domain: 'seeker', lifecycle_status: 'retired' },
    ]);

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(navigateMock).not.toHaveBeenCalledWith('/profile/new', { replace: true });
  });

  it('fails open: if the profile fetch rejects, lands normally (does not get stuck)', async () => {
    currentState = { userExists: true, phoneNumber: '+911234' };
    getU18Status.mockResolvedValue({ isMinor: false });
    fetchMyProfilesLite.mockRejectedValue(new Error('network down'));

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    // The redirect check is best-effort — a fetch failure must not block login;
    // the user still lands on the normal destination (home here).
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(navigateMock).not.toHaveBeenCalledWith('/profile/new', { replace: true });
  });

  it('the first-time redirect takes precedence over a stored redirectTo deep link', async () => {
    currentState = { userExists: true, phoneNumber: '+911234', redirectTo: '/some/deep/link' };
    getU18Status.mockResolvedValue({ isMinor: false });
    fetchMyProfilesLite.mockResolvedValue([]); // no profiles → /profile/new

    renderPage();
    await userEvent.click(screen.getByTestId('otp-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/profile/new', { replace: true }));
    expect(navigateMock).not.toHaveBeenCalledWith('/some/deep/link', { replace: true });
  });
});
