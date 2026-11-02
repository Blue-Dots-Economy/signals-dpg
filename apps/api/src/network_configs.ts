import {
  type NetworkConfigDocument,
  parseNetworkConfigDocument,
  assertSinglePrimaryLocation,
} from '@dpg/schemas';
import { loadNetworkConfigs } from '@dpg/config';
import { apiConfig } from '@/config';

let networkConfigsPromise: Promise<NetworkConfigDocument[]> | null = null;

async function loadAndParseNetworkConfigs(): Promise<NetworkConfigDocument[]> {
  const configs = await loadNetworkConfigs({
    source: apiConfig.network_config_source,
    localFile: apiConfig.network_config_local_file,
    remoteUrls: apiConfig.network_config_urls,
    schemaRegistryUrls: apiConfig.schema_registry_url,
    servedDomains: apiConfig.served_domains,
  });

  return configs.map((config) => {
    const parsed = parseNetworkConfigDocument(config);
    for (const domain of parsed.domains) {
      // Only served domains are checked, so an unserved domain in the same
      // config (never geocoded here) cannot fail boot.
      const isServed = apiConfig.served_domains.some(
        (binding) => binding.network === parsed.id && binding.domain === domain.id,
      );
      if (!isServed) continue;
      for (const [itemType, itemSchema] of Object.entries(domain.item_schemas)) {
        assertSinglePrimaryLocation(
          itemSchema as Record<string, unknown>,
          `${parsed.id}/${domain.id}/${itemType}`,
        );
      }
    }
    return parsed;
  });
}

export async function getNetworkConfigs(): Promise<NetworkConfigDocument[]> {
  if (!networkConfigsPromise) {
    // Don't memoize a rejected promise: one transient fetch failure would
    // otherwise poison the cache for the process lifetime.
    const pending = loadAndParseNetworkConfigs();
    pending.catch(() => {
      if (networkConfigsPromise === pending) networkConfigsPromise = null;
    });
    networkConfigsPromise = pending;
  }

  return networkConfigsPromise;
}

export async function refreshNetworkConfigs(): Promise<NetworkConfigDocument[]> {
  // Same as getNetworkConfigs: a failed refetch must not latch a rejected
  // promise.
  const pending = loadAndParseNetworkConfigs();
  pending.catch(() => {
    if (networkConfigsPromise === pending) networkConfigsPromise = null;
  });
  networkConfigsPromise = pending;
  return networkConfigsPromise;
}

export async function getNetworkConfigById(
  networkId: string
): Promise<NetworkConfigDocument> {
  const configs = await getNetworkConfigs();
  const config = configs.find((entry) => entry.id === networkId);

  if (!config) {
    throw new Error(`Network "${networkId}" is not configured.`);
  }

  return config;
}
