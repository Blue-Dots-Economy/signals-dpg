import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from './config_error.js';
import {
  type NetworkConfigSource,
  parseNetworkConfigUrls,
  parseSchemaRegistryUrls,
  type ServedDomainBinding,
} from './network_runtime.js';
import { type SsoNcsMapping, SsoNcsMappingSchema } from './sso_config.js';

/**
 * The NCS → Bluedots profile mapping file. It sits beside the instance's
 * network.json (same directory locally, same URL directory remotely), so each
 * instance's mapping lives next to the schema it maps into.
 */
export const NCS_MAPPING_FILE = 'ncs_bluedot_mapping.json';

export interface LoadSsoMappingOptions {
  source: NetworkConfigSource;
  /** NETWORK_CONFIG_LOCAL_FILE, resolved against process.cwd(). */
  localFile: string;
  remoteUrls?: string;
  schemaRegistryUrls?: string;
  servedDomains?: ServedDomainBinding[];
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

function parseJsonObject(raw: string, where: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${where} is not valid JSON.`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ConfigError(`${where} must be a JSON object.`);
  }
  return json as Record<string, unknown>;
}

/** URL of the served network's network.json in remote mode, or null. */
function remoteNetworkUrl(opts: LoadSsoMappingOptions): string | null {
  const networks = (opts.servedDomains ?? []).map((b) => b.network);
  const urls = opts.remoteUrls
    ? parseNetworkConfigUrls(opts.remoteUrls)
    : opts.schemaRegistryUrls
      ? parseSchemaRegistryUrls(opts.schemaRegistryUrls, networks)
      : null;
  if (!urls) return null;
  const network = networks[0];
  return (network && urls[network]) || Object.values(urls)[0] || null;
}

/**
 * The raw mapping file beside network.json, or null when the instance has none
 * (SSO then runs on SSO_NCS_MAPPING alone). A file that exists but is not a
 * JSON object is a boot failure, not a silent skip.
 */
export async function loadSsoNcsMappingFile(
  opts: LoadSsoMappingOptions
): Promise<Record<string, unknown> | null> {
  if (opts.source === 'local') {
    const path = join(dirname(resolve(process.cwd(), opts.localFile)), NCS_MAPPING_FILE);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return parseJsonObject(raw, path);
  }

  const networkUrl = remoteNetworkUrl(opts);
  if (!networkUrl) return null;
  const url = new URL(NCS_MAPPING_FILE, networkUrl).toString();
  const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new ConfigError(`${url} returned HTTP ${res.status}.`);
  return parseJsonObject(await res.text(), url);
}

/**
 * The effective NCS mapping: the file as the base, SSO_NCS_MAPPING on top (a
 * key set in the env wins). The env stays for per-environment values such as
 * `app_origin`, and so existing env-only deployments keep working.
 */
export function resolveSsoNcsMapping(
  file: Record<string, unknown> | null,
  envRaw: string
): SsoNcsMapping {
  const env = parseJsonObject(envRaw || '{}', 'SSO_NCS_MAPPING');
  const parsed = SsoNcsMappingSchema.safeParse({ ...(file ?? {}), ...env });
  if (!parsed.success) {
    throw new ConfigError(`NCS SSO mapping is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}
