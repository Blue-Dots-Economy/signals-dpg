import { readFile } from 'node:fs/promises';

import { apiConfig, notification } from '@/config';
import { loadSmsTemplatesFiles } from '@dpg/config';
import type { LoadedSmsTemplatesFile } from '@dpg/config';

import { loadSmsTemplateIndex, type SmsTemplateIndex } from './sms_templates';

/**
 * Loader for the SMS template registry. Layers: bundled defaults <
 * `SMS_MESSAGES_PATH` < network `sms.properties` < brand `sms.properties`.
 *
 * Separate from `email/messages.ts` because a blank `template_id` is
 * meaningful here ("not DLT-approved yet", so `dispatchSms` skips), whereas the
 * email merge discards empty values. SMS is best-effort, so every load failure
 * degrades to fewer templates and never stops the API from starting.
 */

// Resolves next to this module: src/ in dev, dist/ in the bundle (copied by tsup.config.ts).
const DEFAULTS_URL = new URL('./sms.default.properties', import.meta.url);

let templatesPromise: Promise<SmsTemplateIndex> | null = null;

async function readOverrideText(): Promise<string | null> {
  const path = notification.SMS_MESSAGES_PATH;
  if (!path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    console.warn(
      `sms templates: cannot read SMS_MESSAGES_PATH "${path}" (${String(err)}) — using bundled defaults`,
    );
    return null;
  }
}

/** The layered SMS template index, loaded once per process. Later layers win. */
export function getSmsTemplates(): Promise<SmsTemplateIndex> {
  if (templatesPromise) return templatesPromise;

  templatesPromise = (async () => {
    const defaultsText = await readFile(DEFAULTS_URL, 'utf8');
    const overrideText = await readOverrideText();
    const networks = [...new Set(apiConfig.served_domains.map((b) => b.network))];

    let files: LoadedSmsTemplatesFile[] = [];
    try {
      files = await loadSmsTemplatesFiles({
        source: apiConfig.network_config_source,
        networkLocalFile: apiConfig.network_config_local_file,
        networks,
      });
    } catch (err) {
      // A bad network/brand file must not take SMS down.
      console.warn(
        `sms templates: cannot read network/brand template files (${String(err)}) — using bundled/instance templates only`,
      );
    }

    // Network layer before brand layer, so the brand file wins.
    const ordered = [...files].sort(
      (a, b) => Number(a.brand !== null) - Number(b.brand !== null),
    );

    const index = loadSmsTemplateIndex([
      defaultsText,
      ...(overrideText ? [overrideText] : []),
      ...ordered.map((f) => f.text),
    ]);

    // Lets operators confirm in deploy logs that a newly-approved template id shipped.
    const configured = [...index.values()].filter((t) => t.templateId).length;
    console.info(
      `sms templates: ${index.size} cases loaded from ${ordered.length + (overrideText ? 1 : 0) + 1} layer(s), ` +
        `${configured} with a template_id (the rest are skipped at send time)`,
    );

    return index;
  })().catch((err: unknown) => {
    // Do not cache the failure (the next call retries) and do not throw: SMS is best-effort.
    templatesPromise = null;
    console.warn(`sms templates: load failed (${String(err)}) — no templates configured`);
    return new Map() as SmsTemplateIndex;
  });

  return templatesPromise;
}
