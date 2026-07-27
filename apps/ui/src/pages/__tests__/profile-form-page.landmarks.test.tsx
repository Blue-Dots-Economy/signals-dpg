import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';

// W5.4a — profile-form-page has no `<main>` landmark and its heading is an
// `<h2>` (no `<h1>` anywhere on the page). This test asserts the accessible
// structure a screen-reader user relies on: exactly one `main` landmark and
// exactly one level-1 heading, on both mutually-exclusive branches the page
// can render, AND (the review-round addition) that the full heading chain —
// including the shared SchemaForm's `<h3>` section titles — never skips a
// level.

const NO_SCHEMA_DOMAIN = { id: 'seeker', description: 'Job seeker' };

// A minimal item schema carrying its own `x-form-layout` (schema-driven
// sectioning — see schema-form.tsx) so SchemaForm's SectionedObjectFieldTemplate
// renders a real `<h3>` section title ("About You"), exactly as production
// schemas do (see examples/schemas/yellow_dot/network.json).
const SCHEMA_WITH_SECTIONS: RJSFSchema = {
  type: 'object',
  properties: {
    'Full Name': { type: 'string' },
  },
  required: ['Full Name'],
  'x-form-layout': {
    sections: [{ title: 'About You', fields: ['Full Name'] }],
    twoColumn: [],
  },
};

const SCHEMA_DOMAIN = {
  id: 'seeker',
  description: 'Job seeker',
  item_schemas: { 'profile_1.0': SCHEMA_WITH_SECTIONS },
};

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

let currentNetwork: DotNetworkSchema = buildNetwork([NO_SCHEMA_DOMAIN]);
const getServedScope = vi.fn();

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => ({ data: [currentNetwork], isLoading: false, isError: false }),
  useResolvedNetwork: () => ({ data: currentNetwork, isLoading: false, isError: false }),
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
  getServedScope: () => getServedScope(),
}));

vi.mock('@/lib/user-api', () => ({
  getUserDomains: () => Promise.resolve([]),
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
    currentNetwork = buildNetwork([NO_SCHEMA_DOMAIN]);
    // Default: a single served domain skips the role picker entirely, landing
    // directly on the form view most of these tests target.
    getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
  });

  it('renders a single main landmark', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());
  });

  it('renders exactly one level-1 heading', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1));
  });

  it('has no heading-level skip once the shared SchemaForm renders its <h3> section titles', async () => {
    // Reproduces the real page: a domain whose schema actually has fields, so
    // SchemaForm mounts and renders a section title as <h3> (schema-form.tsx).
    // Before the fix the hero title was promoted all the way to <h1>, which
    // together with this <h3> is a level skip (h1 -> h3, no h2 in between).
    currentNetwork = buildNetwork([SCHEMA_DOMAIN]);
    getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
    await renderPage();

    await waitFor(() => expect(screen.getByText('About You')).toBeInTheDocument());

    const headings = screen.getAllByRole('heading');
    const levels = headings.map((h) => Number(h.tagName.slice(1)));

    // Sanity: the chain we're actually asserting on is present (an h1, an h2,
    // and the section's h3) — otherwise a missing element could make the
    // no-skip check below pass vacuously.
    expect(levels).toContain(1);
    expect(levels).toContain(2);
    expect(levels).toContain(3);

    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('domain-picker branch (no domain selected yet) has a main landmark and exactly one level-1 heading', async () => {
    // Two selectable domains + no served-binding scope => the auto-select
    // effect never fires (selectableDomains.length !== 1), so the page stays
    // on the "choose your role" early-return branch (~lines 641-680).
    currentNetwork = buildNetwork([
      { id: 'seeker', description: 'Job seeker' },
      { id: 'provider', description: 'Job provider' },
    ]);
    getServedScope.mockReturnValue(null);
    await renderPage();

    const main = await screen.findByRole('main');
    // Scoped to `main`, not the whole document: this branch renders inside the
    // shared `<AuthShell>`, whose sibling `BrandHero` panel carries its own
    // (decorative, out-of-scope) tagline `<h1>` at desktop widths — a
    // pre-existing AuthShell-level condition shared by every AuthShell
    // consumer (login-page/otp-page too; flagged as a follow-up, not fixed
    // here). What this test asserts is that profile-form-page's OWN content
    // region has exactly one top-level heading.
    expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
