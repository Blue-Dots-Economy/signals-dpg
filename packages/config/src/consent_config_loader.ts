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

type LoadConsentConfigOptions = {
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
  } catch {
    return [];
  }
}

/**
 * Local mode: the network default consent.json sits beside network.json; brand
 * overrides live in immediate sub-folders named for the brand id.
 *
 * Remote mode: v1 supports the network default only, derived by swapping the
 * network config URL's filename to consent.json. Brand-scoped remote delivery is
 * a documented follow-up (spec §1.1 / Phase 1 notes) and returns [] for brands.
 */
export async function loadConsentConfigs(
  opts: LoadConsentConfigOptions
): Promise<LoadedConsentConfig[]> {
  if (opts.source !== 'local') {
    // Remote handling is out of scope for this task's local-dev path; return [].
    // (Implemented alongside remote network-config delivery in a follow-up.)
    return [];
  }

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedConsentConfig[] = [];

  for (const network of opts.networks) {
    const defaultRaw = await readJsonIfExists(join(baseDir, 'consent.json'));
    if (!defaultRaw) continue; // no consent config for this network

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
  }

  return results;
}
