import type { FetchMyActionsQuery } from '@/lib/action-api';

/**
 * Central query-key factory. One source of truth for React Query keys so keys
 * never drift across hooks/pages. Values for existing hooks are preserved
 * exactly (network-config / consent-config / actions) so adopting the factory
 * does not bust any live cache.
 *
 * `myItems` / `browseItems` / `markers` are declared ahead of use (spec §11
 * flag-back): the page migration (Plan 2b-ii) and the #203 scale work consume
 * them, and browse/markers filters must eventually carry the §8 axes (rounded
 * viewport bucket, offset, active profile, location source, instance URL).
 */
const actions = {
  all: ['actions'] as const,
  lists: () => [...actions.all, 'list'] as const,
  list: (filters: FetchMyActionsQuery) => [...actions.lists(), filters] as const,
  details: () => [...actions.all, 'detail'] as const,
  detail: (actionId: string) => [...actions.details(), actionId] as const,
  pendingCount: () => [...actions.all, 'pendingCount'] as const,
};

export const queryKeys = {
  networkConfig: (networkId: string) => ['network-config', networkId] as const,
  // The full list of network configs (GET /network/schemas, no `network` param).
  networkConfigs: () => ['network-configs'] as const,
  // Network config with all `$ref`s resolved against a given API base URL. The
  // base URL is part of the key so switching instance (§8, Plan 2b-v) yields a
  // distinct entry rather than serving a resolution built against the old host.
  resolvedNetwork: (networkId: string, apiBaseUrl: string) =>
    ['resolved-network', networkId, apiBaseUrl] as const,
  // A single item located by id (edit form), scoped to its network.
  editItem: (networkId: string, itemId: string) =>
    ['edit-item', networkId, itemId] as const,
  consentConfig: (themeId: string, brand: string | null) =>
    ['consent-config', themeId, brand] as const,
  // The user's profile-creation-consent status for a network (set of consented
  // item ids). Config-ish; invalidated on consent-accept.
  profileConsent: (networkId: string) => ['profile-consent', networkId] as const,
  actions,
  myItems: (networkId: string) => ['my-items', networkId] as const,
  browseItems: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['browse-items', networkId, domain, filters] as const,
  markers: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['markers', networkId, domain, filters] as const,
};
