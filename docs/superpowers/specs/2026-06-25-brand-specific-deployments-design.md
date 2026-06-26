# Network + Brand for signals-dpg

**Date:** 2026-06-25
**Status:** Approved (design) — pending implementation plan
**Branch:** `feat/brand-specific-deployments` (based on `origin/feature`)
**Area:** apps/ui theme pipeline, brand assets, tourist app, Helm runtime config

## Problem

Signals-dpg themes the UI purely by **network id** (`data-network` attribute + a
kebab logo folder). There is no brand concept. UP Blue Dots ("UPSDM") and OneTAC
are *brands* that ride on **shared networks** (UP Blue Dots = the shared
`blue_dot` network; geography is a domain, not a network). Because there is no
brand layer, the UPSDM/OneTAC work overwrote the shared network's artwork and
hardcoded network ids in component logic — so every `blue_dot` deployment
(national, KA, UP) now renders the UP state emblem, and the tourist app is frozen
to OneTAC.

Commit `ccdc1fd` ("feat(ui): UPSDM brand logo for blue_dot") states the problem
outright: *"UP Blue Dots runs on the shared blue_dot network … this rebrands ALL
blue_dot deployments."*

### What broke agnosticism (current branch state, verified)

- `apps/ui/public/brand/blue-dot/*.png` overwritten with the UPSDM emblem
  (current `logo.png` = blob `26feef4`, from `ccdc1fd`). Standard "blue dots AI"
  logos last existed at commit `0f59a26` (blob `9bb83d0`) — a branch ancestor.
- `apps/ui/public/brand/orange-dot/*.png` are OneTAC (current `logo.png` =
  `1fd594d`). The generic "orange dots" seed is commit `0678589` (blob
  `4f7ecb1`) — NOT a branch ancestor, but the objects are retrievable.
- Hardcoded network ids in code:
  - `apps/ui/src/theme/theme-provider.tsx` — `NETWORKS_WITH_FAVICON_PNG = new Set(['orange_dot','blue_dot'])`.
  - `apps/ui/src/components/layout/portal-header.tsx` — `isSquareishMark = themeId === 'orange_dot' || themeId === 'blue_dot'`.
- Tourist app hardwired to OneTAC: `apps/ui/src/tourist/tourist-top-bar.tsx`
  `TOURIST_NETWORK_ID = 'orange_dot'`; `apps/ui/index.tourist.html` hardcoded
  `<title>OneTAC</title>`, `/brand/orange-dot/favicon.png`,
  `data-network='orange_dot'`; `apps/ui/src/main.tourist.tsx` title fallback
  `|| 'OneTAC'`.
- Brand copy (tagline, subline, portalLabel) is hardcoded per-network in
  `apps/ui/src/theme/network-themes.ts`.

## Goals

- Introduce a **brand** dimension orthogonal to network. A network folder stays
  the standard, brand-agnostic default; brands are opt-in overrides.
- Brand selected at **runtime**, parallel to network — one build serves all
  network×brand combinations; the deployment picks via injected config.
- No brand id hardcoded in component logic. Logo shape / favicon type / copy come
  from config.
- Default (no brand / `standard`) renders the agnostic dots.
- Restore the shared networks' standard artwork; isolate UPSDM and OneTAC as
  brands.

## Non-goals

- No change to network selection itself, `SERVED_DOMAINS`, or
  `VITE_SERVED_BINDINGS` multi-tenant routing — brand is orthogonal.
- No move of *all* copy out of `network-themes.ts` — brand overrides only where
  needed; network-level copy stays as the default.
- No new build-per-brand images.

## Key decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Brand selection | **Runtime, parallel to network** | Matches the existing `window.__DPG_UI_CONFIG__` / `?network=` model; one image serves all brands. |
| Brand config model | **Override-only + inherit** | CSS cascade (`[data-network][data-brand]` beats `[data-network]`) merges for free; brands declare only deltas. |
| Brand copy | **Brand may override copy** | `brand.json.copy` merges over network defaults; absent → network copy. |
| Tourist app | **In scope** | It is the OneTAC breakage; de-hardcode in the same pass. |
| Base orange_dot | **Restore generic from `0678589`** | Original generic "orange dots" brand.json + logos; objects retrievable. |
| Base blue_dot logos | **Restore from `0f59a26`** | Standard "blue dots AI" logos pre-UPSDM swap (branch ancestor). |

## Architecture

### 1. Runtime brand resolution (parallel to network)

Resolution chain (mirrors network): `?brand=` →
`window.__DPG_UI_CONFIG__.VITE_BRAND_NAME` → build-time `VITE_DEFAULT_BRAND` →
`'standard'`.

- `apps/ui/index.html` inline pre-React script: resolve `brand` the same way it
  resolves `network`, and set `document.documentElement.dataset.brand`.
- `apps/ui/src/theme/theme-provider.tsx`: resolve + apply `dataset.brand`
  alongside `dataset.network`, re-evaluated on `useSearchParams` change.
- `apps/ui/vite.config.ts`: inject `__DEFAULT_BRAND__` from `VITE_DEFAULT_BRAND`
  (default `'standard'`).
- `apps/ui/src/vite-env.d.ts` + `apps/ui/src/lib/api-config.ts`: add
  `VITE_DEFAULT_BRAND` (build) and `VITE_BRAND_NAME` (runtime
  `window.__DPG_UI_CONFIG__`) types. (`VITE_*` is already covered by the
  `turbo.json` wildcard.)
- `'standard'` ⇒ no `data-brand` override block matches ⇒ base network theme.

### 2. Brand config — override-only + inherit

- Brand tokens: `examples/schemas/<network>/<brand>/brand.json`, containing ONLY
  the fields that differ from the network base (`theme`/`colours`, optional
  `copy`, `logoShape`, `faviconType`, optional `logo` overrides).
- `brandThemePlugin` (`apps/ui/vite.config.ts`) additionally scans each
  `examples/schemas/<network>/<brand>/brand.json` and emits
  `:root[data-network="<net>"][data-brand="<brand>"] { … }`. Higher specificity
  than the existing `:root[data-network="<net>"]` block, so unspecified tokens
  inherit via the cascade. The base network block is unchanged.
- The Dockerfile already copies `examples/schemas/` into the build; brand
  subfolders ride along automatically.

### 3. De-hardcode per-network flags

Resolve a merged brand config (network base + active brand override) and read:
- `faviconType: 'png' | 'svg'` — replaces `NETWORKS_WITH_FAVICON_PNG`
  (`theme-provider.tsx`). Default `'svg'`.
- `logoShape: 'square' | 'wordmark'` — replaces `isSquareishMark`
  (`portal-header.tsx`). Default `'wordmark'`.

These live in the network base `brand.json` and may be overridden per brand.

### 4. Logos

Layout: `apps/ui/public/brand/<network-kebab>/<brand-slug>/<variant>.png`.
`brandLogoUrl(networkId, brandSlug, variant)` (`apps/ui/src/theme/brand-assets.ts`):
- non-standard `brandSlug` ⇒ `/brand/<net-kebab>/<brand-slug>/<file>`;
- `standard`/absent ⇒ `/brand/<net-kebab>/<file>` (today's behaviour).
- The consuming `<img>` uses `onError` to fall back to the network path when a
  brand omits a specific variant.

### 5. Brand copy override

`brand.json` gains an optional `copy` block (`tagline`, `subline`,
`portalLabel`, `title`, …). `resolveTheme`/theme-provider merges it over the
`network-themes.ts` defaults: brand value wins, absent → network default.

### 6. Tourist app

- `tourist-top-bar.tsx`: `TOURIST_NETWORK_ID` constant → runtime-resolved network
  (+ brand), same chain as the main app.
- `index.tourist.html`: hardcoded `<title>`, favicon `<link>`, and
  `data-network` → set at runtime via the shared inline resolver (network +
  brand) and `main.tourist.tsx` (drop the `|| 'OneTAC'` literal; default title
  comes from resolved config).
- OneTAC served as `orange_dot` + brand `onetac`.

## Migrations

### blue_dot
1. Restore standard "blue dots AI" logos from `0f59a26` into base
   `apps/ui/public/brand/blue-dot/` (the 5 variants present there).
2. Move the current UPSDM emblem assets (blob `26feef4` set, incl. `favicon.png`)
   into `apps/ui/public/brand/blue-dot/upsdm/`.
3. Create `examples/schemas/blue_dot/upsdm/brand.json` with overrides only:
   `logoShape: 'square'`, `faviconType: 'png'`, UPSDM `copy` (title/tagline), any
   palette delta. Base `examples/schemas/blue_dot/brand.json` stays generic blue
   dots (`logoShape: 'wordmark'`, `faviconType: 'svg'`).

### orange_dot
1. Move current OneTAC logos (incl. `favicon.png`) into
   `apps/ui/public/brand/orange-dot/onetac/`; create
   `examples/schemas/orange_dot/onetac/brand.json` (OneTAC `theme` palette,
   `logoShape: 'square'`, `faviconType: 'png'`, OneTAC `copy`).
2. Restore the generic-orange base from `0678589`: `brand.json` + the 3 logos
   (`logo.png`, `logo-light.png`, `logo-with-strapline-light.png`). Do **NOT**
   restore `network.json` (network contract stays current). Base generic orange:
   `faviconType: 'svg'` (no png favicon), `logoShape: 'wordmark'`.
3. Tourist app default points at `orange_dot` + `onetac`.

## Deployment wiring

The Helm chart's `/config.js` (which already emits `VITE_NETWORK_NAME` into
`window.__DPG_UI_CONFIG__`) must also emit `VITE_BRAND_NAME`. If the chart lives
in this repo, update its template; if it lives in a separate infra repo, the plan
flags it as a deployment follow-up (the app already falls back to
`VITE_DEFAULT_BRAND` / `'standard'`, so the app change is safe without it).

## Guardrails & docs

- Update `apps/ui/public/brand/README.md` (which today documents the manual
  `NETWORKS_WITH_FAVICON_PNG` step) to describe the brand-folder convention,
  `logoShape`/`faviconType`, and how to add a brand.
- Document `VITE_DEFAULT_BRAND` / `VITE_BRAND_NAME` in `apps/ui/.env.example`.

## Verification

- `?network=blue_dot` (no brand) → standard blue dots logos + theme.
- `?network=blue_dot&brand=upsdm` → UPSDM emblem, square mark, png favicon, UPSDM
  title; network behaviour unchanged.
- `?network=orange_dot` → generic orange dots.
- `?network=orange_dot&brand=onetac` → OneTAC.
- Tourist app with runtime config network=orange_dot brand=onetac → OneTAC; with
  a different network/brand → that brand (no hardcoded OneTAC).
- `grep` shows no remaining hardcoded `'upsdm'`/`'onetac'`/`NETWORKS_WITH_FAVICON_PNG`/`isSquareishMark` network-id literals in component logic.
- `pnpm --filter ui build` succeeds; emitted CSS contains
  `:root[data-network="blue_dot"][data-brand="upsdm"]`.
