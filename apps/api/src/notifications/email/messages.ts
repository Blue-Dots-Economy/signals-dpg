import { readFile } from 'node:fs/promises';

import { apiConfig, notification } from '@/config';
import { loadEmailMessagesFiles } from '@dpg/config';
import type { LoadedEmailMessagesFile } from '@dpg/config';

import { EMAIL_CASE_IDS, getEmailCase, requiredMessageKeys } from './email_cases';
import { parseProperties } from './parse_properties';
import { TOKEN_RE } from './substitute';

/**
 * Layered email copy. Per-key precedence, lowest to highest: bundled defaults
 * < instance override (EMAIL_MESSAGES_PATH) < network file < brand file.
 * Override layers are partial and a bad key falls back with a warning; only the
 * bundled defaults must be complete (a missing key throws). Loaded once per
 * process, so copy changes apply on restart.
 * Operations: docs/operations/email-copy-overrides.md.
 */
export interface EmailMessages {
  get(key: string): string;
}

export interface EmailMessagesIndex {
  /** brand, then network, then instance-base fallback; unknown/null args fall through. */
  forContext(network?: string | null, brand?: string | null): EmailMessages;
}

/** Warn when a copy value references a placeholder its case never provides. */
function lintPlaceholders(
  entries: ReadonlyMap<string, string>,
  warn: (message: string) => void,
  label?: string,
): void {
  const prefix = label ? `email messages (${label})` : 'email messages';
  for (const id of EMAIL_CASE_IDS) {
    const def = getEmailCase(id);
    const keys = [def.keys.subject, def.keys.body, def.keys.cta].filter(
      (k): k is string => Boolean(k),
    );
    for (const key of keys) {
      const value = entries.get(key);
      if (!value) continue;
      for (const m of value.matchAll(TOKEN_RE)) {
        // Object.hasOwn, not `in`, so {{toString}} is not "declared" via the prototype.
        if (!Object.hasOwn(def.tokens, m[1])) {
          warn(
            `${prefix}: "${key}" references unknown placeholder {{${m[1]}}} — it will appear in the email as literal text`,
          );
        }
      }
    }
  }
}

/**
 * Merges a partial override over `base` per key. Unknown keys, malformed
 * lines and empty values warn (tagged with `label`) and are ignored.
 */
function mergeLayer(
  base: ReadonlyMap<string, string>,
  overrideText: string,
  label: string,
  known: ReadonlySet<string>,
  warn: (message: string) => void,
): Map<string, string> {
  const merged = new Map(base);
  const override = parseProperties(overrideText);

  for (const line of override.malformedLines) {
    warn(`email messages ${label}: line ${line} is not "key=value" — ignored`);
  }

  let overriddenCount = 0;
  for (const [key, value] of override.entries) {
    if (!known.has(key)) {
      warn(`email messages ${label}: unknown key "${key}" — ignored (typo?)`);
      continue;
    }
    // An empty value would send a blank subject/body, so fall back instead.
    if (value === '') {
      warn(
        `email messages ${label}: empty value for "${key}" — ignored (falls back to the previous layer)`,
      );
      continue;
    }
    merged.set(key, value);
    overriddenCount += 1;
  }

  const fellBackCount = known.size - overriddenCount;
  warn(
    `email messages ${label}: ${overriddenCount} keys overridden, ${fellBackCount} keys falling back to the previous layer`,
  );

  return merged;
}

function toEmailMessages(entries: ReadonlyMap<string, string>): EmailMessages {
  return {
    get(key: string): string {
      const value = entries.get(key);
      if (value === undefined) throw new Error(`unknown email message key: ${key}`);
      return value;
    },
  };
}

function brandLayerKey(network: string, brand: string): string {
  return `${network}:${brand}`;
}

export function loadEmailMessagesIndex(opts: {
  defaultsText: string;
  instanceOverrideText?: string | null;
  layers?: LoadedEmailMessagesFile[];
  warn?: (message: string) => void;
}): EmailMessagesIndex {
  const warn = opts.warn ?? ((message: string) => console.warn(message));

  const defaults = parseProperties(opts.defaultsText);
  const required = requiredMessageKeys();
  const missing = required.filter((k) => !defaults.entries.has(k));
  if (missing.length > 0) {
    // A hole in the bundled file is a build defect, not an ops condition.
    throw new Error(
      `bundled email messages file is missing required keys: ${missing.join(', ')}`,
    );
  }
  const known = new Set(required);

  let base = new Map(defaults.entries);
  if (opts.instanceOverrideText != null) {
    base = mergeLayer(base, opts.instanceOverrideText, 'override', known, warn);
  }
  lintPlaceholders(base, warn);
  const baseMessages = toEmailMessages(base);

  // Keyed by network id (network layer) or `${network}:${brand}` (brand
  // layer). forContext() tries brand, then network, then falls back to base.
  const layerMessages = new Map<string, EmailMessages>();

  const byNetwork = new Map<string, LoadedEmailMessagesFile[]>();
  for (const layer of opts.layers ?? []) {
    const list = byNetwork.get(layer.network) ?? [];
    list.push(layer);
    byNetwork.set(layer.network, list);
  }

  for (const [network, entries] of byNetwork) {
    const networkEntry = entries.find((e) => e.brand === null);
    // A brand file for a network with no network file merges over base.
    let networkMap: ReadonlyMap<string, string> = base;

    if (networkEntry) {
      const label = `network ${network}`;
      networkMap = mergeLayer(base, networkEntry.text, label, known, warn);
      lintPlaceholders(networkMap, warn, label);
      layerMessages.set(network, toEmailMessages(networkMap));
    }

    for (const entry of entries) {
      if (entry.brand === null) continue;
      const label = `network ${network} brand ${entry.brand}`;
      const brandMap = mergeLayer(networkMap, entry.text, label, known, warn);
      lintPlaceholders(brandMap, warn, label);
      layerMessages.set(brandLayerKey(network, entry.brand), toEmailMessages(brandMap));
    }
  }

  return {
    forContext(network?: string | null, brand?: string | null): EmailMessages {
      if (network && brand) {
        const messages = layerMessages.get(brandLayerKey(network, brand));
        if (messages) return messages;
      }
      if (network) {
        const messages = layerMessages.get(network);
        if (messages) return messages;
      }
      return baseMessages;
    },
  };
}

// Resolves next to this module: src/ in dev, dist/ in the bundle (copied by tsup.config.ts).
const DEFAULTS_URL = new URL('./messages.default.properties', import.meta.url);

let messagesPromise: Promise<EmailMessagesIndex> | null = null;

export function getEmailMessages(): Promise<EmailMessagesIndex> {
  if (messagesPromise) return messagesPromise;
  messagesPromise = (async () => {
    const defaultsText = await readFile(DEFAULTS_URL, 'utf8');
    let instanceOverrideText: string | null = null;
    const overridePath = notification.EMAIL_MESSAGES_PATH;
    if (overridePath) {
      try {
        instanceOverrideText = await readFile(overridePath, 'utf8');
      } catch (err) {
        console.warn(
          `email messages: cannot read EMAIL_MESSAGES_PATH "${overridePath}" (${String(err)}) — using bundled defaults`,
        );
      }
    }

    const networks = [
      ...new Set(apiConfig.served_domains.map((binding) => binding.network)),
    ];
    let layers: LoadedEmailMessagesFile[] = [];
    if (apiConfig.network_config_source !== 'local') {
      // Remote network-config mode loads no network/brand copy files; warn so
      // an operator's network copy does not vanish silently.
      console.warn(
        'email messages: network/brand copy files are not loaded when NETWORK_CONFIG_SOURCE is not "local" — EMAIL_MESSAGES_PATH is the only override surface on this instance',
      );
    }
    try {
      layers = await loadEmailMessagesFiles({
        source: apiConfig.network_config_source,
        networkLocalFile: apiConfig.network_config_local_file,
        networks,
      });
    } catch (err) {
      // The loader rethrows anything but a missing file. A bad network/brand
      // file must not take email down: fall back to instance/base copy.
      console.warn(
        `email messages: cannot read network/brand messages files (${String(err)}) — using instance/base copy only`,
      );
    }

    return loadEmailMessagesIndex({ defaultsText, instanceOverrideText, layers });
  })().catch((err: unknown) => {
    // Do not cache a rejected promise; the next call retries.
    messagesPromise = null;
    throw err;
  });
  return messagesPromise;
}

/** Test-only: drop the singleton so the next call re-reads config + files. */
export function resetEmailMessagesForTests(): void {
  messagesPromise = null;
}
