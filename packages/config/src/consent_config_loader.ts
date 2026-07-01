import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  PartialConsentConfigSchema,
  parseConsentConfigDocument,
  type ConsentConfigDocument,
  type PartialConsentConfig,
} from '@dpg/schemas';

// A brand override is a partial document set (each top-level document optional);
// the UI merges it over the network default. PartialConsentConfigSchema is defined
// in @dpg/schemas (Zod 4 has no `.deepPartial()`).

export type LoadedConsentConfig = {
  network: string;
  brand: string | null;
  config: ConsentConfigDocument | PartialConsentConfig;
};

export type LoadConsentConfigOptions = {
  source: 'local' | 'remote';
  networkLocalFile: string;
  networks: string[];
};

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * Local mode: the network default consent.json sits beside network.json; brand
 * overrides live in immediate sub-folders named for the brand id.
 * Local mode is single-network (mirrors network_config_loader).
 *
 * Remote mode: remote consent delivery is a follow-up; returns [] for now.
 */
export async function loadConsentConfigs(
  opts: LoadConsentConfigOptions
): Promise<LoadedConsentConfig[]> {
  if (opts.source !== 'local') {
    // Remote consent delivery is a follow-up; returns [] for now.
    return [];
  }

  // Local mode represents exactly one network — use only the first entry.
  if (opts.networks.length === 0) return [];
  const network = opts.networks[0];

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedConsentConfig[] = [];

  const defaultRaw = await readJsonIfExists(join(baseDir, 'consent.json'));
  if (!defaultRaw) return [];

  results.push({
    network,
    brand: null,
    config: parseConsentConfigDocument(defaultRaw),
  });

  for (const brand of await listSubdirectories(baseDir)) {
    const brandRaw = await readJsonIfExists(join(baseDir, brand, 'consent.json'));
    if (!brandRaw) continue;
    results.push({
      network,
      brand,
      config: PartialConsentConfigSchema.parse(brandRaw),
    });
  }

  return results;
}
