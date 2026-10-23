import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  PartialConsentConfigSchema,
  parseConsentConfigDocument,
  type ConsentConfigDocument,
  type PartialConsentConfig,
} from '@dpg/schemas';

// A brand override is a partial document set (each top-level document
// optional); the UI merges it over the network default.

export type LoadedConsentConfig = {
  network: string;
  brand: string | null;
  config: ConsentConfigDocument | PartialConsentConfig;
};

export type LoadConsentConfigOptions = {
  source: 'local' | 'remote';
  networkLocalFile: string;
  networks: string[];
  /**
   * Replaces the `__SUPPORT_EMAIL__` placeholder in consent copy. Deployments
   * may also substitute it upstream at ConfigMap render.
   */
  supportEmail?: string;
};

const DEFAULT_SUPPORT_EMAIL = 'hello@bluedotseconomy.org';
const SUPPORT_EMAIL_PLACEHOLDER = '__SUPPORT_EMAIL__';

async function readConsentJson(
  path: string,
  supportEmail: string
): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text.split(SUPPORT_EMAIL_PLACEHOLDER).join(supportEmail));
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
 * Local mode is single-network. Remote mode returns [] (not implemented).
 */
export async function loadConsentConfigs(
  opts: LoadConsentConfigOptions
): Promise<LoadedConsentConfig[]> {
  if (opts.source !== 'local') {
    return [];
  }

  if (opts.networks.length === 0) return [];
  const network = opts.networks[0];
  const supportEmail = opts.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedConsentConfig[] = [];

  const defaultRaw = await readConsentJson(join(baseDir, 'consent.json'), supportEmail);
  if (!defaultRaw) return [];

  results.push({
    network,
    brand: null,
    config: parseConsentConfigDocument(defaultRaw),
  });

  for (const brand of await listSubdirectories(baseDir)) {
    const brandRaw = await readConsentJson(join(baseDir, brand, 'consent.json'), supportEmail);
    if (!brandRaw) continue;
    results.push({
      network,
      brand,
      config: PartialConsentConfigSchema.parse(brandRaw),
    });
  }

  return results;
}
