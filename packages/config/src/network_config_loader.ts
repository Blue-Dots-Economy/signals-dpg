import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  fetchSchema,
  NetworkConfigSchema,
  parseNetworkConfigDocument,
} from '@dpg/schemas';
import {
  type NetworkConfig,
  type NetworkConfigSource,
  parseNetworkConfigUrls,
  parseSchemaRegistryUrls,
  type ServedDomainBinding,
} from './network_runtime';

type LoadNetworkConfigOptions = {
  source: NetworkConfigSource;
  localFile: string;
  remoteUrls?: string;
  schemaRegistryUrls?: string;
  servedDomains?: ServedDomainBinding[];
};

export async function loadNetworkConfigs(
  options: LoadNetworkConfigOptions
): Promise<NetworkConfig[]> {
  let baseConfigs: NetworkConfig[];

  if (options.source === 'local') {
    const localFile = resolve(process.cwd(), options.localFile);
    const contents = await readFile(localFile, 'utf8');
    baseConfigs = [parseNetworkConfigDocument(JSON.parse(contents))];
  } else {
    const servedNetworks = (options.servedDomains ?? []).map(
      (binding) => binding.network
    );

    const resolvedRemoteUrls = options.remoteUrls
      ? parseNetworkConfigUrls(options.remoteUrls)
      : options.schemaRegistryUrls
        ? parseSchemaRegistryUrls(options.schemaRegistryUrls, servedNetworks)
        : null;

    if (!resolvedRemoteUrls) {
      throw new Error(
        'NETWORK_CONFIG_URLS or SCHEMA_REGISTRY_URL is required when NETWORK_CONFIG_SOURCE=remote'
      );
    }

    baseConfigs = await Promise.all(
      Object.values(resolvedRemoteUrls).map(loadNetworkConfigFromUrl)
    );
  }

  return loadOneHopCrossNetworkConfigs(baseConfigs);
}

async function loadNetworkConfigFromUrl(url: string): Promise<NetworkConfig> {
  const config = await new fetchSchema(url).getSchema();
  return {
    ...NetworkConfigSchema.parse(config),
    source_url: url,
  };
}

async function loadOneHopCrossNetworkConfigs(
  baseConfigs: NetworkConfig[]
): Promise<NetworkConfig[]> {
  const configsById = new Map(
    baseConfigs.map((config) => [config.id, config])
  );
  const origins = baseConfigs.flatMap(
    (config) => config.cross_network_origins ?? []
  );

  for (const origin of origins) {
    if (configsById.has(origin.id)) {
      continue;
    }

    const config = await loadNetworkConfigFromUrl(origin.schema_url);

    if (config.id !== origin.id) {
      throw new Error(
        `Cross-network origin "${origin.id}" loaded schema for network "${config.id}".`
      );
    }

    configsById.set(config.id, config);
  }

  return [...configsById.values()];
}
