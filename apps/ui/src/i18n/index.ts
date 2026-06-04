import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

// Eagerly import all locale JSON files. `import: 'default'` makes each value
// the parsed JSON object itself — without it, eager glob yields the module
// namespace ({ default: {...} }), which would bury every translation key one
// level deep under `default` and make every t() lookup miss.
const modules = import.meta.glob('./locales/*.json', {
  eager: true,
  import: 'default',
});

// Build resources object: { [code]: { translation: <file contents> } }
const resources: Record<string, { translation: Record<string, unknown> }> = {};
const discoveredCodes: string[] = [];

for (const path of Object.keys(modules)) {
  // Extract language code from path: './locales/en.json' → 'en'
  const match = /\.\/locales\/([^/]+)\.json$/.exec(path);
  if (!match) continue;
  const code = match[1];
  discoveredCodes.push(code);
  resources[code] = {
    translation: modules[path] as Record<string, unknown>,
  };
}

// Parse VITE_ENABLED_LANGUAGES env var
const rawEnabled = import.meta.env.VITE_ENABLED_LANGUAGES;
const enabledCodes: string[] =
  rawEnabled
    ?.split(',')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0) ?? [];

// supportedLngs: env list (if set) else all discovered; always include 'en'
const supportedLngs: string[] =
  enabledCodes.length > 0
    ? Array.from(new Set(['en', ...enabledCodes]))
    : Array.from(new Set(['en', ...discoveredCodes]));

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs,
    // Our locale files use FLAT dotted keys (e.g. "common.login") rather than
    // nested objects. i18next defaults to '.' as a nested-key separator, which
    // would make every flat key unresolvable (it echoes the key back). Disable
    // key nesting so the full string is treated as one literal key. nsSeparator
    // (':') is left at its default since no key contains a colon.
    keySeparator: false,
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      lookupQuerystring: 'lang',
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18next;

/**
 * Returns the list of available languages for the dropdown.
 * If VITE_ENABLED_LANGUAGES is set, returns those codes in order (intersected
 * with discovered locale files). If unset, returns all discovered locales.
 * Each entry has `code` and `name` (the `_name` field from the JSON, or code
 * as fallback).
 */
export function getAvailableLanguages(): Array<{ code: string; name: string }> {
  const orderedCodes =
    enabledCodes.length > 0
      ? enabledCodes.filter((c) => discoveredCodes.includes(c))
      : discoveredCodes;

  return orderedCodes.map((code) => {
    const translation = resources[code]?.translation;
    const name =
      typeof translation?._name === 'string' ? translation._name : code;
    return { code, name };
  });
}
