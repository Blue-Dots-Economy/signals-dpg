import { domainsInteract, type NetworkInteractionActions } from '@/lib/browse-discover';

// The list is scoped to one domain: `/discover` takes exactly one
// `item_domain`, and cosine scores from different domains' embeddings do not
// share a scale, so there is no correct merged "All" order.

/**
 * The domain the list shows when the URL does not name one. A signed-in viewer
 * gets the first visible domain their own domain interacts with (a seeker lands
 * on providers). `fromParam` is used only if it is visible, so a stale bookmark
 * cannot fetch a hidden domain. Returns `null` only when no domain is visible
 * yet (a transient pre-network state).
 */
export function resolveDefaultDomain(input: {
  fromParam: string | null;
  visibleDomains: { id: string }[];
  viewerDomain: string | null;
  actions: NetworkInteractionActions;
}): string | null {
  const visibleIds = input.visibleDomains.map((d) => d.id);

  if (input.fromParam && visibleIds.includes(input.fromParam)) {
    return input.fromParam;
  }

  const viewerDomain = input.viewerDomain;
  if (viewerDomain) {
    const interacting = visibleIds.find((id) => domainsInteract(input.actions, viewerDomain, id));
    if (interacting) return interacting;
  }

  return visibleIds[0] ?? null;
}

/**
 * Map → list transition: the map allows several domains (one `/markers`
 * request each) but the list allows one, so keep the first still-visible
 * selection. No notice; the domain control shows the result.
 */
export function collapseToSingleDomain(
  selected: string[],
  visibleDomains: { id: string }[],
): string | null {
  const visibleIds = visibleDomains.map((d) => d.id);
  return selected.find((id) => visibleIds.includes(id)) ?? visibleIds[0] ?? null;
}
