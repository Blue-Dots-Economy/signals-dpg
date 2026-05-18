import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type {
  DotNetworkSchema,
  DotActionSchema,
  DotNetworkInteraction,
  ViewMode,
} from '@/engine/types';
import { filterSchemaByPrivacy } from '@/engine/schema/schema-privacy';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import { PageShell } from '@/components/layout/page-shell';
import { CardGrid } from '@/components/cards/card-grid';
import { DomainCard } from '@/components/cards/domain-card';
import { ActionHandler } from '@/components/actions/action-handler';
import { MapView } from '@/components/map/map-container';
import { MatchScoreCard } from '@/components/match-score';
import '@/components/map/providers';
import { fetchItems, performAction, type Item } from '@/lib/item-api';
import { fetchNetworkConfigs, fetchNetworkConfig, fetchNetworkItems } from '@/lib/network-api';
import { useAuth } from '@/contexts/auth-context';
import { apiConfig } from '@/lib/api-config';

function itemToCardItem(item: Item): { id: string; data: Record<string, unknown> } {
  return {
    id: item.item_id,
    data: {
      ...item.item_state,
      item_latitude: item.item_latitude,
      item_longitude: item.item_longitude,
    },
  };
}

function getItemTypeForDomain(network: DotNetworkSchema, domainId: string): string {
  const domain = network.domains.find((d) => d.id === domainId);
  const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
  return itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
}

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map(n => n.trim()).filter(Boolean);
}

function getActiveProfileStorageKey(networkId: string): string {
  return `activeProfileId:${networkId}`;
}

function getStoredActiveProfileId(networkId: string): string | null {
  return localStorage.getItem(getActiveProfileStorageKey(networkId));
}

function setStoredActiveProfileId(networkId: string, profileId: string): void {
  localStorage.setItem(getActiveProfileStorageKey(networkId), profileId);
}

function clearStoredActiveProfileId(networkId: string): void {
  localStorage.removeItem(getActiveProfileStorageKey(networkId));
}

function getAllInteractions(network: DotNetworkSchema): Array<{ actionType: string; interaction: DotNetworkInteraction }> {
  const interactions: Array<{ actionType: string; interaction: DotNetworkInteraction }> = [];
  for (const [actionType, action] of Object.entries(network.actions)) {
    for (const interaction of action.interactions) {
      interactions.push({ actionType, interaction });
    }
  }
  return interactions;
}

/**
 * Resolve the instance URL for a target item
 * Priority:
 * 1. Item's own item_instance_url (if available and not localhost)
 * 2. Network config instances lookup by domain
 * 3. Current API base URL as fallback
 */
function resolveTargetInstanceUrl(
  targetItem: Item,
  network: DotNetworkSchema | null,
  currentApiUrl: string,
  itemType: 'source' | 'target' = 'target'
): string {
  console.log(`🔍 Resolving ${itemType} instance URL:`, {
    itemId: targetItem.item_id,
    itemDomain: targetItem.item_domain,
    itemInstanceUrl: targetItem.item_instance_url,
    currentApiUrl,
    networkInstances: network?.instances?.map(i => ({ domain: i.domain_id, url: i.instance_url })),
  });

  // Priority 1: Use item's instance URL if it exists and is valid (not localhost in production)
  if (targetItem.item_instance_url) {
    // Check if it's a valid URL (not just http://localhost in production)
    const isLocalhost = targetItem.item_instance_url.includes('localhost') || 
                        targetItem.item_instance_url.includes('127.0.0.1');
    const isProduction = !currentApiUrl.includes('localhost') && 
                         !currentApiUrl.includes('127.0.0.1');
    
    if (!isLocalhost || !isProduction) {
      console.log(`✅ Using item's instance_url: ${targetItem.item_instance_url}`);
      return targetItem.item_instance_url;
    }
    console.log(`⚠️ Item has localhost URL in production, skipping: ${targetItem.item_instance_url}`);
    // If localhost in production, continue to fallback
  }

  // Priority 2: Lookup in network.instances by domain
  if (network?.instances) {
    const instanceConfig = network.instances.find(
      (i) => i.domain_id === targetItem.item_domain
    );
    if (instanceConfig?.instance_url) {
      console.log(`✅ Using network.instances lookup: ${instanceConfig.instance_url}`);
      return instanceConfig.instance_url;
    }
  }

  // Priority 3: Fallback to current API URL
  console.log(`⚠️ Fallback to current API URL: ${currentApiUrl}`);
  return currentApiUrl;
}

export function HomePage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>(
    (searchParams.get('view') as ViewMode) ?? 'list'
  );
  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(
    searchParams.get('domain')
  );
  const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);
  const [allNetworks, setAllNetworks] = React.useState<DotNetworkSchema[]>([]);
  const configuredNetworkIds = parseNetworkIds(import.meta.env.VITE_NETWORK_ID);
  
  // Get network from URL query param, fallback to env config
  const networkFromUrl = searchParams.get('network');
  const initialNetworkId = networkFromUrl && configuredNetworkIds.includes(networkFromUrl)
    ? networkFromUrl
    : (configuredNetworkIds[0] || null);
  
  const [selectedNetworkId, setSelectedNetworkId] = React.useState<string | null>(initialNetworkId);
  const [domainItems, setDomainItems] = React.useState<Record<string, Item[]>>({});
  const [myItems, setMyItems] = React.useState<Item[]>([]);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!selectedNetworkId) {
      setActiveProfileId(null);
      return;
    }
    setActiveProfileId(getStoredActiveProfileId(selectedNetworkId));
  }, [selectedNetworkId]);

  // Fetch networks from API on mount
  React.useEffect(() => {
    const controller = new AbortController();

    fetchNetworkConfigs()
      .then((networks) => {
        if (controller.signal.aborted) return;
        
        // Filter by configured networks if VITE_NETWORK_ID is set, otherwise use all
        const targetNetworks = configuredNetworkIds.length > 0
          ? networks.filter(n => configuredNetworkIds.includes(n.id))
          : networks;
        setAllNetworks(targetNetworks);

        // Use first configured network, or first available
        const defaultNetwork = targetNetworks[0]?.id;
        if (defaultNetwork && !selectedNetworkId) {
          setSelectedNetworkId(defaultNetwork);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch networks:', err);
      });

    return () => { controller.abort(); };
  }, []);

  // Fetch and resolve the selected network
  React.useEffect(() => {
    if (!selectedNetworkId) return;

    const controller = new AbortController();

    setResolvedNetwork(null);
    setDomainItems({});
    setMyItems([]);

    fetchNetworkConfig(selectedNetworkId)
      .then((config) => {
        if (controller.signal.aborted) return;
        // Resolve any $ref in the network config
        return resolveNetworkRefs(config, { baseUrl: apiConfig.getUrl() });
      })
      .then((resolved) => {
        if (controller.signal.aborted || !resolved) return;
        setResolvedNetwork(resolved as DotNetworkSchema);
      })
      .catch((err) => {
        console.error('Failed to fetch network config:', err);
      });

    return () => { controller.abort(); };
  }, [selectedNetworkId]);

  const network = resolvedNetwork;

  // Fetch all user profiles across all domains to discover their domain
  React.useEffect(() => {
    if (!network || !user) return;

    const controller = new AbortController();

    const domainFetches = network.domains.map((domain) => {
      const itemType = getItemTypeForDomain(network, domain.id);
      return fetchItems({
        item_network: network.id,
        item_domain: domain.id,
        item_type: itemType,
        created_by_me: true,
        limit: 100,
      }, controller.signal)
        .then((res) => res.items)
        .catch(() => [] as Item[]);
    });

    Promise.all(domainFetches).then((results) => {
      if (controller.signal.aborted) return;
      const allProfiles = results.flat();
      setMyItems(allProfiles);

      // Auto-select: use stored ID if valid, otherwise first profile
      const storedId = getStoredActiveProfileId(network.id);
      if (storedId && allProfiles.some((p) => p.item_id === storedId)) {
        setActiveProfileId(storedId);
      } else if (allProfiles.length > 0) {
        setActiveProfileId(allProfiles[0].item_id);
        setStoredActiveProfileId(network.id, allProfiles[0].item_id);
      } else {
        // No profiles for this user — clear any stale ID from a previous session
        setActiveProfileId(null);
        clearStoredActiveProfileId(network.id);
      }
    });

    return () => { controller.abort(); };
  }, [network, user]);

  // Derive the active profile from myItems
  const myItem = React.useMemo(() => {
    if (!myItems.length) return null;
    return myItems.find((i) => i.item_id === activeProfileId) ?? myItems[0] ?? null;
  }, [myItems, activeProfileId]);

  // Current domain: from ?as= param (demo override), active profile, or network default
  const currentDomain = searchParams.get('as') ?? myItem?.item_domain ?? network?.domains[0]?.id ?? 'student_profile';

  // Domains visible to the current user
  const visibleDomains = React.useMemo(() => {
    if (!network) return [];
    // No profile yet — show all domains so user can browse and create
    if (!myItem) return network.domains;
    // Has profile — show domains the active profile can perform actions on
    const allInteractions = getAllInteractions(network);
    const targetNames = new Set(
      allInteractions
        .filter(({ interaction }) => interaction.from_domain === currentDomain)
        .map(({ interaction }) => interaction.to_domain)
    );
    return network.domains.filter((d) => targetNames.has(d.id));
  }, [network, currentDomain, myItem]);

  React.useEffect(() => {
    if (!network) return;
    if (selectedDomain === null) return;
    if (!visibleDomains.some((d) => d.id === selectedDomain)) {
      setSelectedDomain(null);
      setSearchParams((prev) => {
        prev.delete('domain');
        return prev;
      });
    }
  }, [network, selectedDomain, visibleDomains, setSearchParams]);

  const localProfileItemIds = React.useMemo(
    () => new Set(myItems.filter((item) => item.item_domain === currentDomain).map((item) => item.item_id)),
    [myItems, currentDomain]
  );

  // Fetch items for selected domain(s); when All tab (null) fetch all visible domains in parallel
  React.useEffect(() => {
    if (!network || visibleDomains.length === 0) {
      setDomainItems({});
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const domainsToFetch = selectedDomain === null
      ? visibleDomains
      : visibleDomains.filter((d) => d.id === selectedDomain);

    Promise.all(
      domainsToFetch.map((domain) => {
        const itemType = getItemTypeForDomain(network, domain.id);
        return fetchNetworkItems(
          { item_network: network.id, item_domain: domain.id, item_type: itemType, limit: 100 },
          controller.signal
        )
          .then((res) => ({
            domain: domain.id,
            items: res.items.filter((item) => !localProfileItemIds.has(item.item_id)),
          }))
          .catch(() => ({ domain: domain.id, items: [] as Item[] }));
      })
    )
      .then((results) => {
        if (controller.signal.aborted) return;
        const map: Record<string, Item[]> = {};
        for (const r of results) map[r.domain] = r.items;
        setDomainItems(map);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => { controller.abort(); };
  }, [selectedDomain, visibleDomains, network, localProfileItemIds]);

  // Active schema: from the selected browsing domain, or first visible domain
  const activeSchema = React.useMemo(() => {
    if (!network) return undefined;
    const domainId = selectedDomain ?? visibleDomains[0]?.id;
    const domain = network.domains.find((d) => d.id === domainId) ?? network.domains[0];
    if (!domain) return undefined;
    return domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
  }, [network, selectedDomain, visibleDomains]);

  // Build domain → schema map for sidebar profile title resolution
  const userSchemas = React.useMemo(() => {
    if (!network) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const domain of network.domains) {
      const schema = domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
      if (schema) map[domain.id] = schema;
    }
    return map;
  }, [network]);

  // Get all available actions for a given target domain
  const getActionsForDomain = React.useCallback(
    (targetDomainId: string): DotActionSchema[] => {
      if (!network || !myItem) return [];

      const actions: DotActionSchema[] = [];

      // Iterate through all action types defined in the network schema
      for (const [actionType, actionConfig] of Object.entries(network.actions)) {
        if (!actionConfig?.interactions) continue;

        // Find matching interactions for currentDomain -> targetDomain
        const matchingInteractions = actionConfig.interactions.filter(
          (i) => i.from_domain === currentDomain && i.to_domain === targetDomainId
        );

        for (const interaction of matchingInteractions) {
          actions.push({
            action_type: actionType,
            from_domain: interaction.from_domain,
            to_domain: interaction.to_domain,
            requirement_schema: interaction.requirement_schema,
            event_schema: interaction.event_schema,
          });
        }
      }

      return actions;
    },
    [network, currentDomain, myItem]
  );

  // Legacy: single active action for the selected domain (for CardGrid)
  const activeAction = React.useMemo<DotActionSchema | null>(() => {
    const toDomain = selectedDomain ?? visibleDomains[0]?.id;
    if (!toDomain) return null;
    const actions = getActionsForDomain(toDomain);
    return actions[0] ?? null;
  }, [getActionsForDomain, selectedDomain, visibleDomains]);

  // Build per-domain card items filtered by search
  const filteredDomainItems = React.useMemo(() => {
    const result: Record<string, { id: string; data: Record<string, unknown> }[]> = {};
    for (const [domain, itemList] of Object.entries(domainItems)) {
      const cards = itemList.map(itemToCardItem);
      result[domain] = search
        ? cards.filter((item) =>
            Object.values(item.data).some((val) =>
              String(val).toLowerCase().includes(search.toLowerCase())
            )
          )
        : cards;
    }
    return result;
  }, [domainItems, search]);

  const handleDomainSelect = (domainId: string | null) => {
    setSelectedDomain(domainId);
    setSearchParams((prev) => {
      if (domainId) {
        prev.set('domain', domainId);
      } else {
        prev.delete('domain');
      }
      return prev;
    });
  };

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setSearchParams((prev) => {
      prev.set('view', mode);
      return prev;
    });
  };

  const handleActiveProfileChange = (profileId: string) => {
    setActiveProfileId(profileId);
    if (network?.id) {
      setStoredActiveProfileId(network.id, profileId);
    }
  };

  const handleNetworkSelect = (networkId: string) => {
    setSelectedNetworkId(networkId);
    setSelectedDomain(null);
    setSearchParams((prev) => {
      prev.set('network', networkId);
      prev.delete('domain'); // Remove domain since it's network-specific
      return prev;
    });
  };

  const showNetworkSelector = allNetworks.length > 1;

  const currentDomainLabel = visibleDomains.find(
    (d) => d.id === selectedDomain
  )?.description;

  // Get dynamic actions for the selected domain
  const actions = selectedDomain
    ? getActionsForDomain(selectedDomain)
    : activeAction
      ? [activeAction]
      : [];

  if (!network) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading network schemas...</p>
      </div>
    );
  }

  return (
    <PageShell
      networks={showNetworkSelector ? allNetworks : []}
      selectedNetwork={selectedNetworkId}
      onNetworkSelect={handleNetworkSelect}
      domains={visibleDomains}
      selectedDomain={selectedDomain}
      onDomainSelect={handleDomainSelect}
      currentDomainLabel={currentDomainLabel}
      myItems={myItems}
      activeProfileId={activeProfileId}
      onActiveProfileChange={handleActiveProfileChange}
      userSchemas={userSchemas}
      search={search}
      onSearchChange={setSearch}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
    >
      {viewMode === 'list' ? (
        <ActionHandler
          onActionSubmit={async (actionType, _actionSchema, formData, targetItemId) => {
            if (!myItem) {
              toast.error('Create your profile first to connect');
              throw new Error('No source item');
            }
            if (!user) {
              toast.error('You must be signed in to connect');
              throw new Error('No user');
            }
            const allItems = Object.values(domainItems).flat();
            const targetItem = allItems.find((i) => i.item_id === targetItemId);
            if (!targetItem) {
              toast.error('Could not find the target item');
              throw new Error('Target item not found');
            }

            // Resolve source item instance URL (where my profile is stored)
            // IMPORTANT: If the source item has localhost as instance_url, 
            // it means it was created on the current API instance
            const sourceItemInstanceUrl = myItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()  // Use current API where the item was actually created
              : resolveTargetInstanceUrl(myItem, network, apiConfig.getUrl(), 'source');
            
            // Resolve target item instance URL dynamically
            // IMPORTANT: If target item has localhost, use current API as fallback
            const targetItemInstanceUrl = targetItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()  // Use current API where the item was actually fetched from
              : resolveTargetInstanceUrl(targetItem, network, apiConfig.getUrl(), 'target');

            await performAction(
              {
                action_type: actionType,
                source_item: {
                  item_network: myItem.item_network,
                  item_domain: myItem.item_domain,
                  item_type: myItem.item_type,
                  item_id: myItem.item_id,
                },
                target_item: {
                  item_network: targetItem.item_network,
                  item_domain: targetItem.item_domain,
                  item_type: targetItem.item_type,
                  item_id: targetItem.item_id,
                  item_instance_url: targetItemInstanceUrl,
                },
                requirements_snapshot: formData,
              },
              sourceItemInstanceUrl // Call the SOURCE instance (where myItem exists)
            );
            toast.success(`${actionType.charAt(0).toUpperCase() + actionType.slice(1)} request sent!`);
          }}
        >
          {(triggerAction) =>
            selectedDomain === null ? (
              // All tab: flat grid across all domains, each card uses its own schema
              (() => {
                const allFlatItems = visibleDomains.flatMap((domain) => {
                  const domainSchema = domain.item_schemas
                    ? (Object.values(domain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                    : undefined;
                  // Get all dynamic actions for this domain
                  const domainActions = getActionsForDomain(domain.id);
                  return (filteredDomainItems[domain.id] ?? []).map((item) => ({
                    item,
                    schema: domainSchema,
                    domainActions,
                    domainDescription: domain.description,
                  }));
                });

                if (loading) {
                  return (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <DomainCard key={i} schema={{}} data={{}} loading />
                      ))}
                    </div>
                  );
                }

                if (allFlatItems.length === 0) {
                  return (
                    <div className="flex items-center justify-center py-12">
                      <p className="text-muted-foreground">
                        {search ? `No results for "${search}"` : 'No items found'}
                      </p>
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {allFlatItems.map(({ item, schema, domainActions, domainDescription }) => {
                      // Find the full Item object from domainItems
                      const fullItem = Object.values(domainItems)
                        .flat()
                        .find((i) => i.item_id === item.id);
                      
                      return (
                        <MatchScoreCard
                          key={item.id}
                          schema={schema!}
                          schemaDescription={domainDescription}
                          data={item.data}
                          actions={domainActions}
                          onAction={(type, actionSchema) =>
                            triggerAction(type, actionSchema, item.id)
                          }
                          localItem={myItem}
                          networkItem={fullItem || {
                            item_id: item.id,
                            item_network: network?.id || '',
                            item_domain: selectedDomain || '',
                            item_type: 'profile',
                            item_instance_url: null,
                            item_schema_url: null,
                            item_state: item.data,
                            item_latitude: null,
                            item_longitude: null,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })()
            ) : (
              // Single domain tab: existing behaviour
              <CardGrid
                schema={activeSchema!}
                schemaName={selectedDomain}
                schemaDescription={currentDomainLabel}
                items={filteredDomainItems[selectedDomain] ?? []}
                fullItems={domainItems[selectedDomain] ?? []}
                actions={actions}
                onAction={(itemId, _type, actionSchema) => {
                  triggerAction(_type, actionSchema, itemId);
                }}
                loading={loading}
                emptyMessage={
                  search
                    ? `No results for "${search}"`
                    : `No ${currentDomainLabel ?? 'items'} found`
                }
                localItem={myItem}
                networkId={network?.id}
                selectedDomain={selectedDomain}
              />
            )
          }
        </ActionHandler>
      ) : (
        <MapView
          schema={filterSchemaByPrivacy(activeSchema!, 'public-only')}
          items={Object.values(filteredDomainItems).flat()}
        />
      )}
    </PageShell>
  );
}
