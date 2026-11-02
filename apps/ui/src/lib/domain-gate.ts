import { fetchNetworkConfig } from '@/lib/network-api';
import { fetchItems } from '@/lib/item-api';

export type DomainGate = { allow: true } | { allow: false; heldDomain: string };

/**
 * Whether a user may use a UI serving `servedDomains`: blocked when they hold a
 * profile in any domain outside that set, allowed otherwise (including no profiles).
 */
export function evaluateDomainGate(
  heldDomains: string[],
  servedDomains: string[],
): DomainGate {
  const blocked = heldDomains.find((d) => !servedDomains.includes(d));
  return blocked ? { allow: false, heldDomain: blocked } : { allow: true };
}

/**
 * Domains in which the signed-in user holds a profile in `networkId`, found by
 * probing each domain for a created-by-me item.
 *
 * Fails open (a failed probe means "no item there"): this gate is only a
 * best-effort redirect to the right portal, and the server's DOMAIN_LOCKED
 * guard is the real control. Failing closed would turn away legitimate users
 * on a transient error.
 */
export async function resolveHeldDomains(
  networkId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // Fail open on a config-fetch error too, so it cannot reject out of the
  // post-login gate as a misleading error for an authenticated user.
  let network: Awaited<ReturnType<typeof fetchNetworkConfig>>;
  try {
    network = await fetchNetworkConfig(networkId);
  } catch {
    return [];
  }
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
