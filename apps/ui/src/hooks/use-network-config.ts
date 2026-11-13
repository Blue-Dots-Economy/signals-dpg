import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  fetchSchemaEntries,
  networkConfigIn,
  networkConfigsIn,
  type CachedSchemaEntry,
} from '@/lib/network-api';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import { apiConfig } from '@/lib/api-config';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

interface UseNetworkConfigResult {
  data: DotNetworkSchema | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  /** Re-runs the query, for a user-initiated retry. */
  refetch: () => void;
}

const CONFIG_STALE_TIME = 5 * 60 * 1000;

/** The deployment's schema entries, fetched once and shared by every config hook. */
export function fetchSharedSchemaEntries(queryClient: QueryClient): Promise<CachedSchemaEntry[]> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.networkSchemas(),
    queryFn: fetchSchemaEntries,
    staleTime: CONFIG_STALE_TIME,
  });
}

/** One network's config (config tier, 5 minutes), read from the shared schema entries. */
export function useNetworkConfig(networkId: string | null): UseNetworkConfigResult {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: networkId ? queryKeys.networkConfig(networkId) : ['network-config', null],
    queryFn: async () => {
      if (!networkId) return null;
      return networkConfigIn(await fetchSharedSchemaEntries(queryClient), networkId);
    },
    enabled: !!networkId,
    staleTime: CONFIG_STALE_TIME,
  });

  return {
    data: data ?? null,
    isLoading,
    isError,
    error: error ?? null,
    refetch: () => {
      void refetch();
    },
  };
}

interface UseNetworkConfigsResult {
  data: DotNetworkSchema[] | null;
  isLoading: boolean;
  isError: boolean;
}

/** Fetches the list of network configs this deployment serves (config tier). */
export function useNetworkConfigs(): UseNetworkConfigsResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.networkSchemas(),
    queryFn: fetchSchemaEntries,
    staleTime: CONFIG_STALE_TIME,
    select: networkConfigsIn,
  });
  return { data: data ?? null, isLoading, isError };
}

interface UseResolvedNetworkResult {
  data: DotNetworkSchema | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fetches a network config and resolves its `$ref`s. The raw config shares
 * `useNetworkConfig`'s cache; the resolved one is keyed by API base URL too.
 */
export function useResolvedNetwork(networkId: string | null): UseResolvedNetworkResult {
  const {
    data: rawConfig,
    isLoading: rawLoading,
    isError: rawError,
  } = useNetworkConfig(networkId);
  const apiBaseUrl = apiConfig.getUrl();

  const { data, isLoading, isError } = useQuery({
    queryKey:
      networkId != null
        ? queryKeys.resolvedNetwork(networkId, apiBaseUrl)
        : ['resolved-network', null, apiBaseUrl],
    queryFn: async () => {
      if (!rawConfig) return null;
      const resolved = await resolveNetworkRefs(rawConfig, { baseUrl: apiBaseUrl });
      return resolved as DotNetworkSchema;
    },
    enabled: !!rawConfig,
    staleTime: 5 * 60 * 1000,
  });

  return {
    data: data ?? null,
    // Loading while the raw config loads, or while resolution runs after it.
    isLoading: rawLoading || (!!rawConfig && isLoading),
    isError: rawError || isError,
  };
}
