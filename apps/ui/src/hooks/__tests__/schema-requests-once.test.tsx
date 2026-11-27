import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNetworkConfig, useNetworkConfigs } from '../use-network-config';
import { useConsentConfig } from '../use-consent-config';
import { queryKeys } from '@/lib/query-keys';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  createApiClient: () => ({ get }),
}));

vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({ themeId: 'blue_dot', brand: null }),
}));

const doc = (title: string) => ({
  current_version: 1,
  versions: [{ version: 1, title, content: title, effective_from: '2024-01-01' }],
});
const consent = (title: string) => ({
  documents: { terms: doc(title), privacy: doc(title), profile_creation: doc(title) },
});
const yellow = { id: 'yellow_dot', domains: [] };
const blue = { id: 'blue_dot', domains: [] };

const ENTRIES = [
  { cache_key: 'y-net', kind: 'network_config', network: 'yellow_dot', schema: yellow },
  { cache_key: 'y-consent', kind: 'consent_config', network: 'yellow_dot', schema: consent('Yellow') },
  { cache_key: 'b-net', kind: 'network_config', network: 'blue_dot', schema: blue },
  { cache_key: 'b-item', kind: 'domain_item_schema', network: 'blue_dot', domain: 'seeker', schema: {} },
  { cache_key: 'b-consent', kind: 'consent_config', network: 'blue_dot', schema: consent('Blue') },
];

function schemaRequests() {
  return get.mock.calls.filter(([url]) => url === '/api/v1/network/schemas');
}

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

let client: QueryClient;

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (_url: string, config?: { params?: { network?: string } }) => {
    const network = config?.params?.network;
    return { data: network ? ENTRIES.filter((e) => e.network === network) : ENTRIES };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function renderAll(networkId: string) {
  return renderHook(
    () => ({
      list: useNetworkConfigs(),
      one: useNetworkConfig(networkId),
      consent: useConsentConfig(),
    }),
    { wrapper: makeWrapper(client) },
  );
}

describe('network schemas on page load', () => {
  it('asks the API for the schemas once for the network list, network config and consent config', async () => {
    const { result } = renderAll('blue_dot');
    await waitFor(() => {
      expect(result.current.list.data).not.toBeNull();
      expect(result.current.one.data).not.toBeNull();
      expect(result.current.consent.config).not.toBeNull();
    });
    expect(schemaRequests()).toHaveLength(1);
  });

  it('gives each hook the same answer as before', async () => {
    const { result } = renderAll('blue_dot');
    await waitFor(() => expect(result.current.consent.config).not.toBeNull());
    await waitFor(() => expect(result.current.one.data).not.toBeNull());
    expect(result.current.list.data).toEqual([yellow, blue]);
    expect(result.current.one.data).toEqual(blue);
    expect(result.current.consent.config?.documents.terms.versions[0].title).toBe('Blue');
  });

  it('still reports an unknown network as not found', async () => {
    const { result } = renderAll('nope');
    await waitFor(() => expect(result.current.one.isError).toBe(true));
    expect(result.current.one.error?.message).toBe('Network "nope" not found');
  });

  it('keeps the network config readable straight from the cache', async () => {
    const { result } = renderAll('blue_dot');
    await waitFor(() => expect(result.current.one.data).not.toBeNull());
    expect(client.getQueryData(queryKeys.networkConfig('blue_dot'))).toEqual(blue);
  });
});
