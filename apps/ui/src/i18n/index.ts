import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { getRuntimeEnv } from '@/lib/runtime-env';

// Eagerly import all locale JSON. `import: 'default'` yields the parsed JSON
// itself; without it every key would sit under `default` and every t() would
// miss.
const modules = import.meta.glob('./locales/*.json', {
  eager: true,
  import: 'default',
});

const resources: Record<string, { translation: Record<string, unknown> }> = {};
const discoveredCodes: string[] = [];

for (const path of Object.keys(modules)) {
  const match = /\.\/locales\/([^/]+)\.json$/.exec(path);
  if (!match) continue;
  const code = match[1];
  discoveredCodes.push(code);
  resources[code] = {
    translation: modules[path] as Record<string, unknown>,
  };
}

// VITE_ENABLED_LANGUAGES comes from `getRuntimeEnv` (the chart's runtime
// config, falling back to build time). `import.meta.env` alone would not work:
// it is inlined at build and CI builds the image with no VITE_ args, so one
// image could not serve en,hi in one region and en,hi,kn in another.
const rawEnabled = getRuntimeEnv('VITE_ENABLED_LANGUAGES');
const enabledCodes: string[] =
  rawEnabled
    ?.split(',')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0) ?? [];

// Default active languages when VITE_ENABLED_LANGUAGES is unset. Curated, not
// "all discovered", so retained-but-inactive locales like kn stay off.
const DEFAULT_ENABLED_CODES = ['en', 'hi'];

// supportedLngs: the env list if set, else the default; always includes 'en'.
const supportedLngs: string[] =
  enabledCodes.length > 0
    ? Array.from(new Set(['en', ...enabledCodes]))
    : Array.from(
        new Set([
          'en',
          ...DEFAULT_ENABLED_CODES.filter((c) => discoveredCodes.includes(c)),
        ]),
      );

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs,
    // Locale files use flat dotted keys ("common.login"), so disable key
    // nesting or every key would be unresolvable. nsSeparator (':') stays;
    // no key contains a colon.
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
 * Languages for the dropdown: the VITE_ENABLED_LANGUAGES codes in order, else
 * DEFAULT_ENABLED_CODES, intersected with the discovered locale files. `name`
 * is the JSON's `_name` field, or the code.
 */
export function getAvailableLanguages(): Array<{ code: string; name: string }> {
  const orderedCodes =
    enabledCodes.length > 0
      ? enabledCodes.filter((c) => discoveredCodes.includes(c))
      : DEFAULT_ENABLED_CODES.filter((c) => discoveredCodes.includes(c));

  return orderedCodes.map((code) => {
    const translation = resources[code]?.translation;
    const name =
      typeof translation?._name === 'string' ? translation._name : code;
    return { code, name };
  });
}
