import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain, DotNetworkInstance, DotNetworkSchema } from '@/engine/types';
import type { CreateItemPayload, Item, UpdateItemPayload } from '@/lib/item-api';
import type { GeoSuggestion } from '@/lib/geo/types';
import type { WalletImportResult } from '@/engine/wallet/types';
import { queryKeys } from '@/lib/query-keys';

// Third companion to `profile-form-page.test.tsx` (PageShell/create/edit-of-draft
// consent), `.landmarks.test.tsx` (a11y) and `.coverage.test.tsx` (guards, load
// outcomes, role picker, validity gate, submit failures, pre-create guardian
// OTP). This file covers what none of those reach:
//   • the submit-time geocode of the schema's `location: 'primary'` field, and
//     the picked-suggestion path that suppresses it
//   • the create payload's instance_url / custom item-schema URL wiring
//   • the successful plain-edit path (locations included vs deliberately omitted)
//   • wallet credential import (mapped / partially-mapped / unmatched)
//   • the one-shot signup-domain handoff
//   • an already-consented draft that must not re-prompt
//   • the app-shell sidebar callbacks (network / domain / active profile / refresh)

// ---- Fixtures -------------------------------------------------------------

// `location` is a DPG schema marker, not JSON Schema, so the marked property is
// typed as RJSFSchema (which carries an index signature) rather than the
// stricter JSONSchema7Definition that `properties` expects.
/** `Address` carries the `location: 'primary'` marker, so it is the one field
 * the page geocodes at submit (see @dpg/schemas/location_fields). */
const ADDRESS_SCHEMA: RJSFSchema = {
  type: 'object',
  properties: {
    'Full Name': { type: 'string' },
    Address: { type: 'string', location: 'primary' } as RJSFSchema,
  },
  required: ['Full Name'],
};

/** Same marker on an array field ⇒ cardinality 'multiple': one point per entry. */
const MULTI_ADDRESS_SCHEMA: RJSFSchema = {
  type: 'object',
  properties: {
    'Full Name': { type: 'string' },
    Address: { type: 'array', location: 'primary', items: { type: 'string' } } as RJSFSchema,
  },
  required: ['Full Name'],
};

function seekerDomain(schema: RJSFSchema): DotNetworkDomain {
  return { id: 'seeker', description: 'Job seeker', item_schemas: { 'profile_1.0': schema } };
}

function providerDomain(schema: RJSFSchema): DotNetworkDomain {
  return { id: 'provider', description: 'Job provider', item_schemas: { 'provider_1.0': schema } };
}

function buildNetwork(
  domains: DotNetworkDomain[],
  opts: { id?: string; instances?: DotNetworkInstance[] } = {},
): DotNetworkSchema {
  return {
    id: opts.id ?? 'blue_dot',
    display_name: 'Blue Dots',
    description: 'test network',
    schema_standard: '1.0',
    domains,
    instances: opts.instances,
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

function httpError(status: number, data: Record<string, unknown>): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

function liveItem(lifecycle: 'draft' | 'live'): Item {
  return {
    item_id: 'item-1',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_network: 'blue_dot',
    item_state: { 'Full Name': 'Asha', Address: 'Old Street' },
    lifecycle_status: lifecycle,
  } as unknown as Item;
}

// ---- Mutable module state driven by each test ------------------------------

let networksResult: { data: DotNetworkSchema[] | undefined; isError: boolean } = {
  data: [buildNetwork([seekerDomain(ADDRESS_SCHEMA)])],
  isError: false,
};
let resolvedResult: { data: DotNetworkSchema | undefined; isError: boolean } = {
  data: buildNetwork([seekerDomain(ADDRESS_SCHEMA)]),
  isError: false,
};
let editItemResult: { data: Item | null; isSuccess: boolean; isError: boolean; error: unknown } = {
  data: null,
  isSuccess: false,
  isError: false,
  error: null,
};
let consentConfigResult: { config: typeof CONSENT_CONFIG | null; isLoading: boolean } = {
  config: null,
  isLoading: false,
};
let paramsMock: { id?: string } = {};
/** What the (mocked) SchemaForm hands to `onSubmit`. */
let formSubmitData: Record<string, unknown> = { 'Full Name': 'Asha' };
/** How many wallet providers `getConfiguredWalletProviders()` reports. */
let walletProviderCount = 0;
/** What the (stubbed) wallet modal emits through `onImported`. */
let walletResult: WalletImportResult = {
  data: {},
  providerName: 'digilocker',
  providerLabel: 'DigiLocker',
};

/** Point both network hooks at `net` — they must agree, as in production. */
function useNetwork(net: DotNetworkSchema): void {
  networksResult = { data: [net], isError: false };
  resolvedResult = { data: net, isError: false };
}

const getServedScope = vi.fn();
const navigateMock = vi.fn();
const acceptMock = vi.fn((_args: unknown): Promise<void> => Promise.resolve());
const setActiveProfileMock = vi.fn((_networkId: string, _profileId: string): void => undefined);
const suggestMock = vi.fn((_query: string): Promise<GeoSuggestion[]> => Promise.resolve([]));
const createItemMock = vi.fn(
  (_payload: CreateItemPayload): Promise<{ item_id: string; item_type: string }> =>
    Promise.resolve({ item_id: 'new-1', item_type: 'profile_1.0' }),
);
const updateItemMock = vi.fn(
  (_itemId: string, _payload: UpdateItemPayload): Promise<unknown> => Promise.resolve({}),
);

// ---- Mocks ----------------------------------------------------------------

// PageShell → passthrough exposing the sidebar callbacks the real shell drives
// (network / domain / active-profile selection, "profiles changed"), so this
// page's handlers for them are exercised without the real sidebar tree.
vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: {
    variant?: string;
    title?: string;
    children: React.ReactNode;
    footerSlot?: React.ReactNode;
    networks?: Array<{ id: string }>;
    onNetworkSelect?: (networkId: string) => void;
    onDomainSelect?: (domainId: string | null) => void;
    onActiveProfileChange?: (profileId: string) => void;
    onProfilesChanged?: () => void;
    backLabel?: string;
    hideBrowse?: boolean;
  }) => (
    <div
      data-testid="shell"
      data-variant={p.variant}
      data-back-label={p.backLabel}
      data-hide-browse={String(p.hideBrowse)}
    >
      <main id="main-content">
        {p.title ? <h1>{p.title}</h1> : null}
        {p.children}
      </main>
      {p.footerSlot}
      <div data-testid="sidebar-stub">
        {(p.networks ?? []).map((n) => (
          <button key={n.id} type="button" onClick={() => p.onNetworkSelect?.(n.id)}>
            {`pick-network:${n.id}`}
          </button>
        ))}
        <button type="button" onClick={() => p.onDomainSelect?.('seeker')}>
          pick-domain:seeker
        </button>
        <button type="button" onClick={() => p.onDomainSelect?.(null)}>
          pick-domain:all
        </button>
        <button type="button" onClick={() => p.onActiveProfileChange?.('item-9')}>
          pick-profile:item-9
        </button>
        <button type="button" onClick={() => p.onProfilesChanged?.()}>
          profiles-changed
        </button>
      </div>
    </div>
  ),
}));

// SchemaForm → a real <form id> (so the action bar's `type=submit
// form=profile-form` button submits), which also echoes the `formData` it was
// seeded with and exposes the two location callbacks the real location widget
// invokes when the user picks an autocomplete suggestion.
vi.mock('@/components/forms/schema-form', () => ({
  SchemaForm: (p: {
    id?: string;
    onSubmit: (data: Record<string, unknown>) => void;
    onValidityChange?: (v: boolean) => void;
    formData?: Record<string, unknown>;
    formContext?: {
      onLocationResolved: (place: { lat: number; lng: number } | null) => void;
      onLocationsResolved: (coords: Array<{ lat: number; lng: number; label?: string }>) => void;
    };
  }) => {
    React.useEffect(() => {
      p.onValidityChange?.(true);
    }, []);
    return (
      <form
        id={p.id}
        data-testid="schema-form"
        data-form-data={JSON.stringify(p.formData ?? null)}
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit(formSubmitData);
        }}
      >
        <button
          type="button"
          data-testid="pick-one-place"
          onClick={() => p.formContext?.onLocationResolved({ lat: 12.9, lng: 77.6 })}
        >
          pick one suggestion
        </button>
        <button
          type="button"
          data-testid="clear-place"
          onClick={() => p.formContext?.onLocationResolved(null)}
        >
          clear suggestion
        </button>
        <button
          type="button"
          data-testid="pick-many-places"
          onClick={() =>
            p.formContext?.onLocationsResolved([
              { lat: 18.5, lng: 73.8, label: 'Pune' },
              { lat: 19.1, lng: 72.9, label: 'Mumbai' },
            ])
          }
        >
          pick many suggestions
        </button>
      </form>
    );
  },
}));

// The wallet modal owns provider selection + the provider's own network calls
// (covered by its own tests) — stub it down to "emit an import result".
vi.mock('@/components/wallet/wallet-import-modal', () => ({
  WalletImportModal: (p: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onImported: (result: WalletImportResult) => void;
  }) =>
    p.open ? (
      <div data-testid="wallet-modal">
        <button
          type="button"
          data-testid="wallet-emit"
          onClick={() => {
            p.onImported(walletResult);
            p.onOpenChange(false);
          }}
        >
          finish import
        </button>
      </div>
    ) : null,
}));

vi.mock('@/engine/wallet/wallet-registry', () => ({
  getConfiguredWalletProviders: () =>
    Array.from({ length: walletProviderCount }, (_, i) => ({ name: `provider-${i}` })),
  getRegisteredWalletProviders: () =>
    Array.from({ length: walletProviderCount }, (_, i) => ({ name: `provider-${i}` })),
  getWalletProvider: () => undefined,
}));

vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: (query: string) => suggestMock(query) }),
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
    accept: (args: unknown) => acceptMock(args),
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
  setStoredActiveProfileId: (networkId: string, profileId: string) =>
    setActiveProfileMock(networkId, profileId),
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
    signOut: vi.fn(),
  }),
}));

vi.mock('@/lib/served-binding', async (orig) => ({
  ...(await orig<typeof import('@/lib/served-binding')>()),
  getServedScope: () => getServedScope(),
}));

vi.mock('@/lib/user-api', () => ({
  getUserDomains: () => Promise.resolve([] as string[]),
}));

vi.mock('@/lib/consent-api', () => ({
  getU18Status: () => Promise.resolve({ isMinor: false }),
  issueProfilePrecreateOtp: vi.fn(),
  verifyProfilePrecreateOtp: vi.fn(),
  finalizeProfileConsent: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
  useParams: () => paramsMock,
}));

// ---- Harness --------------------------------------------------------------

function ui() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

async function renderPage(
  entry = '/profile/new',
  seed?: (client: QueryClient) => void,
): Promise<QueryClient> {
  const { ProfileFormPage } = await import('../profile-form-page');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        {/* Toaster FIRST — sonner drops a toast published before it subscribes. */}
        <Toaster />
        <ProfileFormPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

/** Click the enabled primary submit in the action bar. */
async function submitForm(name: RegExp) {
  const btn = await screen.findByRole('button', { name });
  await waitFor(() => expect(btn).toBeEnabled());
  await ui().click(btn);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useNetwork(buildNetwork([seekerDomain(ADDRESS_SCHEMA)]));
  editItemResult = { data: null, isSuccess: false, isError: false, error: null };
  consentConfigResult = { config: null, isLoading: false };
  paramsMock = {};
  formSubmitData = { 'Full Name': 'Asha', Address: 'MG Road, Bengaluru' };
  walletProviderCount = 0;
  walletResult = { data: {}, providerName: 'digilocker', providerLabel: 'DigiLocker' };
  getServedScope.mockReturnValue({ network: 'blue_dot', domains: ['seeker'] });
  createItemMock.mockResolvedValue({ item_id: 'new-1', item_type: 'profile_1.0' });
  updateItemMock.mockResolvedValue({});
  acceptMock.mockResolvedValue(undefined);
  suggestMock.mockResolvedValue([]);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ---- Submit-time geocoding of the primary location field ------------------

describe('ProfileFormPage submit-time geocoding', () => {
  it('geocodes the typed address when no suggestion was picked and submits the resolved point', async () => {
    suggestMock.mockResolvedValue([
      { lat: 12.9716, lng: 77.5946, label: 'MG Road, Bengaluru, India' },
    ]);

    await renderPage();
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    expect(suggestMock).toHaveBeenCalledWith('MG Road, Bengaluru');
    // Single-cardinality primary ⇒ the point carries no label.
    expect(createItemMock.mock.calls[0][0].item_locations).toEqual([
      { lat: 12.9716, lng: 77.5946 },
    ]);
  });

  it('geocodes every entry of a multi-value address and drops the entries with no match', async () => {
    useNetwork(buildNetwork([seekerDomain(MULTI_ADDRESS_SCHEMA)]));
    formSubmitData = { 'Full Name': 'Asha', Address: ['Pune', 'Nowheresville'] };
    suggestMock.mockImplementation((query: string) =>
      Promise.resolve(
        query === 'Pune' ? [{ lat: 18.5204, lng: 73.8567, label: 'Pune, India' }] : [],
      ),
    );

    await renderPage();
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    expect(suggestMock).toHaveBeenCalledWith('Pune');
    expect(suggestMock).toHaveBeenCalledWith('Nowheresville');
    // The unmatched entry contributes nothing; the matched one keeps its label
    // (multi-cardinality labels each point with the field value).
    expect(createItemMock.mock.calls[0][0].item_locations).toEqual([
      { lat: 18.5204, lng: 73.8567, label: 'Pune' },
    ]);
  });

  it('a picked suggestion is submitted verbatim, and clearing it falls back to geocoding', async () => {
    suggestMock.mockResolvedValue([{ lat: 1, lng: 2, label: 'geocoded fallback' }]);

    await renderPage();
    await ui().click(await screen.findByTestId('pick-one-place'));
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    // The widget already resolved the coordinate — no geocode round-trip.
    expect(suggestMock).not.toHaveBeenCalled();
    expect(createItemMock.mock.calls[0][0].item_locations).toEqual([{ lat: 12.9, lng: 77.6 }]);

    await ui().click(screen.getByTestId('clear-place'));
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(2));
    expect(suggestMock).toHaveBeenCalledWith('MG Road, Bengaluru');
    expect(createItemMock.mock.calls[1][0].item_locations).toEqual([{ lat: 1, lng: 2 }]);
  });

  it('submits every picked suggestion, labelled, for a multi-value address field', async () => {
    useNetwork(buildNetwork([seekerDomain(MULTI_ADDRESS_SCHEMA)]));
    formSubmitData = { 'Full Name': 'Asha', Address: ['Pune', 'Mumbai'] };

    await renderPage();
    await ui().click(await screen.findByTestId('pick-many-places'));
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    expect(suggestMock).not.toHaveBeenCalled();
    expect(createItemMock.mock.calls[0][0].item_locations).toEqual([
      { lat: 18.5, lng: 73.8, label: 'Pune' },
      { lat: 19.1, lng: 72.9, label: 'Mumbai' },
    ]);
  });

  it('discards a location picked for a role the user then switched away from', async () => {
    useNetwork(
      buildNetwork([seekerDomain(ADDRESS_SCHEMA), providerDomain(ADDRESS_SCHEMA)]),
    );
    getServedScope.mockReturnValue(null);
    suggestMock.mockResolvedValue([{ lat: 22.5, lng: 88.3, label: 'Kolkata, India' }]);

    await renderPage();

    await ui().click(await screen.findByRole('button', { name: /Job seeker/ }));
    await ui().click(await screen.findByTestId('pick-one-place'));
    // Step back to the picker and choose the other role.
    await ui().click(screen.getByRole('button', { name: 'Cancel' }));
    await ui().click(await screen.findByRole('button', { name: /Job provider/ }));

    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    // The seeker-era point is gone; the provider form geocodes afresh.
    expect(suggestMock).toHaveBeenCalledWith('MG Road, Bengaluru');
    expect(createItemMock.mock.calls[0][0]).toMatchObject({
      item_domain: 'provider',
      item_locations: [{ lat: 22.5, lng: 88.3 }],
    });
  });
});

// ---- Create payload: per-domain instance wiring ---------------------------

describe('ProfileFormPage create payload instance wiring', () => {
  it("forwards the domain's instance URL and its custom item-schema URL", async () => {
    useNetwork(
      buildNetwork([seekerDomain(ADDRESS_SCHEMA)], {
        instances: [
          {
            domain_id: 'seeker',
            instance_url: 'https://seeker.example.org',
            custom_item_schema_urls: {
              'profile_1.0': 'https://seeker.example.org/schemas/profile_1.0.json',
            },
          },
          { domain_id: 'provider', instance_url: 'https://provider.example.org' },
        ],
      }),
    );

    await renderPage();
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    expect(createItemMock.mock.calls[0][0]).toMatchObject({
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_instance_url: 'https://seeker.example.org',
      item_schema_url: 'https://seeker.example.org/schemas/profile_1.0.json',
    });
  });

  it('omits both URLs when the network registers no instance for the domain', async () => {
    await renderPage();
    await submitForm(/create profile/i);

    await waitFor(() => expect(createItemMock).toHaveBeenCalledTimes(1));
    const payload = createItemMock.mock.calls[0][0];
    expect(payload.item_instance_url).toBeUndefined();
    expect(payload.item_schema_url).toBeUndefined();
  });
});

// ---- Successful plain edit -------------------------------------------------

describe('ProfileFormPage successful live edit', () => {
  beforeEach(() => {
    paramsMock = { id: 'item-1' };
    editItemResult = { data: liveItem('live'), isSuccess: true, isError: false, error: null };
  });

  it('sends the re-picked coordinate, confirms with a toast and returns home', async () => {
    await renderPage('/profile/item-1');

    await ui().click(await screen.findByTestId('pick-one-place'));
    await submitForm(/^update$/i);

    await waitFor(() => expect(updateItemMock).toHaveBeenCalledTimes(1));
    expect(updateItemMock.mock.calls[0][0]).toBe('item-1');
    expect(updateItemMock.mock.calls[0][1]).toEqual({
      item_state: { 'Full Name': 'Asha', Address: 'MG Road, Bengaluru' },
      item_locations: [{ lat: 12.9, lng: 77.6 }],
    });
    expect(await screen.findByText('Profile updated!')).toBeInTheDocument();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/?network=blue_dot'));
    // A live edit never re-captures profile_creation consent.
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it('omits item_locations entirely when nothing geocoded, so the stored coordinate survives', async () => {
    // Mirrors the masked-PII case: the address renders as "***", so the geocoder
    // returns nothing and the update must not overwrite the stored coarse point.
    suggestMock.mockResolvedValue([]);

    await renderPage('/profile/item-1');
    await submitForm(/^update$/i);

    await waitFor(() => expect(updateItemMock).toHaveBeenCalledTimes(1));
    const payload = updateItemMock.mock.calls[0][1];
    expect(payload).toEqual({ item_state: { 'Full Name': 'Asha', Address: 'MG Road, Bengaluru' } });
    expect('item_locations' in payload).toBe(false);
  });
});

// ---- Wallet credential import ---------------------------------------------

describe('ProfileFormPage wallet credential import', () => {
  beforeEach(() => {
    walletProviderCount = 1;
  });

  it('hides the import control when no wallet provider is configured', async () => {
    walletProviderCount = 0;

    await renderPage();

    await screen.findByTestId('schema-form');
    expect(screen.queryByRole('button', { name: /import credentials/i })).not.toBeInTheDocument();
  });

  it('opens the wallet modal and seeds the form with the mapped fields', async () => {
    walletResult = {
      data: { fullName: 'Asha Rao' },
      providerName: 'digilocker',
      providerLabel: 'DigiLocker',
      summary: 'Verified via DigiLocker',
    };

    await renderPage();

    expect(screen.queryByTestId('wallet-modal')).not.toBeInTheDocument();
    await ui().click(await screen.findByRole('button', { name: /import credentials/i }));

    const modal = await screen.findByTestId('wallet-modal');
    await ui().click(within(modal).getByTestId('wallet-emit'));

    expect(await screen.findByText('Imported 1 field from DigiLocker.')).toBeInTheDocument();
    expect(screen.getByText('Verified via DigiLocker')).toBeInTheDocument();
    // `fullName` was mapped onto the schema's "Full Name" property.
    await waitFor(() =>
      expect(screen.getByTestId('schema-form').getAttribute('data-form-data')).toContain(
        '"Full Name":"Asha Rao"',
      ),
    );
    // Importing closes the modal.
    expect(screen.queryByTestId('wallet-modal')).not.toBeInTheDocument();
  });

  it('reports the imported fields that this schema has no home for', async () => {
    walletResult = {
      data: { fullName: 'Asha Rao', bloodGroup: 'O+' },
      providerName: 'digilocker',
      providerLabel: 'DigiLocker',
    };

    await renderPage();
    await ui().click(await screen.findByRole('button', { name: /import credentials/i }));
    await ui().click(within(await screen.findByTestId('wallet-modal')).getByTestId('wallet-emit'));

    expect(await screen.findByText('Imported 1 field from DigiLocker.')).toBeInTheDocument();
    expect(screen.getByText('1 field did not match this schema.')).toBeInTheDocument();
  });

  it('an import that matches nothing is reported as an error and leaves the form untouched', async () => {
    walletResult = {
      data: { favouriteColour: 'teal' },
      providerName: 'digilocker',
      providerLabel: 'DigiLocker',
    };

    await renderPage();
    await ui().click(await screen.findByRole('button', { name: /import credentials/i }));
    await ui().click(within(await screen.findByTestId('wallet-modal')).getByTestId('wallet-emit'));

    expect(
      await screen.findByText('Imported from DigiLocker, but none of the fields matched this form.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('schema-form').getAttribute('data-form-data')).toBe('null');
  });
});

// ---- One-shot signup-domain handoff ---------------------------------------

describe('ProfileFormPage signup-domain handoff', () => {
  beforeEach(() => {
    useNetwork(buildNetwork([seekerDomain(ADDRESS_SCHEMA), providerDomain(ADDRESS_SCHEMA)]));
    getServedScope.mockReturnValue(null);
  });

  it('consumes the domain confirmed at signup, skipping the picker, and clears it', async () => {
    localStorage.setItem('signupDomain:blue_dot', 'provider');

    await renderPage();

    expect(
      await screen.findByRole('heading', { name: /create provider profile/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Choose your role on the network')).not.toBeInTheDocument();
    // One-shot: never applies to a later, unrelated profile-creation flow.
    expect(localStorage.getItem('signupDomain:blue_dot')).toBeNull();
  });

  it('ignores — but still clears — a stored domain this network does not have', async () => {
    localStorage.setItem('signupDomain:blue_dot', 'astronaut');

    await renderPage();

    expect(await screen.findByText('Choose your role on the network')).toBeInTheDocument();
    expect(screen.queryByTestId('schema-form')).not.toBeInTheDocument();
    expect(localStorage.getItem('signupDomain:blue_dot')).toBeNull();
  });
});

// ---- Draft that already recorded consent ----------------------------------

describe('ProfileFormPage already-consented draft', () => {
  it('does not re-prompt for consent when this draft already recorded it', async () => {
    consentConfigResult = { config: CONSENT_CONFIG, isLoading: false };
    paramsMock = { id: 'item-1' };
    editItemResult = { data: liveItem('draft'), isSuccess: true, isError: false, error: null };

    await renderPage('/profile/item-1', (client) => {
      client.setQueryData<Set<string>>(queryKeys.profileConsent('blue_dot'), new Set(['item-1']));
    });

    // Consent already on file ⇒ plain "Update", no acknowledgement row.
    expect(await screen.findByRole('button', { name: /^update$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save & publish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /agree/i })).not.toBeInTheDocument();

    await submitForm(/^update$/i);

    await waitFor(() => expect(updateItemMock).toHaveBeenCalledTimes(1));
    expect(acceptMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Profile updated!')).toBeInTheDocument();
  });
});

// ---- App-shell sidebar wiring --------------------------------------------

describe('ProfileFormPage app-shell sidebar wiring', () => {
  it('offers the other networks and leaves for the one picked', async () => {
    networksResult = {
      data: [
        buildNetwork([seekerDomain(ADDRESS_SCHEMA)], { id: 'blue_dot' }),
        buildNetwork([seekerDomain(ADDRESS_SCHEMA)], { id: 'yellow_dot' }),
      ],
      isError: false,
    };
    resolvedResult = { data: buildNetwork([seekerDomain(ADDRESS_SCHEMA)]), isError: false };
    getServedScope.mockReturnValue(null);

    await renderPage();

    await ui().click(await screen.findByRole('button', { name: 'pick-network:yellow_dot' }));

    expect(navigateMock).toHaveBeenCalledWith('/?network=yellow_dot');
  });

  it('hides the network selector, and the Browse group, on a served single-network form', async () => {
    await renderPage();

    const shell = await screen.findByTestId('shell');
    expect(shell.getAttribute('data-hide-browse')).toBe('true');
    expect(shell.getAttribute('data-back-label')).toBe('Browse');
    expect(screen.queryByRole('button', { name: /^pick-network:/ })).not.toBeInTheDocument();
  });

  it('browsing a domain (or all domains) from the sidebar returns home scoped accordingly', async () => {
    await renderPage();

    await ui().click(await screen.findByRole('button', { name: 'pick-domain:seeker' }));
    expect(navigateMock).toHaveBeenLastCalledWith('/?network=blue_dot&domain=seeker');

    await ui().click(screen.getByRole('button', { name: 'pick-domain:all' }));
    expect(navigateMock).toHaveBeenLastCalledWith('/?network=blue_dot');
  });

  it('switching the active profile stores it and returns home', async () => {
    await renderPage();

    await ui().click(await screen.findByRole('button', { name: 'pick-profile:item-9' }));

    expect(setActiveProfileMock).toHaveBeenCalledWith('blue_dot', 'item-9');
    expect(navigateMock).toHaveBeenCalledWith('/?network=blue_dot');
  });

  it('a sidebar profile change (pause/retire) refreshes the my-items cache', async () => {
    const client = await renderPage();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    await ui().click(await screen.findByRole('button', { name: 'profiles-changed' }));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['my-items', 'blue_dot'] });
    // Nothing was saved, so this must not navigate away from the editor.
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

// ---- Failure logging on the geocode path ---------------------------------

describe('ProfileFormPage geocode failure', () => {
  it('a create that fails after geocoding still surfaces the inline error', async () => {
    suggestMock.mockResolvedValue([{ lat: 12.9, lng: 77.6, label: 'MG Road' }]);
    createItemMock.mockRejectedValue(httpError(500, { message: 'geo write failed' }));

    await renderPage();
    await submitForm(/create profile/i);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't create your profile");
    expect(alert).toHaveTextContent('geo write failed');
    expect(errorSpy).toHaveBeenCalledWith('Failed to save profile:', expect.any(Error));
  });
});
