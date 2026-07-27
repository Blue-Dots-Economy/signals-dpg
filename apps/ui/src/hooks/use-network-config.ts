import { useQuery } from '@tanstack/react-query';
import { fetchNetworkConfig, fetchNetworkConfigs } from '@/lib/network-api';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import { apiConfig } from '@/lib/api-config';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

interface UseNetworkConfigResult {
  data: DotNetworkSchema | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

/**
 * Hook to fetch and cache a specific network configuration
 * @param networkId - The id of the network to fetch
 * @returns Network config data and query state
 */
export function useNetworkConfig(networkId: string | null): UseNetworkConfigResult {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: networkId ? queryKeys.networkConfig(networkId) : ['network-config', null],
    queryFn: async () => {
      if (!networkId) return null;
      return fetchNetworkConfig(networkId);
    },
    enabled: !!networkId,
    staleTime: 5 * 60 * 1000, // 5 minutes cache
  });

  return {
    data: data ?? null,
    isLoading,
    isError,
    error: error ?? null,
  };
}

interface UseNetworkConfigsResult {
  data: DotNetworkSchema[] | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Hook to fetch and cache the full list of network configs (used to discover
 * which networks a deployment serves). Config tier: 5-minute staleTime.
 */
export function useNetworkConfigs(): UseNetworkConfigsResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.networkConfigs(),
    queryFn: fetchNetworkConfigs,
    staleTime: 5 * 60 * 1000,
  });
  return { data: data ?? null, isLoading, isError };
}

interface UseResolvedNetworkResult {
  data: DotNetworkSchema | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Hook to fetch a network config and resolve its `$ref`s. Composes
 * `useNetworkConfig` (so the raw config shares the cache with other consumers,
 * e.g. action components) and caches the resolved result under a key that
 * includes the API base URL (so an instance switch re-resolves). Config tier.
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
