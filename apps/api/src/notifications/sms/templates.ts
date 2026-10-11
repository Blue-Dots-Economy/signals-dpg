import { readFile } from 'node:fs/promises';

import { apiConfig, notification } from '@/config';
import { loadSmsTemplatesFiles } from '@dpg/config';
import type { LoadedSmsTemplatesFile } from '@dpg/config';

import { loadSmsTemplateIndex, type SmsTemplateIndex } from './sms_templates';

/**
 * Boot-time loader for the SMS template registry (#595 Phase 2) — the SMS
 * counterpart of `email/messages.ts`, deliberately not the same code.
 *
 * Layering mirrors the copy files: bundled defaults < `SMS_MESSAGES_PATH` <
 * network `sms.properties` < brand `sms.properties`. Everything above the file
 * discovery differs, though. `loadSmsTemplateIndex` merges per key into
 * `{ templateId, body, vars }` and treats a BLANK `template_id` as meaningful —
 * it is the "not DLT-approved yet" signal that makes `dispatchSms` skip the
 * send. The email merge discards empty values, which would arm every
 * unapproved template.
 *
 * Failure policy differs too. Email is critical path, so a defect in its
 * bundled file throws at boot. SMS is best-effort end to end, so every failure
 * here degrades to "fewer templates configured" — which just means more sends
 * are skipped. An SMS problem must never stop the API from starting.
 */

// Resolves next to this module: apps/api/src in dev (tsx/vitest), dist/ in the
// tsup bundle — tsup's onSuccess copies the file there (see tsup.config.ts).
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

/**
 * The layered SMS template index, loaded once per process.
 *
 * Layer order is the contract: `loadSmsTemplateIndex` applies layers left to
 * right and later layers win, so defaults come first and the brand file last.
 */
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
      // Mirrors the copy loader: a bad network/brand file must never take SMS
      // down any more than a bad SMS_MESSAGES_PATH does.
      console.warn(
        `sms templates: cannot read network/brand template files (${String(err)}) — using bundled/instance templates only`,
      );
    }

    // Network layer before brand layer. The loader already returns them in
    // that order; sorting makes this independent of that, because getting it
    // backwards would silently prefer the network file over the brand's.
    const ordered = [...files].sort(
      (a, b) => Number(a.brand !== null) - Number(b.brand !== null),
    );

    const index = loadSmsTemplateIndex([
      defaultsText,
      ...(overrideText ? [overrideText] : []),
      ...ordered.map((f) => f.text),
    ]);

    // Make the inert state legible in deploy logs: "0 with a template_id" is
    // the expected reading until DLT registration lands, and the number going
    // UP is how an operator confirms a newly-approved id actually shipped.
    const configured = [...index.values()].filter((t) => t.templateId).length;
    console.info(
      `sms templates: ${index.size} cases loaded from ${ordered.length + (overrideText ? 1 : 0) + 1} layer(s), ` +
        `${configured} with a template_id (the rest are skipped at send time)`,
    );

    return index;
  })().catch((err: unknown) => {
    // Never latch a rejection — the next call retries — and never throw past
    // here: SMS is best-effort, so an unreadable bundled file means "no
    // templates configured", not "the API does not start".
    templatesPromise = null;
    console.warn(`sms templates: load failed (${String(err)}) — no templates configured`);
    return new Map() as SmsTemplateIndex;
  });

  return templatesPromise;
}
