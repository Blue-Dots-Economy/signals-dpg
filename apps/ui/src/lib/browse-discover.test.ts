import { describe, it, expect } from 'vitest';
import {
  deriveBrowseParams,
  buildFilteredCardsForDomain,
  excludeOwnItems,
  isDiscoverActive,
  hasActiveSearchOrFilters,
  resolveDegradedBanner,
} from './browse-discover';
import type { EnumFilterField } from './enum-filters';
import type { Item } from './item-api';

function makeItem(id: string, state: Record<string, unknown>, domain = 'provider'): Item {
  return {
    item_id: id,
    item_network: 'purple_dot',
    item_domain: domain,
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: state,
    item_locations: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('deriveBrowseParams', () => {
  it('Near me ON → proximity: useLocation true, relevance false', () => {
    const p = deriveBrowseParams({ nearMe: true, search: '', activeFieldFilters: {} });
    expect(p.useLocation).toBe(true);
    expect(p.relevance).toBe(false);
  });

  it('Near me OFF → relevance: useLocation false, relevance true', () => {
    const p = deriveBrowseParams({ nearMe: false, search: '', activeFieldFilters: {} });
    expect(p.useLocation).toBe(false);
    expect(p.relevance).toBe(true);
  });

  it('trims search into q and maps activeFieldFilters to a DiscoverFacetFilter[]', () => {
    const p = deriveBrowseParams({
      nearMe: false,
      search: '  teacher  ',
      activeFieldFilters: { subject: ['math', 'science'] },
    });
    expect(p.q).toBe('teacher');
    expect(p.filters).toEqual([{ field: 'subject', values: ['math', 'science'] }]);
  });

  it('empty inputs → no q and empty filters', () => {
    const p = deriveBrowseParams({ nearMe: true, search: '   ', activeFieldFilters: {} });
    expect(p.q).toBeUndefined();
    expect(p.filters).toEqual([]);
  });
});

describe('isDiscoverActive', () => {
  it('true when relevance set, or q present, or filters present; false otherwise', () => {
    expect(isDiscoverActive({ relevance: true, filters: [] })).toBe(true);
    expect(isDiscoverActive({ relevance: false, q: 'x', filters: [] })).toBe(true);
    expect(isDiscoverActive({ relevance: false, filters: [{ field: 'a', values: ['b'] }] })).toBe(true);
    expect(isDiscoverActive({ relevance: false, filters: [] })).toBe(false);
  });
});

describe('buildFilteredCardsForDomain discover bypass', () => {
  const enumFields: EnumFilterField[] = [
    { key: 'subject', label: 'Subject', options: ['math', 'science'], isArray: false, filterable: true },
  ];
  // Item text has neither the search substring "welder" nor the selected enum
  // value "science" — a valid semantic-search hit that the client MUST NOT drop.
  const items = [makeItem('a', { subject: 'math', bio: 'loves algebra' })];
  const opts = (discover: boolean) => ({
    search: 'welder',
    mapSelectedDomains: [] as string[],
    activeFieldFilters: { subject: ['science'] },
    enumFilterFields: enumFields,
    discover,
  });

  it('native path drops a card that matches neither the text nor the enum filter', () => {
    expect(buildFilteredCardsForDomain('provider', items, opts(false))).toHaveLength(0);
  });

  it('discover path keeps that card (server already applied text + facet filtering)', () => {
    const cards = buildFilteredCardsForDomain('provider', items, opts(true));
    expect(cards.map((c) => c.id)).toEqual(['a']);
  });

  it('map-domain skip still applies on the discover path', () => {
    const cards = buildFilteredCardsForDomain('provider', items, {
      ...opts(true),
      mapSelectedDomains: ['seeker'],
    });
    expect(cards).toHaveLength(0);
  });
});

describe('hasActiveSearchOrFilters', () => {
  it('true when q is set', () => {
    expect(hasActiveSearchOrFilters({ q: 'teacher', filters: [] })).toBe(true);
  });

  it('true when filters is non-empty', () => {
    expect(
      hasActiveSearchOrFilters({ filters: [{ field: 'subject', values: ['math'] }] }),
    ).toBe(true);
  });

  it('false for the relevance-only default (no q, no filters)', () => {
    expect(hasActiveSearchOrFilters({ filters: [] })).toBe(false);
  });

  it('false for fully empty input', () => {
    expect(hasActiveSearchOrFilters({ q: undefined, filters: [] })).toBe(false);
  });
});

describe('resolveDegradedBanner', () => {
  it('null when not degraded, regardless of search/filter state', () => {
    expect(resolveDegradedBanner({ degraded: false, searchOrFiltersActive: true })).toBeNull();
    expect(resolveDegradedBanner({ degraded: false, searchOrFiltersActive: false })).toBeNull();
  });

  it('"search_unavailable" when degraded AND search/filters active', () => {
    expect(resolveDegradedBanner({ degraded: true, searchOrFiltersActive: true })).toBe(
      'search_unavailable',
    );
  });

  it('"ranking_unavailable" when degraded AND no search/filters active', () => {
    expect(resolveDegradedBanner({ degraded: true, searchOrFiltersActive: false })).toBe(
      'ranking_unavailable',
    );
  });
});

describe('excludeOwnItems', () => {
  it('removes the viewer own item upstream, and the discover bypass does not reintroduce it', () => {
    const own = makeItem('me', { bio: 'x' });
    const other = makeItem('other', { bio: 'y' });
    const filtered = excludeOwnItems([own, other], new Set(['me']));
    const cards = buildFilteredCardsForDomain('provider', filtered, {
      search: '',
      mapSelectedDomains: [],
      activeFieldFilters: {},
      enumFilterFields: [],
      discover: true,
    });
    expect(cards.map((c) => c.id)).toEqual(['other']);
  });
});
