/**
 * Dry-run the NCS → Bluedots profile mapping against a sample NCS response.
 *
 * Runs the same code a real partner login runs — ncs_bluedot_mapping.json
 * merged with SSO_NCS_MAPPING, the boot-time check against network.json, the
 * field mapping, per-field schema validation and (optionally) geocoding — and
 * prints the profile that would be created and whether it would go live.
 * Writes nothing: no user, no item, no Keycloak call, no NCS call.
 *
 * Usage (from the repo root):
 *   pnpm --filter api sso:mapping:check <ncs-response.json> [--no-geocode] [--env-path=<file>]
 *
 * `<ncs-response.json>` is a `validate-token` response as NCS returns it
 * (`{ status, data: {...} }`) or just its `data` object.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const argv = process.argv.slice(2);

function loadEnvFile(): void {
  const explicit = argv.find((a) => a.startsWith('--env-path='))?.split('=').slice(1).join('=');
  const candidates = explicit
    ? [resolve(process.cwd(), explicit)]
    : [resolve(repoRoot, '.env'), resolve(repoRoot, 'local-setup/.env')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    dotenv.config({ path, override: false, quiet: true });
    console.log(`env:      ${path}`);
    return;
  }
  if (explicit) {
    console.error(`env: --env-path not found: ${candidates[0]}`);
    process.exit(2);
  }
}

loadEnvFile();

const samplePath = argv.find((a) => !a.startsWith('--'));
if (!samplePath) {
  console.error('usage: sso:mapping:check <ncs-response.json> [--no-geocode] [--env-path=<file>]');
  process.exit(2);
}

// Imported after the env is loaded: config.ts validates it at import time.
const { getDomainItemSchema } = await import('@dpg/schemas');
const { loadSsoNcsMappingFile, NCS_MAPPING_FILE, resolveSsoNcsMapping } = await import('@dpg/config');
const { apiConfig, ssoConfig } = await import('../src/config.js');
const { getNetworkConfigById, getNetworkConfigs } = await import('../src/network_configs.js');
const { assertNcsMappingMatchesNetwork } = await import(
  '../src/services/auth/sso/ncs_mapping_boot.js'
);
const { keepValidFields, mapFields } = await import(
  '../src/services/auth/sso/sso_profile_bootstrap.js'
);
const { normalizeIndianMobile } = await import('../src/utils/phone.js');

const raw = JSON.parse(readFileSync(resolve(process.cwd(), samplePath), 'utf8')) as Record<
  string,
  unknown
>;
const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;

console.log(`schema:   ${apiConfig.network_config_local_file} (${apiConfig.network_config_source})`);
console.log(`served:   ${apiConfig.served_domains.map((b) => `${b.network}/${b.domain}`).join(', ')}`);

// 1. The effective mapping, checked against the network config exactly as at boot.
const networkConfigs = await getNetworkConfigs();
const file = await loadSsoNcsMappingFile({
  source: apiConfig.network_config_source,
  localFile: apiConfig.network_config_local_file,
  remoteUrls: apiConfig.network_config_urls,
  schemaRegistryUrls: apiConfig.schema_registry_url,
  servedDomains: apiConfig.served_domains,
});
console.log(`mapping:  ${file ? NCS_MAPPING_FILE : `(no ${NCS_MAPPING_FILE})`} + SSO_NCS_MAPPING`);
const mapping = resolveSsoNcsMapping(file, ssoConfig.ncs.mapping_raw);
try {
  assertNcsMappingMatchesNetwork(mapping, networkConfigs, apiConfig.served_domains);
  console.log('check:    ✅ mapping matches the network config');
} catch (err) {
  console.log(`check:    ❌ ${(err as Error).message}`);
  process.exit(1);
}

// 2. The identity a login would build from this response.
const role = typeof data.role === 'string' ? data.role : null;
const domain = role ? mapping.role_to_domain[role] : undefined;
if (!domain) {
  console.log(`\nrole ${role ?? '(none)'} is not in role_to_domain → no profile would be created`);
  process.exit(0);
}
const network =
  mapping.network ?? apiConfig.served_domains.find((b) => b.domain === domain)?.network ?? '';
const identity = {
  phone: normalizeIndianMobile(data.mobileNumber) ?? '',
  attributes: data,
} as Parameters<typeof mapFields>[0];

// 3. Map, then validate field by field.
const itemSchema = getDomainItemSchema(
  await getNetworkConfigById(network),
  domain,
  mapping.item_type
) as Record<string, unknown>;
const dropped: string[] = [];
const log = {
  warn: (obj: { dropped?: string[] }) => dropped.push(...(obj.dropped ?? [])),
} as unknown as Parameters<typeof keepValidFields>[2];
const mapped = mapFields(identity, mapping);
const payload = keepValidFields(mapped, itemSchema, log);

console.log(`\nprofile:  ${network}/${domain}/${mapping.item_type} (role ${role})`);
for (const [field, value] of Object.entries(payload)) {
  console.log(`  ✅ ${field.padEnd(20)} ${JSON.stringify(value)}`);
}
for (const [source, target] of Object.entries(mapping.fields)) {
  const value = data[source];
  if (mapping.value_maps[source] && value !== undefined && value !== null && mapped[target] === undefined) {
    console.log(
      `  ❌ ${target.padEnd(20)} ${JSON.stringify(value)}  (no value_maps.${source} entry for this code, left out)`
    );
  }
}
for (const field of dropped) {
  console.log(`  ❌ ${field.padEnd(20)} ${JSON.stringify(mapped[field])}  (rejected by the schema, left out)`);
}
const unused = Object.keys(data).filter(
  (k) =>
    !Object.hasOwn(mapping.fields, k) &&
    !Object.values(mapping.joined_fields).some((s) => s.includes(k)) &&
    !Object.values(mapping.age_from_dob).includes(k)
);
console.log(`  ·  not mapped: ${unused.join(', ') || '(none)'}`);

// 4. Would it go live?
const required = (itemSchema.required ?? []) as string[];
const missing = required.filter((k) => payload[k] === undefined || payload[k] === '');
const domainConfig = networkConfigs
  .find((c) => c.id === network)
  ?.domains.find((d) => d.id === domain) as { go_live_required?: string[] } | undefined;
const gates = domainConfig?.go_live_required ?? ['schema_required'];
console.log(`\ngo-live:  gates [${gates.join(', ')}], required [${required.join(', ')}]`);
if (missing.length > 0) {
  console.log(`  → draft: required field(s) missing: ${missing.join(', ')}`);
} else if (gates.some((g) => g !== 'schema_required')) {
  console.log(`  → draft until: ${gates.filter((g) => g !== 'schema_required').join(', ')}`);
} else {
  console.log('  → live at login');
}

// 5. Coordinates, unless skipped.
if (argv.includes('--no-geocode')) {
  console.log('\ngeocode:  skipped (--no-geocode)');
} else {
  const { geocodeLocationsFromState } = await import(
    '../src/services/geocoding/resolve_locations_for_create.js'
  );
  const points = await geocodeLocationsFromState(itemSchema, payload);
  console.log(
    `\ngeocode:  ${points.length > 0 ? points.map((p) => `${p.lat}, ${p.lng}`).join(' | ') : 'no coordinates (no location value, or the geocoder found nothing / is not configured)'}`
  );
  console.log('          (a private location is shifted 100–250 m before it is stored)');
}
process.exit(0);
