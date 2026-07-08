import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const checkUser = vi.fn();
const requestOtp = vi.fn();
const fetchAuthConfig = vi.fn();

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
    // "Contact your aggregator" is produced only by the signup-gate branch (inline
    // signup_disabled_message + toast_signup_disabled_desc) — asserting on it (rather
    // than just requestOtp not being called) distinguishes the gate from the
    // separate name-required guard, which also skips requestOtp but never renders
    // this message.
    expect(await screen.findAllByText(/contact your aggregator/i)).not.toHaveLength(0);
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
    expect(await screen.findAllByText(/contact your aggregator/i)).not.toHaveLength(0);

    checkUser.mockResolvedValueOnce({ userExists: true });
    await userEvent.clear(input);
    await userEvent.type(input, '9123456789');
    await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

    await waitFor(() => expect(checkUser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(requestOtp).toHaveBeenCalled());
    expect(screen.queryByText(/contact your aggregator/i)).toBeNull();
  });
});
