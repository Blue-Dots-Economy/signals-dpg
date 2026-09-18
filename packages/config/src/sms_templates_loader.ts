import { dirname, join, resolve } from 'node:path';

import {
  listBrandDirectories,
  readOptionalPropertiesFile,
} from './properties_file_io.js';

/**
 * Discovery for the per-network/brand SMS template files (#595 Phase 2).
 *
 * Mirrors `email_messages_loader.ts` in layout — the network default sits
 * beside `network.json`, brand overrides in immediate sub-folders — because the
 * deploy pipeline delivers both the same way (bluedots-automation's
 * `fetch-configs.sh` pulls them from the schemas repo into the schemas
 * ConfigMap mounted at `dirname(NETWORK_CONFIG_LOCAL_FILE)`).
 *
 * It is a SEPARATE loader rather than the email one parameterised by filename,
 * on purpose. SMS templates are a different artefact under different rules:
 * they carry `template_id` / `body` / `vars` instead of subject/body/cta, have
 * no fixed key whitelist (any case id is valid), and give an EMPTY value the
 * opposite meaning. An empty email value is discarded so a bad override can
 * never ship a blank subject; an empty `template_id` is the signal that a
 * template is not DLT-approved yet and the send must be skipped. Sharing the
 * merge would quietly arm every unapproved template — and email is boot-
 * critical, so it should not gain a new failure mode for SMS's benefit.
 *
 * Returns raw file text only. Registry semantics live in
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
 * mode is single-network (mirrors consent_config_loader).
 *
 * Remote mode: returns [] — remote delivery is not implemented for the copy
 * files either, and the deploy pipeline fetches from the schemas repo at deploy
 * time rather than the app fetching at runtime.
 *
 * Network layer first, then brands, so callers can merge left to right.
 */
export async function loadSmsTemplatesFiles(
  opts: LoadSmsTemplatesFilesOptions
): Promise<LoadedSmsTemplatesFile[]> {
  if (opts.source !== 'local') return [];

  // Local mode represents exactly one network — use only the first entry.
  if (opts.networks.length === 0) return [];
  const network = opts.networks[0]!;

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedSmsTemplatesFile[] = [];

  const defaultText = await readOptionalPropertiesFile(join(baseDir, 'sms.properties'));
  if (defaultText !== null) {
    results.push({ network, brand: null, text: defaultText });
  }

  // Brand sub-folders are scanned even when the network-level file is absent:
  // the bundled defaults are always the base layer, so a brand-only file is
  // valid on its own and must not be skipped for want of a network file.
  for (const brand of await listBrandDirectories(baseDir)) {
    const brandText = await readOptionalPropertiesFile(join(baseDir, brand, 'sms.properties'));
    if (brandText === null) continue;
    results.push({ network, brand, text: brandText });
  }

  return results;
}
