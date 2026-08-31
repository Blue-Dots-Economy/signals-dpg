# CLAUDE.md — apps/ui

Guidance specific to working inside `apps/ui`. Read the root `CLAUDE.md` first for the network/domain/instance/item/action vocabulary — it's defined backend-first there; this file only restates it where the frontend's usage differs or adds something.

**Frontend-specific vocabulary note:** the UI never talks to Postgres directly — it fetches a network's `network.json` (via `@dpg/schemas`' schema registry over HTTP) and renders forms/cards from the `item_schemas`/`card` config inside it. "Schema-driven" means the UI has no hardcoded knowledge of any domain's fields; adding a field to a network only requires editing `network.json`, not this app's code. See `src/engine/README.md` for how that resolution actually works — read it before touching anything under `src/engine/`.

## `runtime-env.ts` — the single most important undocumented mechanism here

`src/lib/runtime-env.ts`'s `getRuntimeEnv()` reads `window.__DPG_UI_CONFIG__` (written into `/config.js` by the Helm chart at deploy time) **before** falling back to the Vite build-time `import.meta.env`. This is what lets one built Docker image be reconfigured per deployment (different network, different API URL, different brand) without a rebuild. If you're adding a new configurable value, decide up front whether it needs to be reconfigurable post-build (route it through `getRuntimeEnv`) or is truly build-time-fixed (plain `import.meta.env` is fine) — most new config should go through `getRuntimeEnv`.

## The `@dpg/schemas/location_fields` alias is deliberate — don't "simplify" it

`vite.config.ts` aliases `@dpg/schemas/location_fields` directly to `packages/schemas/src/location_fields.ts`, bypassing the normal `@dpg/*` → `packages/*/src` mapping (which resolves through the package's barrel `index.ts`). This exists specifically so the browser bundle doesn't pull in `@dpg/database`/`pg` transitively through the schemas barrel — `location_fields.ts` is the one export from `@dpg/schemas` the UI needs that doesn't depend on the database package. If you see an import reaching for a *different* narrow export from `@dpg/schemas`, it needs the same carve-out, not a "just import from the barrel" fix.

## Two build/dev entry points

`VITE_APP=tourist` (see `package.json`'s `dev:tourist`/`build:tourist` scripts) switches to a second, login-free, read-only entry point layered on the same component tree. See `src/tourist/README.md` for the full picture — it's current and doesn't need duplicating here.

## Theming is two layers, not one

- **Per-network base theme** (`src/theme/network-themes.ts`, `theme-provider.tsx`) — one of several hardcoded palettes selected by network id.
- **Per-brand white-label override** (`src/theme/resolve-brand.ts`, `brand-assets.ts`, `brand-meta.ts`) — layered on top for a specific brand within a network (e.g. `upsdm` on `blue_dot`), driven by `examples/schemas/<network>/[<brand>/]brand.json` and injected via the `brandThemePlugin()` custom Vite plugin (`vite.config.ts`) at build/dev time.

Both resolve independently through the same priority chain: `?query` param → `window.__DPG_UI_CONFIG__` → build-time `VITE_*` → default.

`docs/design/ui-network-theming.md` describes the network layer accurately but **predates the brand layer** — for brand-specific asset/config conventions, `apps/ui/public/brand/README.md` is the current source of truth, not the design doc.

## i18n

`docs/design/ui-localization-design.md` covers the mechanism (i18next, `import.meta.glob`-bundled `locales/*.json`, `VITE_ENABLED_LANGUAGES` override) accurately, including the unset fallback of `DEFAULT_ENABLED_CODES = ['en', 'hi']` (`src/i18n/index.ts`) that deliberately keeps the retained-but-inactive `kn` locale off. Set `VITE_ENABLED_LANGUAGES=en,hi,kn` to re-enable it — **via the chart's `ui.runtimeConfig`, not a pod env var**: the value is read from runtime config first because `import.meta.env` is inlined at build time and CI publishes the UI image with no `VITE_` build args. The same applies to `VITE_MAP_DEFAULT_CENTER` / `VITE_MAP_DEFAULT_ZOOM`. Schema-driven content (a network's own field titles) is explicitly out of scope for i18n — only UI chrome is localized.

## Data fetching

No generated API client. `src/lib/api-client.ts` builds one shared `axios` instance (Bearer-token interceptor via `src/contexts/auth-context.tsx`'s session), and each `src/lib/*-api.ts` file (`auth-api`, `item-api`, `network-api`, `action-api`, `consent-api`, `wallet-api`, `digilocker-api`, `match-score-api`, `support-api`, `bulk-api`) wraps a specific set of endpoints by hand. React Query (`@tanstack/react-query`) is the caching layer, used via hooks (`use-network-config.ts`, `use-consent-config.ts`, `use-consent-gate.ts`, etc.) rather than context — `auth-context.tsx` is the only React Context in the app.

## Largest files (candidates for splitting if you're touching them heavily)

`pages/home-page.tsx` (~1370 lines — filters, map/list toggle, domain tabs, search all in one page), `pages/profile-form-page.tsx` (~670 lines), `components/forms/schema-form.tsx` (~500 lines). Not broken, just large — expect to spend time finding the right spot before editing rather than assuming a small, focused file.
