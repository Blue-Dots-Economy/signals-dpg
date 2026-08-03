import { fetchNetworkConfig } from '@/lib/network-api';
import { fetchItems } from '@/lib/item-api';
import type { ProfileLite } from '@/lib/post-login-route';

/**
 * One-shot fetch of the current user's own profiles (across all of a network's
 * domains) reduced to just what the post-login redirect (#376) needs:
 * `item_id` + `item_domain` + `lifecycle_status`. Mirrors `useMyItems`' fetch
 * (per-domain `created_by_me`) but imperative, for use in the login flow before
 * a route is chosen. Per-domain failures degrade to an empty list for that
 * domain so a single bad domain never blocks the decision.
 */
export async function fetchMyProfilesLite(networkId: string): Promise<ProfileLite[]> {
  const config = await fetchNetworkConfig(networkId);
  const perDomain = await Promise.all(
    (config.domains ?? []).map((domain) => {
      const itemType = domain.item_schemas
        ? Object.keys(domain.item_schemas)[0] ?? 'profile'
        : 'profile';
      return fetchItems({
        item_network: networkId,
        item_domain: domain.id,
        item_type: itemType,
        created_by_me: true,
        // Include retired so a retired-only user counts as "already set up" and
        // isn't redirected to the create page (#376). The sidebar's own
        // useMyItems fetch still excludes retired.
        include_retired: true,
        limit: 100,
      })
        .then((res) =>
          res.items.map((i) => ({
            item_id: i.item_id,
            item_domain: i.item_domain,
            lifecycle_status: i.lifecycle_status ?? '',
          })),
        )
        .catch(() => [] as ProfileLite[]);
    }),
  );
  return perDomain.flat();
}
