import { fetchNetworkConfig } from '@/lib/network-api';
import { fetchItems } from '@/lib/item-api';
import type { ProfileLite } from '@/lib/post-login-route';

/**
 * One-shot fetch of the current user's own profiles across a network's domains,
 * reduced to what the post-login redirect needs. Imperative counterpart of
 * `useMyItems` for the login flow. A failing domain contributes an empty list
 * so it never blocks the decision.
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
        // Include retired so a retired-only user counts as set up and is not
        // redirected to create. The sidebar's useMyItems still excludes retired.
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
