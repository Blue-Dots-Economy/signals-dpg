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
      // Only the domains this instance actually serves are validated — an
      // unserved sibling/peer domain in the same config (which this instance
      // never geocodes) must not be able to fail boot.
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
    // Do NOT memoize a rejected promise: a single transient failure (e.g. a
    // schema-registry fetch blip) would otherwise poison the cache for the
    // process lifetime, silently degrading every downstream caller. Clear the
    // slot on rejection so the next call retries.
    const pending = loadAndParseNetworkConfigs();
    pending.catch(() => {
      if (networkConfigsPromise === pending) networkConfigsPromise = null;
    });
    networkConfigsPromise = pending;
  }

  return networkConfigsPromise;
}

export async function refreshNetworkConfigs(): Promise<NetworkConfigDocument[]> {
  // Same non-poisoning contract as getNetworkConfigs: a failed refetch must not
  // latch a rejected promise (this is the realistic runtime path — a periodic
  // schema refetch blip would otherwise degrade every contact resolution to the
  // account fallback until the next successful refresh or a restart).
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
