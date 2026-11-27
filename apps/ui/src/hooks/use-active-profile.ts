import * as React from 'react';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { getStoredActiveProfileId, setStoredActiveProfileId } from '@/lib/active-profile';

interface UseActiveProfileResult {
  activeProfileId: string | null;
  setActiveProfile: (id: string) => void;
  activeItem: Item | null;
}

/**
 * Which of the user's own profiles they are acting as, restored on load and
 * persisted per network. Used by pages outside home (home-page keeps its own
 * copy).
 *
 * Restore runs once per network: the stored id if it still names one of
 * `myItems`, else `myItems[0]`. It waits until `myItems` is non-empty, so a
 * fetch still in flight does not clear the stored id; with no owned profiles
 * the id stays null.
 */
export function useActiveProfile(
  network: DotNetworkSchema | null,
  myItems: Item[],
): UseActiveProfileResult {
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const restoredForNetwork = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!network) {
      restoredForNetwork.current = null;
      setActiveProfileId(null);
      return;
    }
    if (restoredForNetwork.current === network.id) return;
    if (myItems.length === 0) return;
    restoredForNetwork.current = network.id;

    const storedId = getStoredActiveProfileId(network.id);
    if (storedId && myItems.some((p) => p.item_id === storedId)) {
      setActiveProfileId(storedId);
    } else {
      setActiveProfileId(myItems[0].item_id);
      setStoredActiveProfileId(network.id, myItems[0].item_id);
    }
  }, [network, myItems]);

  const activeItem = React.useMemo(() => {
    if (!myItems.length) return null;
    return myItems.find((i) => i.item_id === activeProfileId) ?? myItems[0] ?? null;
  }, [myItems, activeProfileId]);

  const setActiveProfile = React.useCallback(
    (id: string) => {
      setActiveProfileId(id);
      if (network?.id) {
        setStoredActiveProfileId(network.id, id);
      }
    },
    [network],
  );

  return { activeProfileId, setActiveProfile, activeItem };
}
