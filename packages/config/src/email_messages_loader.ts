import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

async function readMessagesText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
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

  const defaultText = await readMessagesText(join(baseDir, 'messages.properties'));
  if (defaultText !== null) {
    results.push({ network, brand: null, text: defaultText });
  }

  // Unlike consent (where a brand partial requires the network base to
  // partial-over), the bundled email defaults are always the base layer —
  // apps/api's messages.ts merges a brand-only file straight over the
  // instance base when no network file exists. So brand subdirectories must
  // still be scanned even when the network-level file is absent.
  for (const brand of await listSubdirectories(baseDir)) {
    const brandText = await readMessagesText(join(baseDir, brand, 'messages.properties'));
    if (brandText === null) continue;
    results.push({ network, brand, text: brandText });
  }

  return results;
}
