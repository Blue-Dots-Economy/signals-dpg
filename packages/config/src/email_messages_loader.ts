import { dirname, join, resolve } from 'node:path';

import {
  listBrandDirectories,
  readOptionalPropertiesFile,
} from './properties_file_io.js';

export type LoadedEmailMessagesFile = {
  network: string;
  brand: string | null;
  text: string;
};

export type LoadEmailMessagesFilesOptions = {
  source: 'local' | 'remote';
  /** Path to network.json — messages.properties sits beside it (consent pattern). */
  networkLocalFile: string;
  networks: string[];
};

/**
 * Local mode: the network default messages.properties sits beside network.json;
 * brand overrides live in immediate sub-folders named for the brand id.
 * Local mode is single-network (mirrors consent_config_loader).
 *
 * Remote mode: remote messages delivery is a follow-up; returns [] for now.
 *
 * Returns raw file text only — no parsing or placeholder substitution here;
 * that lives in apps/api (registry/merge semantics).
 */
export async function loadEmailMessagesFiles(
  opts: LoadEmailMessagesFilesOptions
): Promise<LoadedEmailMessagesFile[]> {
  if (opts.source !== 'local') {
    // Remote messages delivery is a follow-up; returns [] for now.
    return [];
  }

  // Local mode represents exactly one network — use only the first entry.
  if (opts.networks.length === 0) return [];
  const network = opts.networks[0];

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedEmailMessagesFile[] = [];

  const defaultText = await readOptionalPropertiesFile(join(baseDir, 'messages.properties'));
  if (defaultText !== null) {
    results.push({ network, brand: null, text: defaultText });
  }

  // Unlike consent (where a brand partial requires the network base to
  // partial-over), the bundled email defaults are always the base layer —
  // apps/api's messages.ts merges a brand-only file straight over the
  // instance base when no network file exists. So brand subdirectories must
  // still be scanned even when the network-level file is absent.
  for (const brand of await listBrandDirectories(baseDir)) {
    const brandText = await readOptionalPropertiesFile(join(baseDir, brand, 'messages.properties'));
    if (brandText === null) continue;
    results.push({ network, brand, text: brandText });
  }

  return results;
}
