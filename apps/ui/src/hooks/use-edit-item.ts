import { useQuery } from '@tanstack/react-query';
import { fetchItems, type Item } from '@/lib/item-api';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

/**
 * Locate a single item by id for the edit form. The item's domain is unknown
 * up front, so we probe the network's domains in order and return the first
 * match. Returns `null` when the search finishes with no match (distinct from
 * `undefined` = not loaded), so the caller can redirect on a genuine miss.
 * Own-data tier: 60 s staleTime.
 */
export function useEditItem(network: DotNetworkSchema | null, itemId: string | null) {
  return useQuery({
    queryKey:
      network && itemId
        ? queryKeys.editItem(network.id, itemId)
        : ['edit-item', null],
    queryFn: async ({ signal }): Promise<Item | null> => {
      if (!network || !itemId) return null;
      for (const domain of network.domains ?? []) {
        const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
        const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
        const response = await fetchItems(
          {
            item_network: network.id,
            item_domain: domain.id,
            item_type: itemType,
            item_id: itemId,
            limit: 1,
          },
          signal,
        );
        if (response.items.length > 0) return response.items[0];
      }
      return null;
    },
    enabled: !!network && !!itemId,
    staleTime: 60 * 1000,
  });
}
