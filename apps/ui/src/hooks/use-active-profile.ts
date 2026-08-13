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
 * Shared "which of my own profiles am I acting/viewing as" state, lifted out
 * of home-page.tsx (home-page keeps its own copy — not refactored here) so
 * other pages (e.g. the shell around the public profile page) can reuse the
 * same restore-on-load + persist behavior without depending on browse-only
 * concerns like the profile-consent gate.
 *
 * Restore runs once per network: prefer the stored id (if it still names one
 * of `myItems`), else default to `myItems[0]`. Unlike home-page's version this
 * has no `isFetched` signal to key off of, so the restore is deferred until
 * `myItems` is non-empty — if a network genuinely has zero owned profiles the
 * id simply stays `null` (the correct end state either way), and the stored
 * localStorage value from a previous session is left untouched rather than
 * cleared out from under a fetch that just hasn't resolved yet.
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
