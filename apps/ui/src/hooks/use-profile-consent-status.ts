import { useQuery } from '@tanstack/react-query';
import { getProfileConsentStatus } from '@/lib/consent-api';
import { useAuth } from '@/contexts/auth-context';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

/**
 * The current user's consented profile item ids for a network. Config tier
 * (5 min); the consent-accept flow updates this query. On error `data` is
 * undefined and consumers treat it as an empty set, so the gate still prompts.
 */
export function useProfileConsentStatus(network: DotNetworkSchema | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: network ? queryKeys.profileConsent(network.id) : ['profile-consent', null],
    queryFn: async (): Promise<Set<string>> => {
      if (!network) return new Set<string>();
      const res = await getProfileConsentStatus(network.id);
      return new Set(res.consented_item_ids);
    },
    enabled: !!network && !!user,
    staleTime: 5 * 60 * 1000,
  });
}
