import {
  ConfigError,
  loadSsoNcsMappingFile,
  NCS_MAPPING_FILE,
  resolveSsoNcsMapping,
  type SsoNcsMapping,
} from '@dpg/config';
import type { NetworkConfigDocument } from '@dpg/schemas';
import { apiConfig, ssoConfig } from '@/config';
import { NCS_PROVIDER_ID } from '@/services/auth/sso/providers/ncs';
import { installSsoNcsMapping } from '@/services/auth/sso/registry';

type ServedBinding = { network: string; domain: string };
type PropertyMap = Record<string, { enum?: unknown[] }>;

/** Every profile field the mapping writes to. */
function mappingTargets(mapping: SsoNcsMapping): string[] {
  return [
    ...Object.values(mapping.fields),
    ...Object.keys(mapping.joined_fields),
    ...Object.keys(mapping.age_from_dob),
  ];
}

/** The item schema's properties for one mapped role, or a problem string. */
function roleProperties(
  role: string,
  domain: string,
  mapping: SsoNcsMapping,
  networkConfigs: readonly NetworkConfigDocument[],
  servedDomains: readonly ServedBinding[]
): { label: string; properties: PropertyMap } | string {
  const network = mapping.network ?? servedDomains.find((b) => b.domain === domain)?.network;
  if (!network || !servedDomains.some((b) => b.network === network && b.domain === domain)) {
    return `role ${role} → domain '${domain}' is not served by this instance`;
  }
  const itemSchema = networkConfigs
    .find((c) => c.id === network)
    ?.domains.find((d) => d.id === domain)?.item_schemas?.[mapping.item_type] as
    | { properties?: PropertyMap }
    | undefined;
  if (!itemSchema) {
    return `domain '${network}/${domain}' has no item type '${mapping.item_type}'`;
  }
  return { label: `${network}/${domain}/${mapping.item_type}`, properties: itemSchema.properties ?? {} };
}

/** value_maps results that are not one of the target field's enum values. */
function valueMapProblems(mapping: SsoNcsMapping, properties: PropertyMap): string[] {
  const problems: string[] = [];
  for (const [source, valueMap] of Object.entries(mapping.value_maps)) {
    const target = mapping.fields[source];
    const allowed = target ? properties[target]?.enum : undefined;
    if (!allowed) continue;
    for (const value of Object.values(valueMap).filter((v) => !allowed.includes(v))) {
      problems.push(`value_maps.${source} maps to '${value}', not an allowed value of '${target}'`);
    }
  }
  return problems;
}

/**
 * Check a mapping against the network config this instance serves, so a
 * mapping that names a domain, item type or field the schema does not have
 * stops the API at deploy time. At login it would make every draft-profile
 * create fail (seeker schemas are `additionalProperties: false`).
 * Pure, so it is directly unit-testable.
 */
export function assertNcsMappingMatchesNetwork(
  mapping: SsoNcsMapping,
  networkConfigs: readonly NetworkConfigDocument[],
  servedDomains: readonly ServedBinding[]
): void {
  const problems = Object.keys(mapping.value_maps)
    .filter((source) => !Object.hasOwn(mapping.fields, source))
    .map((source) => `value_maps.${source} has no matching entry in fields`);
  const targets = mappingTargets(mapping);

  for (const [role, domain] of Object.entries(mapping.role_to_domain)) {
    const resolved = roleProperties(role, domain, mapping, networkConfigs, servedDomains);
    if (typeof resolved === 'string') {
      problems.push(resolved);
      continue;
    }
    for (const target of targets.filter((t) => !Object.hasOwn(resolved.properties, t))) {
      problems.push(`field '${target}' is not in ${resolved.label} (role ${role})`);
    }
    problems.push(...valueMapProblems(mapping, resolved.properties));
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `NCS SSO mapping (${NCS_MAPPING_FILE} + SSO_NCS_MAPPING) does not match the network config:\n  - ` +
        problems.join('\n  - ')
    );
  }
}

/**
 * Boot step: load ncs_bluedot_mapping.json beside network.json, merge
 * SSO_NCS_MAPPING over it, check it against the served network config and
 * install it for the SSO provider. No-op when NCS SSO is off.
 */
export async function loadNcsMappingAtBoot(
  networkConfigs: readonly NetworkConfigDocument[]
): Promise<SsoNcsMapping | null> {
  if (!ssoConfig.enabled || !ssoConfig.providers.includes(NCS_PROVIDER_ID)) return null;

  const file = await loadSsoNcsMappingFile({
    source: apiConfig.network_config_source,
    localFile: apiConfig.network_config_local_file,
    remoteUrls: apiConfig.network_config_urls,
    schemaRegistryUrls: apiConfig.schema_registry_url,
    servedDomains: apiConfig.served_domains,
  });
  const mapping = resolveSsoNcsMapping(file, ssoConfig.ncs.mapping_raw);
  assertNcsMappingMatchesNetwork(mapping, networkConfigs, apiConfig.served_domains);
  installSsoNcsMapping(mapping);
  return mapping;
}
