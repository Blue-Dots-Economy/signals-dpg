import { useQuery } from '@tanstack/react-query';
import { fetchNetworkConfig } from '@/lib/network-api';
import type { DotNetworkSchema } from '@/engine/types';

const NETWORK_CONFIG_KEY = 'network-config';

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
    queryKey: [NETWORK_CONFIG_KEY, networkId],
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
