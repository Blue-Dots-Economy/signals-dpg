# UI Localization (i18n) — Design

Add multi-language support to the Signals UI so the app's own text can render in English, Kannada, Hindi (and any language added later), with a language dropdown in the top bar.

---

## 1. Goal & decisions

| Decision | Choice |
|----------|--------|
| **Library** | `react-i18next` (+ `i18next`, `i18next-browser-languagedetector`) |
| **Scope** | **UI chrome only** — the app's own hardcoded strings (buttons, labels, headers, empty states, toasts, aria-labels, placeholders). NOT schema-driven content (field titles / enum values from `network.json`) and NOT user data. |
| **Which languages appear** | Driven by an **explicit enabled list** in env (`VITE_ENABLED_LANGUAGES`). |
| **Default language** | **Detect the browser language**; if no matching locale, fall back to **English**. The user's manual choice is **persisted** (localStorage). |
| **Dropdown placement** | **Top app bar**, visible to **everyone** (signed-in and guests). |
| **Adding a new language** | Add a `<code>.json` locale file + add the code to `VITE_ENABLED_LANGUAGES`. The file declares its own native name, so no other code changes. |

---

## 2. How it works (overview)

```
locales/en.json, kn.json, hi.json …   (translation files, each self-describing)
        │  (bundled via Vite import.meta.glob)
        ▼
i18next instance  ── supportedLngs = VITE_ENABLED_LANGUAGES, fallbackLng = "en"
        │            language detection: localStorage → browser, persisted to localStorage
        ▼
<I18nextProvider> wraps the app
        │
        ▼
components call  t('some.key')  instead of hardcoded text
        │
        ▼
Language dropdown (top bar) → i18n.changeLanguage(code) → whole UI re-renders
```

---

## 3. File structure

```
apps/ui/src/i18n/
├── index.ts            # i18next init: glob-load locales, configure detection/fallback
├── locales/
│   ├── en.json
│   ├── kn.json
│   └── hi.json
└── use-languages.ts    # returns the enabled language list (code + native name) for the dropdown
apps/ui/src/components/layout/language-switcher.tsx   # the dropdown
```

### Locale file shape
Each file is a flat JSON of dotted keys, plus a reserved `_name` holding the language's **native** display name (so the dropdown label travels with the file):

```jsonc
// en.json
{
  "_name": "English",
  "common.filters": "Filters",
  "common.clear_all": "Clear all",
  "nav.browse_all": "Browse All",
  "nav.all": "All",
  "content.listings_one": "{{count}} listing",
  "content.listings_other": "{{count}} listings",
  "map.no_results": "No items match the current filters.",
  "map.loading": "Loading map data…",
  "profile.create": "Create Profile",
  "auth.sign_in_to_connect": "Sign in to connect",
  ...
}
```
```jsonc
// kn.json
{
  "_name": "ಕನ್ನಡ",
  "common.filters": "ಫಿಲ್ಟರ್‌ಗಳು",
  ...
}
```

`en.json` is the **source of truth** for the full key set and the fallback. Other files translate the same keys; any missing key falls back to English automatically.

---

## 4. The enabled-language list & dropdown

- **`VITE_ENABLED_LANGUAGES`** (e.g. `en,kn,hi`) — comma-separated codes, in display order. This controls which languages the dropdown offers and which i18next treats as supported (`supportedLngs`).
- `index.ts` uses `import.meta.glob('./locales/*.json', { eager: true })` to bundle every locale file. `use-languages.ts` intersects the globbed files with `VITE_ENABLED_LANGUAGES` and reads each file's `_name` to build `[{ code, name }]` for the dropdown.
- **Convenience fallback:** if `VITE_ENABLED_LANGUAGES` is unset, the dropdown shows **all** discovered locale files. So in dev, dropping in a new `fr.json` makes French appear immediately; in a controlled deployment, the env var pins the exact set. (This honors both "explicit control" and "just add a file.")
- The dropdown is a small `Select`/`DropdownMenu` (reuse existing `@/components/ui/*`) in `top-bar.tsx`, showing the current language's `_name`; selecting calls `i18n.changeLanguage(code)`.

---

## 5. Default language, detection & persistence

Use `i18next-browser-languagedetector` with:
- `fallbackLng: 'en'`
- `supportedLngs: <enabled list>` (so an unsupported browser language falls back cleanly)
- detection `order: ['querystring', 'localStorage', 'navigator']`, `lookupQuerystring: 'lang'`, `caches: ['localStorage']`.

Priority of resolution, highest first:
1. **`?lang=<code>` URL param** — a shareable/forced language link (e.g. `?lang=kn`). If the code is supported, it wins and is cached to localStorage.
2. **localStorage** — the user's previously chosen language.
3. **Browser language** (`navigator`) — first-time visitors with no saved choice.
4. **English** — fallback when none of the above is supported.

---

## 6. Key conventions

- **One namespace** (`translation`) with **dotted, area-prefixed keys**: `common.*`, `nav.*`, `content.*`, `map.*`, `filters.*`, `profile.*`, `auth.*`, `actions.*`, `wallet.*`.
- **Interpolation:** `t('greeting', { name })` → `"Hi {{name}}"`.
- **Pluralization:** use i18next plural keys (`content.listings_one` / `content.listings_other`) instead of the manual `count === 1 ? 'listing' : 'listings'` done today in `ContentHeader`.
- **No string concatenation** in code — full sentences live in the locale file (so translators can reorder words).

---

## 7. String-extraction plan (phased)

~28 `.tsx` files contain user-facing copy; the 25 `components/ui/*` primitives mostly don't. Extract in phases so each is reviewable and the app stays working (English unchanged) throughout:

1. **Setup** — install deps, add `i18n/index.ts`, `en.json` (seed with a handful of keys), wrap the app, add the language switcher. No visible change yet.
2. **Navigation & chrome** — `top-bar.tsx`, `sidebar.tsx`, `content-header.tsx`, `page-shell.tsx`, guest hero.
3. **Map** — `map-filters-panel.tsx`, `map-container.tsx`, `marker-popup-card.tsx`.
4. **Profiles & home** — `home-page.tsx`, `profile-form-page.tsx` (incl. toasts).
5. **Auth** — `login-page.tsx`, `otp-page.tsx`.
6. **Actions & wallet** — `action-*`, `my-actions-page.tsx`, wallet providers.
7. **Add `kn.json` / `hi.json`** — translate the now-complete `en.json` key set with **real Kannada and Hindi translations** (machine-assisted, to be reviewed/corrected by a native speaker), using **correct per-language plural forms** (i18next plural keys per language's rules — Kannada/Hindi differ from English).

After each phase, every touched string is replaced with `t('key')` and added to `en.json`; the UI looks identical in English.

---

## 8. Out of scope (for this iteration)

- **Schema-driven content** — field titles and enum values from `network.json` (e.g. "Looking For", "Disabilities Served", "Hospital / Clinic"). These are config-driven, per-network, and would need a separate translation mechanism. Not part of UI-chrome i18n.
- **User-generated data** — item values, names, etc. are never translated.
- **Number / date / currency formatting** — could adopt i18next/Intl formatters later; not required for v1.
- **RTL layout** — en/kn/hi are all left-to-right; no RTL work needed now.
- **Map tile labels** — place names on the map come from the map provider's tiles, not the app.

---

## 9. New dependencies & env

| Dependency | Purpose |
|------------|---------|
| `i18next` | Core i18n engine |
| `react-i18next` | React bindings (`useTranslation`, `<Trans>`) |
| `i18next-browser-languagedetector` | Browser/localStorage language detection |

| Env var | Purpose | Default |
|---------|---------|---------|
| `VITE_ENABLED_LANGUAGES` | Comma-separated language codes shown in the dropdown, in order | (unset → all discovered locale files) |

---

## 10. Resolved decisions

1. **URL param** — ✅ Yes. Support `?lang=<code>` (highest-priority language source; see §5). Cached to localStorage on use.
2. **Initial translations** — ✅ Provide **real Kannada/Hindi translations** (machine-assisted) for native-speaker review — not English placeholders.
3. **Pluralization** — ✅ Use **correct per-language plural forms** (i18next plural keys following each language's rules), not a single form.
4. **Scope** — ✅ **`apps/ui` only.** Everything else (e.g. the `apps/docs` site) is excluded.
