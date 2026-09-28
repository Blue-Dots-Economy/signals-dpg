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
  servedDomains: readonly { network: string; domain: string }[]
): void {
  const problems: string[] = [];
  const targets = [
    ...Object.values(mapping.fields),
    ...Object.keys(mapping.joined_fields),
    ...Object.keys(mapping.age_from_dob),
  ];
  for (const source of Object.keys(mapping.value_maps)) {
    if (!Object.hasOwn(mapping.fields, source)) {
      problems.push(`value_maps.${source} has no matching entry in fields`);
    }
  }

  for (const [role, domain] of Object.entries(mapping.role_to_domain)) {
    const network =
      mapping.network ?? servedDomains.find((b) => b.domain === domain)?.network;
    if (!network || !servedDomains.some((b) => b.network === network && b.domain === domain)) {
      problems.push(`role ${role} → domain '${domain}' is not served by this instance`);
      continue;
    }
    const domainConfig = networkConfigs
      .find((c) => c.id === network)
      ?.domains.find((d) => d.id === domain);
    const itemSchema = domainConfig?.item_schemas?.[mapping.item_type] as
      | { properties?: Record<string, unknown> }
      | undefined;
    if (!itemSchema) {
      problems.push(`domain '${network}/${domain}' has no item type '${mapping.item_type}'`);
      continue;
    }
    const properties = (itemSchema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
    for (const target of targets) {
      if (!Object.hasOwn(properties, target)) {
        problems.push(
          `field '${target}' is not in ${network}/${domain}/${mapping.item_type} (role ${role})`
        );
      }
    }
    for (const [source, valueMap] of Object.entries(mapping.value_maps)) {
      const allowed = properties[mapping.fields[source] ?? '']?.enum;
      if (!allowed) continue;
      for (const value of Object.values(valueMap)) {
        if (!allowed.includes(value)) {
          problems.push(
            `value_maps.${source} maps to '${value}', not an allowed value of '${mapping.fields[source]}'`
          );
        }
      }
    }
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
