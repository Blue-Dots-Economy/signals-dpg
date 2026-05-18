export type ServedDomainBinding = {
  network: string;
  domain: string;
  key: string;
};

export type JsonSchemaDocument = Record<string, unknown>;

export type NetworkDomainConfig = {
  id: string;
  description?: string;
  minimum_cache_ttl_seconds?: number;
  item_schemas?: Record<string, JsonSchemaDocument>;
  default_item_schemas?: Record<string, JsonSchemaDocument>;
};

type NetworkInstanceConfig = {
  domain_id: string;
  instance_url: string;
  instance_name?: string;
  schema_url?: string | null;
  custom_item_schema_urls?: Record<string, string>;
};

export type NetworkActionInteraction = {
  from_network?: string;
  from_domain: string;
  from_items?: string[];
  to_network?: string;
  to_domain: string;
  to_items?: string[];
  requirement_schema: JsonSchemaDocument;
  event_schema?: JsonSchemaDocument;
};

type NetworkActionConfig = {
  description?: string;
  interactions?: NetworkActionInteraction[];
};

export type NetworkConfig = {
  id: string;
  display_name?: string;
  description?: string;
  schema_standard?: string;
  source_url?: string;
  domains?: NetworkDomainConfig[];
  instances?: NetworkInstanceConfig[];
  cross_network_origins?: NetworkCrossOriginConfig[];
  actions?: Record<string, NetworkActionConfig>;
};

export type NetworkCrossOriginConfig = {
  id: string;
  display_name?: string;
  schema_url: string;
};

export type NetworkConfigSource = 'local' | 'remote';

const BINDING_REGEX = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

export function parseServedDomains(input: string): ServedDomainBinding[] {
  const seen = new Set<string>();

  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!BINDING_REGEX.test(entry)) {
        throw new Error(
          `Invalid SERVED_DOMAINS entry "${entry}". Expected "network/domain".`
        );
      }

      const [network, domain] = entry.split('/');
      const key = `${network}/${domain}`;

      if (seen.has(key)) {
        return null;
      }

      seen.add(key);
      return { network, domain, key };
    })
    .filter((binding): binding is ServedDomainBinding => binding !== null);
}

export function getAllowedInstanceOriginsFromNetworkConfig(
  networkConfig: NetworkConfig,
  servedDomains: ServedDomainBinding[]
): string[] {
  if (!networkConfig.instances?.length) {
    return [];
  }

  const servedForNetwork = new Set(
    servedDomains
      .filter((binding) => binding.network === networkConfig.id)
      .map((binding) => binding.domain)
  );

  if (servedForNetwork.size === 0) {
    return [];
  }

  const allowedDomains = new Set<string>(servedForNetwork);

  for (const action of Object.values(networkConfig.actions ?? {})) {
    for (const interaction of action.interactions ?? []) {
      if (servedForNetwork.has(interaction.to_domain)) {
        allowedDomains.add(interaction.from_domain);
      }
    }
  }

  return networkConfig.instances
    .filter((instance) => allowedDomains.has(instance.domain_id))
    .map((instance) => toOrigin(instance.instance_url))
    .filter((origin, index, list) => list.indexOf(origin) === index);
}

function toOrigin(url: string): string {
  return new URL(url).origin;
}

export function parseNetworkConfigUrls(input: string): Record<string, string> {
  return Object.fromEntries(
    input
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [network, url] = entry.split('=').map((part) => part.trim());

        if (!network || !url) {
          throw new Error(
            `Invalid NETWORK_CONFIG_URLS entry "${entry}". Expected "network=url".`
          );
        }

        return [network, normalizeNetworkConfigUrl(url)];
      })
  );
}

export function parseSchemaRegistryUrls(
  input: string,
  networks: string[]
): Record<string, string> {
  const entries = input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return {};
  }

  const hasExplicitMappings = entries.some((entry) => entry.includes('='));

  if (!hasExplicitMappings) {
    if (entries.length !== 1) {
      throw new Error(
        'Invalid SCHEMA_REGISTRY_URL. Use a single base URL or comma-separated "network=url" mappings.'
      );
    }

    const baseUrl = normalizeRegistryBaseUrl(entries[0]);
    const uniqueNetworks = [...new Set(networks)];

    if (uniqueNetworks.length === 0) {
      throw new Error(
        'Cannot derive network schema URLs from SCHEMA_REGISTRY_URL without any served networks.'
      );
    }

    return Object.fromEntries(
      uniqueNetworks.map((network) => [
        network,
        new URL(`${network}/network.json`, baseUrl).toString(),
      ])
    );
  }

  return Object.fromEntries(
    entries.map((entry) => {
      const [network, url] = entry.split('=').map((part) => part.trim());

      if (!network || !url) {
        throw new Error(
          `Invalid SCHEMA_REGISTRY_URL entry "${entry}". Expected "network=url".`
        );
      }

      return [network, normalizeNetworkConfigUrl(url)];
    })
  );
}

function normalizeNetworkConfigUrl(input: string): string {
  if (input.endsWith('.json')) {
    return new URL(input).toString();
  }

  const baseUrl = normalizeRegistryBaseUrl(input);
  return new URL('network.json', baseUrl).toString();
}

function normalizeRegistryBaseUrl(input: string): string {
  const url = new URL(input);
  const withTrailingSlash = url.toString().endsWith('/')
    ? url.toString()
    : `${url.toString()}/`;

  return withTrailingSlash;
}
