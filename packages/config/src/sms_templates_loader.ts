import { dirname, join, resolve } from 'node:path';

import {
  listBrandDirectories,
  readOptionalPropertiesFile,
} from './properties_file_io.js';

/**
 * Discovery for the per-network/brand SMS template files. Same layout as
 * `email_messages_loader.ts`, because the deploy pipeline mounts both into the
 * schemas ConfigMap at `dirname(NETWORK_CONFIG_LOCAL_FILE)`.
 *
 * Kept separate from the email loader because an empty value means the
 * opposite: an empty email value is discarded, while an empty `template_id`
 * marks a template not yet DLT-approved, whose send must be skipped.
 *
 * Returns raw file text only; registry semantics live in
 * `apps/api/src/notifications/sms/sms_templates.ts`.
 */

export type LoadedSmsTemplatesFile = {
  network: string;
  /** null = the network-level file; otherwise the brand sub-folder's name. */
  brand: string | null;
  text: string;
};

export type LoadSmsTemplatesFilesOptions = {
  source: 'local' | 'remote';
  /** Path to network.json — sms.properties sits beside it (consent pattern). */
  networkLocalFile: string;
  networks: string[];
};

/**
 * Local mode: the network default `sms.properties` sits beside `network.json`;
 * brand overrides live in immediate sub-folders named for the brand id. Local
 * mode is single-network. Remote mode returns [] (not implemented).
 *
 * Network layer first, then brands, so callers can merge left to right.
 */
export async function loadSmsTemplatesFiles(
  opts: LoadSmsTemplatesFilesOptions
): Promise<LoadedSmsTemplatesFile[]> {
  if (opts.source !== 'local') return [];

  if (opts.networks.length === 0) return [];
  const network = opts.networks[0]!;

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedSmsTemplatesFile[] = [];

  const defaultText = await readOptionalPropertiesFile(join(baseDir, 'sms.properties'));
  if (defaultText !== null) {
    results.push({ network, brand: null, text: defaultText });
  }

  // Brands are scanned even without a network-level file: the bundled defaults
  // are always the base layer, so a brand-only file is valid.
  for (const brand of await listBrandDirectories(baseDir)) {
    const brandText = await readOptionalPropertiesFile(join(baseDir, brand, 'sms.properties'));
    if (brandText === null) continue;
    results.push({ network, brand, text: brandText });
  }

  return results;
}
