import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import type {
  DotNetworkDomain,
  DotNetworkSchema,
  MapMarker,
  MapViewport,
  ViewMode,
} from '@/engine/types';
import type { Item } from '@/lib/item-api';
import type { DiscoverFacetFilter, Marker as NetworkMarker } from '@/lib/network-api';
import { HomePage } from '../home-page';

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// A small inline network schema (the app is schema-driven, so every card /
// filter / tab in the page derives from this rather than from fixed props).
// Interaction edges: seeker → provider, seeker → mentor, provider → seeker.
// So a signed-in seeker browses [provider, mentor]; a visitor (no domain
// identity) browses every to_domain.

const requirementSchema: RJSFSchema = {
  type: 'object',
  properties: { message: { type: 'string', title: 'Message' } },
};

const seekerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    city: { type: 'string', title: 'City' },
  },
};

const providerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    company: { type: 'string', title: 'Company' },
    gender: { type: 'string', title: 'Gender', enum: ['female', 'male'] },
  },
};

const mentorSchema: RJSFSchema = {
  type: 'object',
  properties: { mentor_name: { type: 'string', title: 'Mentor' } },
};

const networkFixture: DotNetworkSchema = {
  id: 'blue_dot',
  display_name: 'Blue Dot',
  description: 'Test network',
  schema_standard: '1.0.0',
  domains: [
    {
      id: 'seeker',
      description: 'People looking for work',
      card: { title_field: 'name' },
      item_schemas: { 'profile_1.0': seekerSchema },
    },
    {
      id: 'provider',
      description: 'Employers hiring',
      card: { title_field: 'company' },
      item_schemas: { 'job_posting_1.0': providerSchema },
    },
    {
      id: 'mentor',
      description: 'Mentors offering guidance',
      card: { title_field: 'mentor_name' },
      item_schemas: { 'mentor_1.0': mentorSchema },
    },
  ],
  actions: {
    connect: {
      description: 'Connect with someone',
      interactions: [
        { from_domain: 'seeker', to_domain: 'provider', requirement_schema: requirementSchema },
        { from_domain: 'seeker', to_domain: 'mentor', requirement_schema: requirementSchema },
        { from_domain: 'provider', to_domain: 'seeker', requirement_schema: requirementSchema },
      ],
    },
  },
};

function mkItem(
  id: string,
  domain: string,
  itemType: string,
  itemState: Record<string, unknown>,
  locations: Array<{ lat: number; lng: number }> = [],
): Item {
  return {
    item_id: id,
    item_network: 'blue_dot',
    item_domain: domain,
    item_type: itemType,
    item_instance_url: null,
    item_schema_url: null,
    item_state: itemState,
    item_locations: locations,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    lifecycle_status: 'live',
  };
}

const myProfile = mkItem('me-1', 'seeker', 'profile_1.0', { name: 'My Seeker', city: 'Bengaluru' }, [
  { lat: 12.9, lng: 77.6 },
]);
const providerItem1 = mkItem(
  'p1',
  'provider',
  'job_posting_1.0',
  { company: 'Acme Welding', gender: 'female' },
  [{ lat: 12.91, lng: 77.61 }],
);
const providerItem2 = mkItem('p2', 'provider', 'job_posting_1.0', {
  company: 'Globex Foundry',
  gender: 'male',
});
const mentorItem = mkItem('m1', 'mentor', 'mentor_1.0', { mentor_name: 'Rita Mentor' });

// ─── mutable mock state (read lazily from inside the mock factories) ─────────

interface BrowseEntry {
  items: Item[];
  hasNextPage: boolean;
  total: number;
  isLoading: boolean;
  partial: boolean;
  degraded: boolean;
  distanceMeters?: number;
}

interface BrowseOpts {
  enabled?: boolean;
  q?: string;
  filters?: DiscoverFacetFilter[];
  relevance?: boolean;
  anchorItemId?: string;
}

interface BrowseCall {
  domainId: string | null;
  coords: { lat: number; lng: number } | null;
  opts?: BrowseOpts;
  // The mock records every hook INVOCATION, including ones the page disabled.
  // A disabled invocation issues no request, so assertions about what was
  // actually browsed must filter on this — see `browsedDomains()`.
  enabled: boolean;
}

interface MarkerCall {
  domainIds: string[];
  viewport: MapViewport | null;
  filters: Record<string, unknown>;
  search: string;
}

interface ActionRow {
  action_status: string;
  source_item_id: string;
  target_item_id: string;
}

function emptyBrowse(): BrowseEntry {
  return {
    items: [],
    hasNextPage: false,
    total: 0,
    isLoading: false,
    partial: false,
    degraded: false,
  };
}

const state = {
  networks: [networkFixture] as DotNetworkSchema[],
  network: networkFixture as DotNetworkSchema | null,
  user: { id: 'u1', name: 'Seeker One' } as { id: string; name: string } | null,
  myItems: [] as Item[],
  actions: [] as ActionRow[],
  browse: {} as Record<string, BrowseEntry>,
  markers: [] as NetworkMarker[],
  markersTotal: 0,
  markersPartial: false,
  markersTruncated: false,
  detail: { item: null as Item | null, isLoading: false },
  location: null as { lat: number; lng: number } | null,
  locationSource: 'none' as 'profile' | 'browser' | 'none',
  browserSupported: false,
  browserStatus: 'idle' as 'idle' | 'loading' | 'error' | 'success',
};

const browseCalls: BrowseCall[] = [];
/** Domains actually fetched — enabled invocations with a real domain. */
const browsedDomains = () =>
  new Set(
    browseCalls.filter((c) => c.enabled && c.domainId !== null).map((c) => c.domainId as string),
  );
const markerCalls: MarkerCall[] = [];
const requestBrowserLocation = vi.fn();
const fetchNextPage = vi.fn();
const preferredSources: string[] = [];

// ─── module mocks ────────────────────────────────────────────────────────────
// Every factory below only dereferences `state` / the spies from INSIDE a
// function body, so nothing is read before the module finishes initialising.

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfig: (id: string | null) => ({ config: id ? state.network : null, isLoading: false }),
  useNetworkConfigs: () => ({ data: state.networks, isLoading: false }),
  useResolvedNetwork: (id: string | null) => ({
    data: id ? (state.network ?? undefined) : undefined,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-my-items', () => ({
  useMyItems: () => ({ data: state.myItems, isFetched: true, isLoading: false }),
}));

vi.mock('@/hooks/use-profile-consent-status', () => ({
  useProfileConsentStatus: () => ({
    data: new Set<string>(),
    isSuccess: true,
    isError: false,
  }),
}));

vi.mock('@/hooks/use-actions', () => ({
  useActions: () => ({ data: { actions: state.actions }, isLoading: false }),
  usePendingActionsCount: () => ({ data: 0 }),
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: undefined, isLoading: false }),
}));

vi.mock('@/hooks/use-consent-gate', () => ({
  useConsentGate: () => ({ needed: [], isLoading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/use-profile-consent-accept', () => ({
  useProfileConsentAccept: () => ({
    accept: vi.fn(),
    dialogs: null,
    guardianActive: false,
  }),
}));

vi.mock('@/hooks/use-match-score', () => ({
  useMatchScore: () => ({
    score: null,
    isLoading: false,
    error: null,
    cached: false,
    calculate: async () => {},
    recalculate: async () => {},
    clearCache: () => {},
  }),
}));

vi.mock('@/hooks/use-geolocation-permission', () => ({
  useGeolocationPermission: () => 'prompt',
}));

vi.mock('@/hooks/use-user-location', () => ({
  useUserLocation: (
    _profileLocation: { lat: number; lng: number } | null,
    _ready: boolean,
    preferred: string,
  ) => {
    preferredSources.push(preferred);
    return {
      location: state.location,
      source: state.locationSource,
      browser: {
        location: null,
        status: state.browserStatus,
        isSupported: state.browserSupported,
        request: requestBrowserLocation,
      },
    };
  },
}));

vi.mock('@/hooks/use-infinite-browse-items', () => ({
  useInfiniteBrowseItems: (
    _network: DotNetworkSchema | null,
    domain: DotNetworkDomain | null,
    coords: { lat: number; lng: number } | null,
    opts?: BrowseOpts,
  ) => {
    browseCalls.push({ domainId: domain?.id ?? null, coords, opts, enabled: opts?.enabled ?? true });
    const entry = (domain && state.browse[domain.id]) || emptyBrowse();
    return {
      items: entry.items,
      hasNextPage: entry.hasNextPage,
      total: entry.total,
      isLoading: entry.isLoading,
      fetchNextPage,
      partial: entry.partial,
      degraded: entry.degraded,
      distanceMeters: entry.distanceMeters,
    };
  },
}));

vi.mock('@/hooks/use-map-markers', () => ({
  useMapMarkers: (
    _network: DotNetworkSchema | null,
    domains: DotNetworkDomain[],
    viewport: MapViewport | null,
    filters: Record<string, unknown> = {},
    search = '',
  ) => {
    markerCalls.push({ domainIds: domains.map((d) => d.id), viewport, filters, search });
    // Mirrors the real hook: nothing is fetched until the map reports its
    // first viewport.
    return {
      markers: viewport ? state.markers : [],
      total: viewport ? state.markersTotal : 0,
      partial: viewport ? state.markersPartial : false,
      truncated: viewport ? state.markersTruncated : false,
      isLoading: false,
    };
  },
}));

vi.mock('@/hooks/use-item-detail', () => ({
  useItemDetail: () => ({ item: state.detail.item, isLoading: state.detail.isLoading }),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: state.user,
    isAuthenticated: !!state.user,
    isLoading: false,
    checkUser: vi.fn(),
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/lib/consent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/consent-api')>();
  return {
    ...actual,
    getU18Status: vi.fn().mockResolvedValue({
      hasBirthData: true,
      isMinor: false,
      guardianVerified: false,
    }),
  };
});

// The map SDK providers register themselves on import — never load them.
vi.mock('@/components/map/providers', () => ({}));

interface MapViewStubProps {
  items: Array<{ id: string; domain?: string; data: Record<string, unknown> }>;
  emptyMessage?: string;
  filtersSlot?: React.ReactNode;
  onViewportChange?: (viewport: MapViewport) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
}

function MapViewStub({
  items,
  emptyMessage,
  filtersSlot,
  onViewportChange,
  renderPopup,
}: MapViewStubProps) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const open = items.find((item) => item.id === openId);
  return (
    <div data-testid="map-view">
      {filtersSlot}
      <button
        type="button"
        onClick={() =>
          onViewportChange?.({
            lat: 12.9,
            lng: 77.6,
            radiusMeters: 5000,
            zoom: 12,
            minLat: 12.8,
            minLng: 77.5,
            maxLat: 13,
            maxLng: 77.7,
          })
        }
      >
        report viewport
      </button>
      {items.length === 0 && <p>{emptyMessage}</p>}
      {items.map((item) => (
        <button key={item.id} type="button" onClick={() => setOpenId(item.id)}>
          {`marker ${item.id}`}
        </button>
      ))}
      {open &&
        renderPopup?.({
          id: `${open.id}#0`,
          lat: 12.9,
          lng: 77.6,
          label: 'Item',
          data: {},
          precision: 'exact',
          domain: open.domain,
        })}
    </div>
  );
}

vi.mock('@/components/map/map-container', () => ({
  MapView: (props: MapViewStubProps) => <MapViewStub {...props} />,
}));

interface FiltersStubProps {
  domains: DotNetworkDomain[];
  filterFieldDomains: DotNetworkDomain[];
  selectedDomains: string[];
  onDomainsChange: (domains: string[]) => void;
  selectedFields: Record<string, string[]>;
  onFieldsChange: (fields: Record<string, string[]>) => void;
  showDomainToggle?: boolean;
  viewMode?: ViewMode;
}

// The real panel has its own test suite (browse-filters-panel.test.tsx); this stub
// keeps the popover machinery out of the way while still driving home-page's
// filter handlers and reflecting what the page hands back down.
function FiltersStub({
  filterFieldDomains,
  selectedDomains,
  onDomainsChange,
  selectedFields,
  onFieldsChange,
  showDomainToggle,
  viewMode,
}: FiltersStubProps) {
  return (
    <div
      data-testid="filters-panel"
      data-view-mode={viewMode}
      data-show-domain-toggle={String(showDomainToggle)}
      data-filter-field-domains={filterFieldDomains.map((d) => d.id).join(',')}
      data-selected-domains={selectedDomains.join(',')}
      data-selected-fields={JSON.stringify(selectedFields)}
    >
      <button type="button" onClick={() => onFieldsChange({ gender: ['female'] })}>
        apply gender filter
      </button>
      <button type="button" onClick={() => onDomainsChange(['mentor'])}>
        apply domain filter
      </button>
    </div>
  );
}

vi.mock('@/components/filters/browse-filters-panel', () => ({
  BrowseFiltersPanel: (props: FiltersStubProps) => <FiltersStub {...props} />,
}));

// ─── harness ─────────────────────────────────────────────────────────────────

function UrlProbe() {
  const location = useLocation();
  return <div data-testid="url">{location.search}</div>;
}

function renderHome(initialUrl = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <QueryClientProvider client={client}>
        <HomePage />
        <UrlProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function url(): string {
  return screen.getByTestId('url').textContent ?? '';
}

// A browse card renders its title twice — once as the card heading and once as
// the schema-driven field row for the title field — so card presence is
// asserted on the card element rather than a single text node.
function cardFor(title: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-item-card]')).find((card) =>
      card.textContent?.includes(title),
    ) ?? null
  );
}

function expectCard(title: string): HTMLElement {
  const card = cardFor(title);
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

function expectNoCard(title: string): void {
  expect(cardFor(title)).toBeNull();
}

function findCard(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const card = cardFor(title);
    if (!card) throw new Error(`no browse card titled ${title}`);
    return card;
  });
}

function browseOptsFor(domainId: string): BrowseOpts | undefined {
  const calls = browseCalls.filter((c) => c.domainId === domainId);
  return calls.length > 0 ? calls[calls.length - 1].opts : undefined;
}

function lastMarkerCall(): MarkerCall {
  return markerCalls[markerCalls.length - 1];
}

function signedInSeeker() {
  state.myItems = [myProfile];
  state.browse = {
    provider: { ...emptyBrowse(), items: [providerItem1, providerItem2], total: 3 },
    mentor: { ...emptyBrowse(), items: [mentorItem], total: 2 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  browseCalls.length = 0;
  markerCalls.length = 0;
  preferredSources.length = 0;
  state.networks = [networkFixture];
  state.network = networkFixture;
  state.user = { id: 'u1', name: 'Seeker One' };
  state.myItems = [];
  state.actions = [];
  state.browse = {};
  state.markers = [];
  state.markersTotal = 0;
  state.markersPartial = false;
  state.markersTruncated = false;
  state.detail = { item: null, isLoading: false };
  state.location = null;
  state.locationSource = 'none';
  state.browserSupported = false;
  state.browserStatus = 'idle';
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('HomePage — network config gate', () => {
  it('renders a skeleton shell (no browse chrome) until the network config resolves', () => {
    state.networks = [];
    state.network = null;
    renderHome();

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Browse All' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });
});

describe('HomePage — signed-out browsing', () => {
  it('shows the guest hero instead of the content header', () => {
    state.user = null;
    renderHome('/?view=list');

    expect(screen.getByText('Sign in to connect')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Browse All' })).not.toBeInTheDocument();
  });

  // #644 (spec D8/D19): the "All" tab is gone, so a visitor browses ONE domain
  // — the first visible one — rather than every to_domain at once. That the
  // seeker domain is *browsable* for a profile-less visitor is now a property
  // of the domain control's option list, covered by its own tests, not
  // observable as a parallel fetch here.
  it('browses a single default domain for a visitor with no domain identity', async () => {
    // A visitor has no viewer domain, so there is no interacting-counterpart
    // preference to apply (spec D19) and the first VISIBLE domain wins. For a
    // profile-less visitor `computeVisibleDomains` yields every `to_domain`,
    // and `seeker` is declared first in this network — so that is the default.
    // It is arbitrary but deterministic, and it is the schema's own ordering.
    state.user = null;
    state.browse = {
      provider: { ...emptyBrowse(), items: [providerItem1], total: 1 },
      mentor: { ...emptyBrowse(), items: [mentorItem], total: 1 },
    };
    renderHome('/?view=list');

    await waitFor(() => expect(browsedDomains()).toEqual(new Set(['seeker'])));
  });

  it('tells a visitor the network is empty when no domain returns anything', async () => {
    state.user = null;
    renderHome('/?view=list');

    expect(await screen.findByText('No listings in this network yet.')).toBeInTheDocument();
  });
});

describe('HomePage — signed-in default domain (#644)', () => {
  it('reports the selected domain’s own total in the header and the X-of-Y indicator', async () => {
    // Previously these were sums across every visible domain, because the
    // "All" tab merged N feeds. One feed now drives both numbers, so they
    // can no longer disagree with each other or with the server.
    signedInSeeker();
    renderHome('/?view=list');

    await findCard('Acme Welding');
    expect(screen.getByText('3 listings')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
  });

  it('lands on an interacting counterpart domain and never browses a non-interacting one', async () => {
    // The interaction matrix still governs (spec D7 — it is made visible, not
    // relaxed): a seeker must not land on seekers, where every card would hide
    // its Connect button and signals-search would refuse the relevance anchor.
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');

    const browsed = browsedDomains();
    expect(browsed.has('provider')).toBe(true);
    expect(browsed.has('seeker')).toBe(false);
  });

  it('sends the active profile as the discover anchor for an interacting domain', async () => {
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');

    expect(browseOptsFor('provider')?.anchorItemId).toBe('me-1');
    expect(browseOptsFor('provider')?.relevance).toBe(true);
  });

  it('prompts a signed-in user with no profile to create one', async () => {
    state.myItems = [];
    renderHome('/?view=list');

    expect(await screen.findByText('Create your profile')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: 'Create Profile' });
    expect(cta).toHaveAttribute('href', '/profile/new?network=blue_dot');
  });
});

describe('HomePage — domain tab switching', () => {
  it('switches to a single-domain feed, retitles the header and records it in the URL', async () => {
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');

    await userEvent.click(screen.getByRole('button', { name: 'Provider' }));

    expect(await screen.findByRole('heading', { name: 'Provider' })).toBeInTheDocument();
    expect(screen.getByText('Employers hiring')).toBeInTheDocument();
    expect(url()).toContain('domain=provider');
    // Now driven by the single-domain paged feed (2 loaded of 3).
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
    expectNoCard('Rita Mentor');
    expect(browseOptsFor('provider')?.enabled).toBe(true);
  });

  // #644 (spec D8): there is no "All" entry to return to. A `?domain=` naming
  // a domain the viewer cannot browse is repaired to a valid default rather
  // than falling back to an all-domains view.
  it('repairs an unbrowsable ?domain= to a valid default instead of showing everything', async () => {
    signedInSeeker();
    renderHome('/?view=list&domain=seeker');

    await findCard('Acme Welding');
    await waitFor(() => expect(url()).toContain('domain=provider'));
    expect(browsedDomains().has('seeker')).toBe(false);
  });

  it('clears the facet + map-domain filter params when the browse domain changes', async () => {
    signedInSeeker();
    renderHome('/?view=list&domain=provider&f_gender=female&map_domains=provider');
    await findCard('Acme Welding');

    // Restored from the URL on mount and forwarded to the feed.
    expect(browseOptsFor('provider')?.filters).toEqual([{ field: 'gender', values: ['female'] }]);

    await userEvent.click(screen.getByRole('button', { name: 'Mentor' }));

    await waitFor(() => expect(url()).toContain('domain=mentor'));
    expect(url()).not.toContain('f_gender');
    expect(url()).not.toContain('map_domains');
    expect(browseOptsFor('mentor')?.filters).toEqual([]);
  });

  it('scopes the filter fields to the selected domain', async () => {
    // #644: a domain is always selected, so the facet groups are always scoped
    // to exactly one domain's schema — there is no counterpart-union case left.
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');

    expect(screen.getByTestId('filters-panel')).toHaveAttribute(
      'data-filter-field-domains',
      'provider',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Mentor' }));

    await waitFor(() =>
      expect(screen.getByTestId('filters-panel')).toHaveAttribute(
        'data-filter-field-domains',
        'mentor',
      ),
    );
  });
});

describe('HomePage — map/list view toggle', () => {
  it('defaults to the map when no view is in the URL', () => {
    signedInSeeker();
    renderHome();

    expect(screen.getByTestId('map-view')).toBeInTheDocument();
  });

  it('switches list → map → list and records the mode in the URL', async () => {
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');
    expect(screen.queryByTestId('map-view')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Map view' }));

    expect(await screen.findByTestId('map-view')).toBeInTheDocument();
    expect(url()).toContain('view=map');
    expectNoCard('Acme Welding');

    await userEvent.click(screen.getByRole('radio', { name: 'List view' }));

    expect(await findCard('Acme Welding')).toBeInTheDocument();
    expect(url()).toContain('view=list');
  });
});

describe('HomePage — map view', () => {
  it('fetches no markers until the map reports its first viewport', async () => {
    signedInSeeker();
    state.markers = [
      { item_id: 'p1', item_domain: 'provider', item_instance_url: null, item_locations: [{ lat: 12.91, lng: 77.61 }] },
    ];
    state.markersTotal = 1;
    renderHome('/?view=map');

    expect(lastMarkerCall().viewport).toBeNull();
    expect(
      screen.getByText('No listings in this area — zoom out or move the map to find results.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'report viewport' }));

    expect(await screen.findByRole('button', { name: 'marker p1' })).toBeInTheDocument();
    expect(lastMarkerCall().viewport).not.toBeNull();
  });

  // #644 (spec D11/D12): the map is MULTI-domain and is NOT bound to the
  // list's single selection. Binding it to the tab was fine while the "All"
  // tab existed (null meant every domain), but with a domain always selected
  // that rule would pin the map to one domain and destroy its multi-domain
  // view. The map's own selection now decides which /markers requests are
  // ISSUED, rather than which fetched markers survive a post-filter.
  it('fetches every visible domain regardless of the list’s selected domain', async () => {
    signedInSeeker();
    renderHome('/?view=map&domain=provider');

    await waitFor(() => expect(lastMarkerCall().domainIds).toEqual(['provider', 'mentor']));
  });

  it('narrows the marker fetch itself when the map domain selection narrows', async () => {
    signedInSeeker();
    renderHome('/?view=map&map_domains=mentor');

    await waitFor(() => expect(lastMarkerCall().domainIds).toEqual(['mentor']));
  });

  it('warns when the federated marker set is known-partial', async () => {
    signedInSeeker();
    state.markersPartial = true;
    state.markersTotal = 4;
    renderHome('/?view=map');

    await userEvent.click(screen.getByRole('button', { name: 'report viewport' }));

    expect(
      await screen.findByText(
        'Some sources are unavailable right now — the map may not show every listing.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the count pill to a signed-out visitor when markers are capped', async () => {
    state.user = null;
    state.markers = [
      { item_id: 'p1', item_domain: 'provider', item_instance_url: null, item_locations: [{ lat: 12.91, lng: 77.61 }] },
    ];
    state.markersTotal = 42;
    renderHome('/?view=map');

    await userEvent.click(screen.getByRole('button', { name: 'report viewport' }));

    expect(await screen.findByText('Showing 1 of 42')).toBeInTheDocument();
  });

  it('lazily loads a clicked marker’s full item into its popup', async () => {
    signedInSeeker();
    state.markers = [
      { item_id: 'p1', item_domain: 'provider', item_instance_url: null, item_locations: [{ lat: 12.91, lng: 77.61 }] },
    ];
    state.markersTotal = 1;
    state.detail = { item: null, isLoading: true };
    renderHome('/?view=map');

    await userEvent.click(screen.getByRole('button', { name: 'report viewport' }));
    await userEvent.click(await screen.findByRole('button', { name: 'marker p1' }));

    const map = screen.getByTestId('map-view');
    expect(within(map).getByText('Loading details...')).toBeInTheDocument();
  });

  it('renders the resolved item’s title in the marker popup', async () => {
    signedInSeeker();
    state.markers = [
      { item_id: 'p1', item_domain: 'provider', item_instance_url: null, item_locations: [{ lat: 12.91, lng: 77.61 }] },
    ];
    state.markersTotal = 1;
    state.detail = { item: providerItem1, isLoading: false };
    renderHome('/?view=map');

    await userEvent.click(screen.getByRole('button', { name: 'report viewport' }));
    await userEvent.click(await screen.findByRole('button', { name: 'marker p1' }));

    const map = screen.getByTestId('map-view');
    expect(within(map).getAllByText('Acme Welding').length).toBeGreaterThan(0);
  });
});

describe('HomePage — search', () => {
  it('forwards the typed query to the active list feed and reports no results', async () => {
    // #644: one feed, so the query reaches the selected domain only — it used
    // to fan out across every domain of the "All" tab.
    signedInSeeker();
    state.browse = { provider: emptyBrowse(), mentor: emptyBrowse() };
    renderHome('/?view=list');

    await userEvent.type(screen.getByRole('searchbox'), 'welder');

    await waitFor(() => expect(browseOptsFor('provider')?.q).toBe('welder'));
    expect(await screen.findByText('No results for "welder"')).toBeInTheDocument();
  });

  it('forwards the typed query to the map marker fetch too', async () => {
    signedInSeeker();
    renderHome('/?view=map');

    await userEvent.type(screen.getByRole('searchbox'), 'welder');

    await waitFor(() => expect(lastMarkerCall().search).toBe('welder'));
  });
});

describe('HomePage — filter panel wiring', () => {
  it('writes a chosen facet to the URL and forwards it to the feed', async () => {
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');

    await userEvent.click(screen.getByRole('button', { name: 'apply gender filter' }));

    await waitFor(() => expect(url()).toContain('f_gender=female'));
    expect(browseOptsFor('provider')?.filters).toEqual([{ field: 'gender', values: ['female'] }]);
    expect(screen.getByTestId('filters-panel')).toHaveAttribute(
      'data-selected-fields',
      '{"gender":["female"]}',
    );
  });

  // #644 (spec D12): the map's domain selection is a MAP concern. It used to
  // feed the list's client-side card filter too, which meant picking a domain
  // other than the browsed one blanked the list entirely. It is recorded in
  // the URL and shapes the map; it must not empty the list.
  it('records the map domain selection in the URL without emptying the list', async () => {
    signedInSeeker();
    renderHome('/?view=list');
    await findCard('Acme Welding');

    await userEvent.click(screen.getByRole('button', { name: 'apply domain filter' }));

    await waitFor(() => expect(url()).toContain('map_domains=mentor'));
    expectCard('Acme Welding');
  });

  it('forwards facet selections to the map marker fetch as server-side filters', async () => {
    signedInSeeker();
    renderHome('/?view=map&f_gender=female');

    expect(lastMarkerCall().filters).toEqual({ gender: ['female'] });
  });
});

describe('HomePage — list notes and degradation banners', () => {
  it('explains anchor + radius ranking above a populated list', async () => {
    signedInSeeker();
    state.location = { lat: 12.9, lng: 77.6 };
    state.locationSource = 'profile';
    state.browse = {
      provider: { ...emptyBrowse(), items: [providerItem1], total: 1, distanceMeters: 25000 },
      mentor: emptyBrowse(),
    };
    renderHome('/?view=list');

    expect(
      await screen.findByText(
        'Showing profiles relevant to your profile, within 25 km of your profile location.',
      ),
    ).toBeInTheDocument();
  });

  it('warns when the list feed is federation-partial', async () => {
    signedInSeeker();
    state.browse = {
      provider: { ...emptyBrowse(), items: [providerItem1], total: 1, partial: true },
      mentor: emptyBrowse(),
    };
    renderHome('/?view=list');

    expect(
      await screen.findByText(
        'Some sources are unavailable right now — results may be incomplete.',
      ),
    ).toBeInTheDocument();
  });

  it('says ranking is unavailable when discover fell back to the native path', async () => {
    signedInSeeker();
    state.browse = {
      provider: { ...emptyBrowse(), items: [providerItem1], total: 1, degraded: true },
      mentor: emptyBrowse(),
    };
    renderHome('/?view=list');

    expect(
      await screen.findByText(
        'Showing basic matches — relevance ranking is temporarily unavailable.',
      ),
    ).toBeInTheDocument();
  });

  it('blames the radius, not the network, when a located search returns nothing', async () => {
    signedInSeeker();
    state.location = { lat: 12.9, lng: 77.6 };
    state.locationSource = 'profile';
    state.browse = {
      provider: { ...emptyBrowse(), distanceMeters: 25000 },
      mentor: emptyBrowse(),
    };
    renderHome('/?view=list');

    expect(
      await screen.findByText(
        'No listings within 25 km of your profile location — try a different location or the map view.',
      ),
    ).toBeInTheDocument();
  });
});

describe('HomePage — location source toggle', () => {
  it('hides the toggle when the browser cannot supply a location', async () => {
    signedInSeeker();
    state.browserSupported = false;
    renderHome('/?view=list');
    await findCard('Acme Welding');

    expect(screen.queryByRole('radio', { name: 'Current location' })).not.toBeInTheDocument();
  });

  it('requests the browser location and re-resolves against the picked source', async () => {
    signedInSeeker();
    state.browserSupported = true;
    renderHome('/?view=list');
    await findCard('Acme Welding');

    await userEvent.click(screen.getByRole('radio', { name: 'Current location' }));

    expect(requestBrowserLocation).toHaveBeenCalled();
    expect(preferredSources[preferredSources.length - 1]).toBe('browser');
  });

  it('offers to enable location after a failed browser request', async () => {
    signedInSeeker();
    state.browserSupported = true;
    state.browserStatus = 'error';
    renderHome('/?view=list');
    await findCard('Acme Welding');

    await userEvent.click(screen.getByRole('radio', { name: 'Current location' }));

    expect(await screen.findByText('Showing results near your profile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on location' })).toBeInTheDocument();
  });
});

describe('HomePage — actions on browse cards', () => {
  it('opens the action form for the schema-declared connect action', async () => {
    signedInSeeker();
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await userEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]);

    expect(
      await screen.findByText('Share details so the other party can review your request.'),
    ).toBeInTheDocument();
  });

  it('disables the CTA for a pair that already has an open action', async () => {
    signedInSeeker();
    state.actions = [
      { action_status: 'pending', source_item_id: 'me-1', target_item_id: 'p1' },
    ];
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    const blocked = expectCard('Acme Welding');
    const open = expectCard('Globex Foundry');
    expect(within(blocked).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(within(open).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });
});

describe('HomePage — bulk selection', () => {
  it('enters select mode and offers a bulk connect for the picked cards', async () => {
    signedInSeeker();
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await userEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Acme Welding/ }));

    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect (1)' })).toBeInTheDocument();
  });

  it('offers no select mode to a viewer without a profile', async () => {
    state.myItems = [];
    renderHome('/?view=list&domain=provider');

    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
  });
});
