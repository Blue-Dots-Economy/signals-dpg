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
 * The current user's items (`created_by_me`) across every domain of a network,
 * flattened. Own-data tier: 60s staleTime plus invalidate-on-write. A domain
 * whose fetch rejects contributes an empty list rather than failing the query.
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
