import { useQuery } from '@tanstack/react-query';
import { fetchNetworkItems } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import { queryKeys } from '@/lib/query-keys';

// One item by id, for a marker click-through. The same id resolves to the same
// row for a session, so this uses the 5-minute tier rather than the 90s browse
// tier.
const ITEM_DETAIL_STALE_TIME_MS = 5 * 60 * 1000;

export interface ItemDetailRef {
  item_id: string;
  item_domain: string;
  item_type?: string;
  item_instance_url?: string | null;
}

interface UseItemDetailResult {
  item: Item | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Lazily fetches one item's full detail by id. Routed via `item_instance_url`
 * when known, so the fetch goes to the owning instance. `opts.enabled` gates it
 * on, e.g., the popup being open.
 */
export function useItemDetail(
  networkId: string | null,
  item: ItemDetailRef | null,
  opts?: { enabled?: boolean },
): UseItemDetailResult {
  const enabled = !!networkId && !!item && (opts?.enabled ?? true);

  const query = useQuery({
    queryKey:
      networkId && item
        ? queryKeys.itemDetail(networkId, item.item_id)
        : (['item-detail', null] as const),
    queryFn: async ({ signal }): Promise<Item | null> => {
      const res = await fetchNetworkItems(
        {
          item_network: networkId!,
          item_domain: item!.item_domain,
          item_type: item!.item_type ?? 'profile',
          item_id: item!.item_id,
          item_instance_url: item!.item_instance_url ?? undefined,
          limit: 1,
          offset: 0,
        },
        signal,
      );
      return res.items[0] ?? null;
    },
    enabled,
    staleTime: ITEM_DETAIL_STALE_TIME_MS,
  });

  return { item: query.data ?? null, isLoading: query.isLoading, isError: query.isError };
}
