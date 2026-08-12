import { readFile } from 'node:fs/promises';

import { notification } from '@/config';

import { EMAIL_CASE_IDS, getEmailCase, requiredMessageKeys } from './email_cases';
import { parseProperties } from './parse_properties';

/**
 * Boot-time loader for the email messages file (#529). Bundled defaults ship
 * next to this module; an ops override (ConfigMap mount) is pointed at by
 * EMAIL_MESSAGES_PATH and merged PER KEY — a typo'd or partial override can
 * never take email down, it just falls back key-by-key with a warning.
 * Loaded once per process (singleton promise, the network_configs pattern);
 * copy changes apply on restart/deploy.
 */
export interface EmailMessages {
  get(key: string): string;
}

const TOKEN_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

/** Warn when a copy value references a placeholder its case never provides. */
function lintPlaceholders(
  entries: Map<string, string>,
  warn: (message: string) => void,
): void {
  for (const id of EMAIL_CASE_IDS) {
    const def = getEmailCase(id);
    const keys = [def.keys.subject, def.keys.body, def.keys.cta].filter(
      (k): k is string => Boolean(k),
    );
    for (const key of keys) {
      const value = entries.get(key);
      if (!value) continue;
      for (const m of value.matchAll(TOKEN_RE)) {
        if (!(m[1] in def.tokens)) {
          warn(
            `email messages: "${key}" references unknown placeholder {{${m[1]}}} — it will appear in the email as literal text`,
          );
        }
      }
    }
  }
}

export function loadEmailMessages(opts: {
  defaultsText: string;
  overrideText?: string | null;
  warn?: (message: string) => void;
}): EmailMessages {
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

  const merged = new Map(defaults.entries);

  if (opts.overrideText != null) {
    const override = parseProperties(opts.overrideText);
    for (const line of override.malformedLines) {
      warn(`email messages override: line ${line} is not "key=value" — ignored`);
    }
    const known = new Set(required);
    for (const [key, value] of override.entries) {
      if (!known.has(key)) {
        warn(`email messages override: unknown key "${key}" — ignored (typo?)`);
        continue;
      }
      merged.set(key, value);
    }
    const overridden = [...override.entries.keys()].filter((k) => known.has(k));
    const fellBack = required.filter((k) => !override.entries.has(k));
    warn(
      `email messages override loaded: ${overridden.length} keys overridden, ${fellBack.length} keys using bundled defaults`,
    );
  }

  lintPlaceholders(merged, warn);

  return {
    get(key: string): string {
      const value = merged.get(key);
      if (value === undefined) throw new Error(`unknown email message key: ${key}`);
      return value;
    },
  };
}

// Resolves next to this module: apps/api/src in dev (tsx/vitest), dist/ in the
// tsup bundle — tsup's onSuccess copies the file there (see tsup.config.ts).
const DEFAULTS_URL = new URL('./messages.default.properties', import.meta.url);

let messagesPromise: Promise<EmailMessages> | null = null;

export function getEmailMessages(): Promise<EmailMessages> {
  if (messagesPromise) return messagesPromise;
  messagesPromise = (async () => {
    const defaultsText = await readFile(DEFAULTS_URL, 'utf8');
    let overrideText: string | null = null;
    const overridePath = notification.EMAIL_MESSAGES_PATH;
    if (overridePath) {
      try {
        overrideText = await readFile(overridePath, 'utf8');
      } catch (err) {
        console.warn(
          `email messages: cannot read EMAIL_MESSAGES_PATH "${overridePath}" (${String(err)}) — using bundled defaults`,
        );
      }
    }
    return loadEmailMessages({ defaultsText, overrideText });
  })();
  return messagesPromise;
}

/** Test-only: drop the singleton so the next call re-reads config + files. */
export function resetEmailMessagesForTests(): void {
  messagesPromise = null;
}
