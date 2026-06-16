import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateDomainGate, resolveHeldDomains } from './domain-gate';
import { fetchNetworkConfig } from '@/lib/network-api';
import { fetchItems } from '@/lib/item-api';

vi.mock('@/lib/network-api', () => ({ fetchNetworkConfig: vi.fn() }));
vi.mock('@/lib/item-api', () => ({ fetchItems: vi.fn() }));

const mockedFetchNetworkConfig = vi.mocked(fetchNetworkConfig);
const mockedFetchItems = vi.mocked(fetchItems);

describe('evaluateDomainGate', () => {
  it('allows a new user with no profiles', () => {
    expect(evaluateDomainGate([], 'provider')).toEqual({ allow: true });
  });
  it('allows a user whose profile is in the bound domain', () => {
    expect(evaluateDomainGate(['provider'], 'provider')).toEqual({ allow: true });
  });
  it('blocks a user whose profile is in another domain (names it)', () => {
    expect(evaluateDomainGate(['seeker'], 'provider')).toEqual({
      allow: false,
      heldDomain: 'seeker',
    });
  });
  it('blocks when any held domain differs from the bound domain', () => {
    expect(evaluateDomainGate(['provider', 'seeker'], 'provider')).toEqual({
      allow: false,
      heldDomain: 'seeker',
    });
  });
});

describe('resolveHeldDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchNetworkConfig.mockResolvedValue({
      id: 'purple_dot',
      domains: [
        { id: 'seeker', item_schemas: { 'profile_1.0': {} } },
        { id: 'provider', item_schemas: { 'profile_1.0': {} } },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchNetworkConfig>>);
  });

  it('returns the domains where the user has at least one item', async () => {
    mockedFetchItems.mockImplementation(async ({ item_domain }) =>
      ({ items: item_domain === 'seeker' ? [{ item_id: 'x' }] : [] }) as unknown as Awaited<
        ReturnType<typeof fetchItems>
      >);
    expect(await resolveHeldDomains('purple_dot')).toEqual(['seeker']);
  });

  it('fail-open: a probe that rejects is treated as no item in that domain', async () => {
    mockedFetchItems.mockImplementation(async ({ item_domain }) => {
      if (item_domain === 'seeker') throw new Error('transient');
      return { items: [] } as unknown as Awaited<ReturnType<typeof fetchItems>>;
    });
    expect(await resolveHeldDomains('purple_dot')).toEqual([]);
  });
});
