import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';

// W5.4a — profile-form-page has no `<main>` landmark and its heading is an
// `<h2>` (no `<h1>` anywhere on the page). This test asserts the accessible
// structure a screen-reader user relies on: exactly one `main` landmark and
// exactly one level-1 heading. It fails against the current markup.

const NETWORK: DotNetworkSchema = {
  id: 'blue_dot',
  display_name: 'Blue Dots',
  description: 'test network',
  schema_standard: '1.0',
  domains: [
    { id: 'seeker', description: 'Job seeker' },
  ],
  actions: {},
};

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => ({ data: [NETWORK], isLoading: false, isError: false }),
  useResolvedNetwork: () => ({ data: NETWORK, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
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
    signOut: vi.fn(),
  }),
}));

vi.mock('@/lib/served-binding', async (orig) => ({
  ...(await orig<typeof import('@/lib/served-binding')>()),
  // A single served domain skips the role picker entirely, landing directly
  // on the form view whose heading/landmark this test is asserting on.
  getServedScope: () => ({ network: 'blue_dot', domains: ['seeker'] }),
}));

vi.mock('@/lib/user-api', () => ({
  getUserDomains: () => Promise.resolve(['seeker']),
}));

vi.mock('@/lib/consent-api', () => ({
  getU18Status: () => Promise.resolve({ isMinor: false }),
  issueProfilePrecreateOtp: vi.fn(),
  verifyProfilePrecreateOtp: vi.fn(),
  finalizeProfileConsent: vi.fn(),
}));

async function renderPage() {
  const { ProfileFormPage } = await import('../profile-form-page');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/profile/new']}>
        <ProfileFormPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProfileFormPage landmarks + heading order (W5.4a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a single main landmark', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());
  });

  it('renders exactly one level-1 heading', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1));
  });
});
