import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';

// Task 3 — ProfileFormPage renders inside PageShell (variant='form') for the
// role-picker, create and edit states, with ONE sticky action bar. This task
// only relocates the layout + unifies the submit UI; consent SEMANTICS are
// unchanged (create keeps its exact consent behavior).

// ---- Fixtures -------------------------------------------------------------

const SCHEMA_WITH_SECTIONS: RJSFSchema = {
  type: 'object',
  properties: { 'Full Name': { type: 'string' } },
  required: ['Full Name'],
  'x-form-layout': {
    sections: [{ title: 'About You', fields: ['Full Name'] }],
    twoColumn: [],
  },
};

const SEEKER_DOMAIN = {
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

let currentNetwork: DotNetworkSchema = buildNetwork([SEEKER_DOMAIN]);
const getServedScope = vi.fn();
const navigateMock = vi.fn();
let paramsMock: { id?: string } = {};

// Mutable edit-item result the page reads via useEditItem.
let editItemResult: {
  data: Item | null;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
} = { data: null, isSuccess: false, isError: false, error: null };

const createItemMock = vi.fn();
const updateItemMock = vi.fn();

// Task 5 — inline profile_creation consent on the EDIT-of-draft path. The page
// now consumes `useProfileConsentAccept` (mocked to a spy + inert dialogs), a
// mutable consent config (to toggle a profile_creation statement on/off) and a
// mutable U18 status (adult vs minor).
const acceptMock = vi.fn();
const getU18StatusMock = vi.fn();
const CONSENT_CONFIG = {
  documents: {
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I consent to creating my profile.' }],
    },
  },
};
let consentConfigResult: { config: typeof CONSENT_CONFIG | null; isLoading: boolean } = {
  config: null,
  isLoading: false,
};

// ---- Mocks ----------------------------------------------------------------

// PageShell → passthrough recording `variant`, and standing in for the shell's
// single <main> + <h1>(title) so the page's own content structure is testable
// without pulling in the real sidebar/top-bar (covered by Tasks 1–2 tests).
vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: {
    variant?: string;
    title?: string;
    children: React.ReactNode;
    footerSlot?: React.ReactNode;
  }) => (
    <div data-testid="shell" data-variant={p.variant}>
      <main id="main-content">
        <h1>{p.title}</h1>
        {p.children}
      </main>
      {/* The action bar now lives in the shell's pinned footer, not in the
          scroll area — render it so the tests still see `profile-action-bar`. */}
      {p.footerSlot}
    </div>
  ),
}));

// SchemaForm → a real <form id> that reports validity on mount and submits
// fixed data, so the action-bar's `type=submit form=profile-form` button works.
vi.mock('@/components/forms/schema-form', () => ({
  SchemaForm: (p: {
    id?: string;
    onSubmit: (data: Record<string, unknown>) => void;
    onValidityChange?: (v: boolean) => void;
    hideSubmit?: boolean;
  }) => {
    React.useEffect(() => {
      p.onValidityChange?.(true);
    }, []);
    return (
      <form
        id={p.id}
        data-testid="schema-form"
        data-hide-submit={String(p.hideSubmit)}
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit({ 'Full Name': 'Asha' });
        }}
      >
        <span>schema-form</span>
      </form>
    );
  },
}));

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => ({ data: [currentNetwork], isLoading: false, isError: false }),
  useResolvedNetwork: () => ({ data: currentNetwork, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => consentConfigResult,
}));

vi.mock('@/hooks/use-profile-consent-accept', () => ({
  useProfileConsentAccept: () => ({
    accept: (...a: unknown[]) => acceptMock(...a),
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
  createItem: (...a: unknown[]) => createItemMock(...a),
  updateItem: (...a: unknown[]) => updateItemMock(...a),
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
  getU18Status: (...a: unknown[]) => getU18StatusMock(...a),
  issueProfilePrecreateOtp: vi.fn(),
  verifyProfilePrecreateOtp: vi.fn(),
  finalizeProfileConsent: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
  useParams: () => paramsMock,
}));

async function renderPage(entry = '/profile/new') {
  const { ProfileFormPage } = await import('../profile-form-page');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <ProfileFormPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProfileFormPage inside PageShell (Task 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentNetwork = buildNetwork([SEEKER_DOMAIN]);
    getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
    navigateMock.mockReset();
    paramsMock = {};
    editItemResult = { data: null, isSuccess: false, isError: false, error: null };
    createItemMock.mockResolvedValue({ item_id: 'new-1' });
    updateItemMock.mockResolvedValue({ item_id: 'item-1' });
    acceptMock.mockResolvedValue(undefined);
    getU18StatusMock.mockResolvedValue({ isMinor: false });
    consentConfigResult = { config: null, isLoading: false };
  });

  it('renders the edit form inside PageShell in form variant, with a single action bar', async () => {
    paramsMock = { id: 'item-1' };
    editItemResult = {
      data: {
        item_id: 'item-1',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_network: 'blue_dot',
        item_state: { 'Full Name': 'Asha' },
        lifecycle_status: 'live',
      } as unknown as Item,
      isSuccess: true,
      isError: false,
      error: null,
    };

    await renderPage('/profile/item-1');

    await screen.findByTestId('shell');
    expect(screen.getByTestId('shell').getAttribute('data-variant')).toBe('form');
    expect(screen.getByTestId('profile-action-bar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update/i })).toBeInTheDocument();
    // Only ONE submit surface: SchemaForm's built-in submit is hidden.
    expect(screen.getByTestId('schema-form').getAttribute('data-hide-submit')).toBe('true');
  });

  it('renders the create form inside PageShell in form variant, with the create submit in the action bar', async () => {
    await renderPage('/profile/new');

    await screen.findByTestId('shell');
    expect(screen.getByTestId('shell').getAttribute('data-variant')).toBe('form');
    expect(screen.getByTestId('profile-action-bar')).toBeInTheDocument();

    const createBtn = await screen.findByRole('button', { name: /create profile/i });
    expect(createBtn).toBeInTheDocument();
    // No consent config in this test → create gate reduces to formValid, which
    // the mocked SchemaForm reports true, so the single submit becomes enabled.
    await waitFor(() => expect(createBtn).not.toBeDisabled());

    await userEvent.click(createBtn);
    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    expect(updateItemMock).not.toHaveBeenCalled();
  });
});

describe('ProfileFormPage inline consent on edit-of-draft (Task 5)', () => {
  function draftEditResult(lifecycle: 'draft' | 'live') {
    return {
      data: {
        item_id: 'item-1',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_network: 'blue_dot',
        item_state: { 'Full Name': 'Asha' },
        lifecycle_status: lifecycle,
      } as unknown as Item,
      isSuccess: true,
      isError: false,
      error: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    currentNetwork = buildNetwork([SEEKER_DOMAIN]);
    getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
    navigateMock.mockReset();
    createItemMock.mockResolvedValue({ item_id: 'new-1' });
    updateItemMock.mockResolvedValue({ item_id: 'item-1' });
    acceptMock.mockResolvedValue(undefined);
    getU18StatusMock.mockResolvedValue({ isMinor: false });
    // A profile_creation statement is configured, so consent is relevant.
    consentConfigResult = { config: CONSENT_CONFIG, isLoading: false };
    paramsMock = { id: 'item-1' };
    editItemResult = draftEditResult('draft');
  });

  it('edit of a DRAFT (un-consented) shows consent and blocks submit until ticked', async () => {
    await renderPage('/profile/item-1');

    const submit = await screen.findByRole('button', { name: /save & publish/i });
    expect(submit).toBeDisabled();

    await userEvent.click(await screen.findByRole('checkbox', { name: /agree/i }));
    expect(submit).toBeEnabled();
  });

  it('edit of a LIVE profile shows no consent and enables submit', async () => {
    editItemResult = draftEditResult('live');

    await renderPage('/profile/item-1');

    await screen.findByRole('button', { name: /update/i });
    expect(screen.queryByRole('checkbox', { name: /agree/i })).not.toBeInTheDocument();
  });

  it('edit-of-draft submit (adult) updates then records consent', async () => {
    await renderPage('/profile/item-1');

    await userEvent.click(await screen.findByRole('checkbox', { name: /agree/i }));
    await userEvent.click(await screen.findByRole('button', { name: /save & publish/i }));

    await waitFor(() => expect(updateItemMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(acceptMock).toHaveBeenCalledWith(
        expect.objectContaining({
          isMinor: false,
          item: expect.objectContaining({ item_id: 'item-1', item_domain: 'seeker' }),
        }),
      ),
    );
  });

  it('edit-of-draft submit (minor, gated) routes through the guardian flow', async () => {
    getU18StatusMock.mockResolvedValue({ isMinor: true });

    await renderPage('/profile/item-1');

    await userEvent.click(await screen.findByRole('checkbox', { name: /agree/i }));
    await userEvent.click(await screen.findByRole('button', { name: /save & publish/i }));

    await waitFor(() => expect(updateItemMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(acceptMock).toHaveBeenCalledWith(expect.objectContaining({ isMinor: true })),
    );
  });
});
