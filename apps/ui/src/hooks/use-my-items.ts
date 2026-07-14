import { useQuery } from '@tanstack/react-query';
import { fetchItems, type Item } from '@/lib/item-api';
import { useAuth } from '@/contexts/auth-context';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

interface UseMyItemsResult {
  data: Item[];
  isLoading: boolean;
  isFetched: boolean;
}

/**
 * Fetch the current user's items (`created_by_me`) across every domain of a
 * network and flatten them. Used by the profile form's single-domain lock and
 * (Plan 2b-iv) the home-page "my profiles" list. Own-data tier: 60 s staleTime;
 * invalidate-on-write is wired in 2b-iv. A per-domain fetch that rejects
 * contributes an empty list (a partial failure never fails the whole query),
 * matching the page's prior `.catch(() => [])` behavior.
 */
export function useMyItems(network: DotNetworkSchema | null): UseMyItemsResult {
  const { user } = useAuth();

  const { data, isLoading, isFetched } = useQuery({
    queryKey: network ? queryKeys.myItems(network.id) : ['my-items', null],
    queryFn: async ({ signal }) => {
      if (!network) return [];
      const results = await Promise.all(
        (network.domains ?? []).map((domain) => {
          const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
          const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
          return fetchItems(
            {
              item_network: network.id,
              item_domain: domain.id,
              item_type: itemType,
              created_by_me: true,
              limit: 100,
            },
            signal,
          )
            .then((res) => res.items)
            .catch(() => [] as Item[]);
        }),
      );
      return results.flat();
    },
    enabled: !!network && !!user,
    staleTime: 60 * 1000,
  });

  return { data: data ?? [], isLoading, isFetched };
}
