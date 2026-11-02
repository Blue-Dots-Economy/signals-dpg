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
 * brand overrides live in immediate sub-folders named for the brand id. Local
 * mode is single-network. Remote mode returns [] (not implemented).
 *
 * Returns raw file text only; parsing and merging live in apps/api.
 */
export async function loadEmailMessagesFiles(
  opts: LoadEmailMessagesFilesOptions
): Promise<LoadedEmailMessagesFile[]> {
  if (opts.source !== 'local') {
    return [];
  }

  if (opts.networks.length === 0) return [];
  const network = opts.networks[0];

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedEmailMessagesFile[] = [];

  const defaultText = await readOptionalPropertiesFile(join(baseDir, 'messages.properties'));
  if (defaultText !== null) {
    results.push({ network, brand: null, text: defaultText });
  }

  // Brands are scanned even without a network-level file: the bundled defaults
  // are always the base layer, so a brand-only file is valid.
  for (const brand of await listBrandDirectories(baseDir)) {
    const brandText = await readOptionalPropertiesFile(join(baseDir, brand, 'messages.properties'));
    if (brandText === null) continue;
    results.push({ network, brand, text: brandText });
  }

  return results;
}
