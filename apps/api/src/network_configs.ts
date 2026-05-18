import {
  type NetworkConfigDocument,
  parseNetworkConfigDocument,
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

  return configs.map((config) => parseNetworkConfigDocument(config));
}

export async function getNetworkConfigs(): Promise<NetworkConfigDocument[]> {
  if (!networkConfigsPromise) {
    networkConfigsPromise = loadAndParseNetworkConfigs();
  }

  return networkConfigsPromise;
}

export async function refreshNetworkConfigs(): Promise<NetworkConfigDocument[]> {
  networkConfigsPromise = loadAndParseNetworkConfigs();
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
