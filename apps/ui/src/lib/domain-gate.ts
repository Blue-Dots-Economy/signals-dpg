import { fetchNetworkConfig } from '@/lib/network-api';
import { fetchItems } from '@/lib/item-api';

export type DomainGate = { allow: true } | { allow: false; heldDomain: string };

/**
 * Decides whether a user may use a UI bound to `boundDomain`, given the domains
 * they already hold profiles in (within the bound network). Blocks when they
 * hold a profile in any OTHER domain; allows when they hold none (new user) or
 * only the bound domain. Pure.
 */
export function evaluateDomainGate(heldDomains: string[], boundDomain: string): DomainGate {
  const other = heldDomains.find((d) => d !== boundDomain);
  return other ? { allow: false, heldDomain: other } : { allow: true };
}

/**
 * The distinct domains in which the signed-in user holds a profile within
 * `networkId`. Fetches the network config to enumerate domains, then probes
 * each for a created-by-me item. I/O wrapper around evaluateDomainGate; best
 * effort (a failed probe counts as "no item" for that domain).
 */
export async function resolveHeldDomains(
  networkId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const network = await fetchNetworkConfig(networkId);
  const perDomain = await Promise.all(
    network.domains.map((domain) => {
      const itemType = Object.keys(domain.item_schemas ?? {})[0] ?? 'profile';
      return fetchItems(
        {
          item_network: networkId,
          item_domain: domain.id,
          item_type: itemType,
          created_by_me: true,
          limit: 1,
        },
        signal,
      )
        .then((res) => (res.items.length > 0 ? domain.id : null))
        .catch(() => null);
    }),
  );
  return perDomain.filter((d): d is string => d !== null);
}
