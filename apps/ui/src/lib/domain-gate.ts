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
 * each for a created-by-me item.
 *
 * Fail-open by design: a failed probe is treated as "no item in that domain".
 * This UI gate is only a best-effort redirect to the right per-domain portal —
 * the server's DOMAIN_LOCKED guard is the authoritative control, so a transient
 * probe error can at worst let a user briefly land on the wrong portal's browse
 * view (they still cannot create a cross-domain profile), and it self-corrects
 * on the next successful login. Blocking on a transient error would instead
 * wrongly turn away legitimate new / same-domain users, so fail-open is the
 * deliberate choice here.
 */
export async function resolveHeldDomains(
  networkId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // Fail open on config-fetch failure too (not just per-probe): a transient
  // network-config error must not reject out of the post-OTP gate and surface
  // as a misleading "wrong code" error to an already-authenticated user.
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
