# Network + Brand for signals-dpg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime-selected `brand` dimension orthogonal to `network`, drive all brand-specific behaviour from config (not hardcoded network ids), restore the shared networks' standard artwork, and isolate UPSDM/OneTAC as brands.

**Architecture:** A `brand` is resolved at runtime exactly like `network` (`?brand=` → `window.__DPG_UI_CONFIG__.VITE_BRAND_NAME` → build `VITE_DEFAULT_BRAND` → `'standard'`) and applied as `document.documentElement.dataset.brand`. Brand tokens live in `examples/schemas/<network>/<brand>/brand.json` (override-only); the Vite `brandThemePlugin` emits higher-specificity `:root[data-network][data-brand]` CSS (cascade merges) AND exposes a structured brand registry to the runtime so `faviconType`/`logoShape`/`copy` come from config instead of hardcoded sets. Logos live at `/brand/<network>/<brand>/`.

**Tech Stack:** React 19 + Vite, TypeScript, Tailwind v4, pnpm + Turbo. Tests: Vitest. No Keycloak.

## Global Constraints

- Brand selection is RUNTIME, parallel to network. One build serves all network×brand combos. No build-per-brand.
- Config model is OVERRIDE-ONLY + INHERIT: a brand's `brand.json` contains only deltas; unspecified theme tokens inherit the network base via CSS cascade (`:root[data-network][data-brand]` beats `:root[data-network]`).
- Default brand is `'standard'` → no `data-brand` override → base network theme (agnostic dots).
- NO brand id (`upsdm`, `onetac`) or network id may be hardcoded in component logic. `faviconType`, `logoShape`, and copy come from config.
- `SIGNALS`/network selection, `SERVED_DOMAINS`, `VITE_SERVED_BINDINGS` are untouched — brand is orthogonal.
- Restore points: standard blue-dot logos = commit `0f59a26` (branch ancestor); generic orange `brand.json` + 3 logos = commit `0678589` (NOT a branch ancestor, but objects are retrievable via `git show`). Do NOT restore orange `network.json`.
- Brand slugs: UPSDM → `upsdm`; OneTAC → `onetac`. Standard slugs stay `blue-dot`/`orange-dot`. Logo folder uses kebab network + brand slug: `/brand/blue-dot/upsdm/`.
- New config vars: `VITE_DEFAULT_BRAND` (build), `VITE_BRAND_NAME` (runtime, in `window.__DPG_UI_CONFIG__`). `VITE_*` is already covered by `turbo.json` globalEnv wildcard.
- Run all commands from repo root `/Users/srivastha/KKB/Github/Signals-DPG`. UI commands: `pnpm --filter ui <script>`. Conventional Commits; do NOT use `--no-verify`.

---

### Task 1: Brand resolver (pure) + runtime plumbing

**Files:**
- Create: `apps/ui/src/theme/resolve-brand.ts`
- Create: `apps/ui/src/theme/__tests__/resolve-brand.test.ts`
- Modify: `apps/ui/vite.config.ts` (add `__DEFAULT_BRAND__` define near `__DEFAULT_NETWORK_THEME__` at line 269; derive from `env.VITE_DEFAULT_BRAND`)
- Modify: `apps/ui/src/vite-env.d.ts` (declare `__DEFAULT_BRAND__`, `VITE_DEFAULT_BRAND`, `VITE_BRAND_NAME`)
- Modify: `apps/ui/src/lib/api-config.ts` (add `VITE_BRAND_NAME?: string` to the `window.__DPG_UI_CONFIG__` type)

**Interfaces:**
- Produces: `resolveBrand(opts: { queryParam?: string | null; runtimeConfig?: string | null; buildDefault?: string | null }): string` — returns the active brand slug, defaulting to `'standard'`. Empty/whitespace inputs are ignored in the chain order query → runtime → build → `'standard'`.
- Produces global `__DEFAULT_BRAND__: string` (Vite define).

- [ ] **Step 1: Write the failing test**

```ts
// apps/ui/src/theme/__tests__/resolve-brand.test.ts
import { describe, it, expect } from 'vitest';
import { resolveBrand } from '../resolve-brand';

describe('resolveBrand', () => {
  it('defaults to standard when nothing set', () => {
    expect(resolveBrand({})).toBe('standard');
  });
  it('query param wins over everything', () => {
    expect(resolveBrand({ queryParam: 'upsdm', runtimeConfig: 'onetac', buildDefault: 'x' })).toBe('upsdm');
  });
  it('runtime config beats build default', () => {
    expect(resolveBrand({ runtimeConfig: 'onetac', buildDefault: 'x' })).toBe('onetac');
  });
  it('build default used when no query/runtime', () => {
    expect(resolveBrand({ buildDefault: 'upsdm' })).toBe('upsdm');
  });
  it('ignores empty/whitespace values', () => {
    expect(resolveBrand({ queryParam: '  ', runtimeConfig: '', buildDefault: 'upsdm' })).toBe('upsdm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- resolve-brand`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement resolve-brand.ts**

```ts
// apps/ui/src/theme/resolve-brand.ts
/**
 * Resolves the active brand slug, parallel to network resolution.
 * Order: query param → runtime config (window.__DPG_UI_CONFIG__) →
 * build-time default → 'standard'. 'standard' means no brand override
 * (the agnostic network theme).
 */
export function resolveBrand(opts: {
  queryParam?: string | null;
  runtimeConfig?: string | null;
  buildDefault?: string | null;
}): string {
  const pick = (v?: string | null) => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  return pick(opts.queryParam) ?? pick(opts.runtimeConfig) ?? pick(opts.buildDefault) ?? 'standard';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- resolve-brand`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the Vite define + type declarations**

In `apps/ui/vite.config.ts`, immediately below the `defaultNetworkTheme` derivation (around line 211-213), add:
```ts
const defaultBrand = env.VITE_DEFAULT_BRAND?.trim() || 'standard';
```
and in the `define` block (around line 269, next to `__DEFAULT_NETWORK_THEME__`):
```ts
      __DEFAULT_BRAND__: JSON.stringify(defaultBrand),
```
In `apps/ui/src/vite-env.d.ts`, add (matching the existing `__DEFAULT_NETWORK_THEME__` global declaration style):
```ts
declare const __DEFAULT_BRAND__: string;
```
and in the `ImportMetaEnv` interface:
```ts
  readonly VITE_DEFAULT_BRAND?: string;
```
In `apps/ui/src/lib/api-config.ts`, add to the `window.__DPG_UI_CONFIG__` type (next to `VITE_NETWORK_NAME`):
```ts
  VITE_BRAND_NAME?: string;
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter ui typecheck`
Expected: passes (no errors from the new declarations).

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/theme/resolve-brand.ts apps/ui/src/theme/__tests__/resolve-brand.test.ts apps/ui/vite.config.ts apps/ui/src/vite-env.d.ts apps/ui/src/lib/api-config.ts
git commit -m "feat(ui): add runtime brand resolver + VITE_DEFAULT_BRAND/VITE_BRAND_NAME plumbing"
```

---

### Task 2: Apply `data-brand` (index.html inline script + theme-provider)

**Files:**
- Modify: `apps/ui/index.html` (inline pre-React script, ~lines 24-37 — the block that resolves network and sets `data-network`)
- Modify: `apps/ui/src/theme/theme-provider.tsx` (resolve brand alongside network, set `document.documentElement.dataset.brand`; re-evaluate on `useSearchParams`)

**Interfaces:**
- Consumes: `resolveBrand` (Task 1), `__DEFAULT_BRAND__`.
- Produces: `document.documentElement.dataset.brand` is set to the active brand on first paint and on navigation; `'standard'` ⇒ attribute set to `'standard'` (the CSS override blocks only match real brand slugs).

- [ ] **Step 1: Read both files first**

Run: `sed -n '1,60p' apps/ui/index.html` and read `apps/ui/src/theme/theme-provider.tsx` fully to see the exact network-resolution block (lines ~29-34, 105, 119-170).

- [ ] **Step 2: Mirror network resolution for brand in index.html**

In the inline `<script>` that currently resolves the network (query `?network=` → `window.__DPG_UI_CONFIG__.VITE_NETWORK_NAME` → `localStorage 'dpg-active-network'` → `__DEFAULT_NETWORK_THEME__` → `'blue_dot'`) and sets `document.documentElement.dataset.network`, add a parallel brand resolution and set `dataset.brand`:
```js
var params = new URLSearchParams(window.location.search);
var cfg = window.__DPG_UI_CONFIG__ || {};
var brand = (params.get('brand') || cfg.VITE_BRAND_NAME || (typeof __DEFAULT_BRAND__ !== 'undefined' ? __DEFAULT_BRAND__ : '') || 'standard').trim();
document.documentElement.dataset.brand = brand || 'standard';
```
(Place it right after the existing `dataset.network` assignment, reusing the existing `params`/`cfg` vars if already declared.)

- [ ] **Step 3: Mirror in theme-provider.tsx**

In `theme-provider.tsx`, where the active network is resolved and `el.dataset.network = id` is set (line ~105) and re-evaluated on `useSearchParams`, add brand resolution using `resolveBrand` and set `el.dataset.brand`:
```ts
import { resolveBrand } from './resolve-brand';
// ... inside the same effect/resolver that reads searchParams + runtime cfg:
const activeBrand = resolveBrand({
  queryParam: searchParams.get('brand'),
  runtimeConfig: (typeof window !== 'undefined' ? window.__DPG_UI_CONFIG__?.VITE_BRAND_NAME : null),
  buildDefault: typeof __DEFAULT_BRAND__ !== 'undefined' ? __DEFAULT_BRAND__ : null,
});
document.documentElement.dataset.brand = activeBrand;
```
Expose `activeBrand` from the `NetworkThemeProvider` context value (add a `brand: string` field next to the existing network/`themeId`) so later tasks (portal-header, brand-assets) can read it.

- [ ] **Step 4: Verify build + DOM wiring**

Run: `pnpm --filter ui build`
Expected: build succeeds.
Run: `grep -n "dataset.brand" apps/ui/index.html apps/ui/src/theme/theme-provider.tsx`
Expected: both set `dataset.brand`.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/index.html apps/ui/src/theme/theme-provider.tsx
git commit -m "feat(ui): resolve + apply data-brand alongside data-network"
```

---

### Task 3: brandThemePlugin scans brand subfolders → CSS + runtime registry

**Files:**
- Modify: `apps/ui/vite.config.ts` (the inline `brandThemePlugin`, ~lines 19-205)

**Interfaces:**
- Consumes: `examples/schemas/<network>/<brand>/brand.json`.
- Produces: (1) CSS blocks `:root[data-network="<net>"][data-brand="<brand>"] { … }` appended to the existing `<style data-brand-themes>`; (2) a `define`d global `__BRAND_REGISTRY__: Record<string, { faviconType?: 'png'|'svg'; logoShape?: 'square'|'wordmark'; copy?: Record<string,string>; brands: Record<string, { faviconType?: 'png'|'svg'; logoShape?: 'square'|'wordmark'; copy?: Record<string,string> }> }>` keyed by network id, carrying the non-CSS brand metadata for the runtime. Theme/colour fields drive CSS only; the registry carries `faviconType`/`logoShape`/`copy`.

- [ ] **Step 1: Read the current plugin**

Read `apps/ui/vite.config.ts` lines 19-205 to see how it reads `<network>/brand.json`, derives tokens, and builds `:root[data-network="<id>"]` blocks (line ~189).

- [ ] **Step 2: Extend the folder scan to brand subfolders**

In the loop that reads each `examples/schemas/<name>/brand.json`, after emitting the base `:root[data-network="${name}"] { … }` block, also enumerate subdirectories of `examples/schemas/<name>/` that contain a `brand.json`, and for each `<brand>` emit:
```ts
blocks.push(`:root[data-network="${name}"][data-brand="${brand}"] {\n${brandLines}\n}`);
```
where `brandLines` is derived from the brand's `brand.json` using the SAME token-derivation logic already applied to the network base (reuse the existing helper; do not duplicate it). Only tokens present in the brand's `brand.json` are emitted (override-only) — do not synthesize a full token set for a brand.

- [ ] **Step 3: Build and expose the brand registry**

While scanning, accumulate a registry object: for each network, capture base `{ faviconType, logoShape, copy }` from its `brand.json` (fields default to `undefined` when absent) and a `brands` map of the same shape per brand subfolder. Add to the plugin's `config()`/`define` output (or via the existing define mechanism in vite.config.ts):
```ts
      __BRAND_REGISTRY__: JSON.stringify(registry),
```
Declare the global in `apps/ui/src/vite-env.d.ts`:
```ts
declare const __BRAND_REGISTRY__: Record<string, {
  faviconType?: 'png' | 'svg';
  logoShape?: 'square' | 'wordmark';
  copy?: Record<string, string>;
  brands?: Record<string, { faviconType?: 'png' | 'svg'; logoShape?: 'square' | 'wordmark'; copy?: Record<string, string> }>;
}>;
```

- [ ] **Step 4: Verify emitted CSS + registry (after Task 7/8 create brand folders, this fully populates; for now it must at least build with zero brand folders present)**

Run: `pnpm --filter ui build && grep -ro "data-brand" apps/ui/dist | head`
Expected: build succeeds. (Brand-specific selectors appear once Tasks 7/8 add brand folders; re-run then.)

- [ ] **Step 5: Commit**

```bash
git add apps/ui/vite.config.ts apps/ui/src/vite-env.d.ts
git commit -m "feat(ui): emit per-brand CSS + brand registry from brand.json subfolders"
```

---

### Task 4: resolveBrandMeta (pure) + de-hardcode faviconType & logoShape & copy

**Files:**
- Create: `apps/ui/src/theme/brand-meta.ts`
- Create: `apps/ui/src/theme/__tests__/brand-meta.test.ts`
- Modify: `apps/ui/src/theme/theme-provider.tsx` (replace `NETWORKS_WITH_FAVICON_PNG` use at lines 42-43,59; merge brand copy over network defaults)
- Modify: `apps/ui/src/components/layout/portal-header.tsx` (replace `isSquareishMark` hardcode at lines 20-32)

**Interfaces:**
- Consumes: `__BRAND_REGISTRY__` (Task 3).
- Produces: `resolveBrandMeta(networkId: string, brandSlug: string, registry?: BrandRegistry): { faviconType: 'png' | 'svg'; logoShape: 'square' | 'wordmark'; copy: Record<string, string> }`. Merge order: network base then brand override (brand wins). Defaults: `faviconType: 'svg'`, `logoShape: 'wordmark'`, `copy: {}`. `brandSlug==='standard'` or unknown ⇒ network base only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ui/src/theme/__tests__/brand-meta.test.ts
import { describe, it, expect } from 'vitest';
import { resolveBrandMeta } from '../brand-meta';

const registry = {
  blue_dot: {
    faviconType: 'svg', logoShape: 'wordmark', copy: { title: 'Blue Dots' },
    brands: { upsdm: { faviconType: 'png', logoShape: 'square', copy: { title: 'UPSDM' } } },
  },
  orange_dot: { faviconType: 'svg', logoShape: 'wordmark', brands: {} },
} as const;

describe('resolveBrandMeta', () => {
  it('returns network base for standard brand', () => {
    expect(resolveBrandMeta('blue_dot', 'standard', registry as any)).toEqual({
      faviconType: 'svg', logoShape: 'wordmark', copy: { title: 'Blue Dots' },
    });
  });
  it('merges brand override over network base', () => {
    expect(resolveBrandMeta('blue_dot', 'upsdm', registry as any)).toEqual({
      faviconType: 'png', logoShape: 'square', copy: { title: 'UPSDM' },
    });
  });
  it('falls back to defaults for unknown network', () => {
    expect(resolveBrandMeta('ghost_dot', 'x', registry as any)).toEqual({
      faviconType: 'svg', logoShape: 'wordmark', copy: {},
    });
  });
  it('unknown brand uses network base', () => {
    expect(resolveBrandMeta('orange_dot', 'nope', registry as any)).toEqual({
      faviconType: 'svg', logoShape: 'wordmark', copy: {},
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- brand-meta`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement brand-meta.ts**

```ts
// apps/ui/src/theme/brand-meta.ts
/**
 * Resolves non-CSS brand metadata (favicon type, logo shape, copy) by
 * merging a network's base brand.json fields with the active brand's
 * override. Brand wins; absent fields fall back to network base, then
 * to safe defaults. Sourced from the build-time __BRAND_REGISTRY__.
 */
export type FaviconType = 'png' | 'svg';
export type LogoShape = 'square' | 'wordmark';

export interface BrandMeta {
  faviconType: FaviconType;
  logoShape: LogoShape;
  copy: Record<string, string>;
}

type Entry = {
  faviconType?: FaviconType;
  logoShape?: LogoShape;
  copy?: Record<string, string>;
  brands?: Record<string, { faviconType?: FaviconType; logoShape?: LogoShape; copy?: Record<string, string> }>;
};
export type BrandRegistry = Record<string, Entry>;

export function resolveBrandMeta(
  networkId: string,
  brandSlug: string,
  registry: BrandRegistry = typeof __BRAND_REGISTRY__ !== 'undefined' ? __BRAND_REGISTRY__ : {},
): BrandMeta {
  const net = registry[networkId];
  const brand = net?.brands?.[brandSlug];
  return {
    faviconType: brand?.faviconType ?? net?.faviconType ?? 'svg',
    logoShape: brand?.logoShape ?? net?.logoShape ?? 'wordmark',
    copy: { ...(net?.copy ?? {}), ...(brand?.copy ?? {}) },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- brand-meta`
Expected: PASS (4 tests).

- [ ] **Step 5: Replace the favicon hardcode in theme-provider.tsx**

Delete the comment + set at lines 42-43:
```ts
// square marks (orange_dot OneTAC, blue_dot UPSDM emblem) ship a real favicon.
const NETWORKS_WITH_FAVICON_PNG = new Set(['orange_dot', 'blue_dot']);
```
At the favicon logic (line ~59 `if (NETWORKS_WITH_FAVICON_PNG.has(id))`), replace the condition with the resolved meta for the active network+brand:
```ts
import { resolveBrandMeta } from './brand-meta';
// where `id` is the active network and `activeBrand` is from Task 2:
const meta = resolveBrandMeta(id, activeBrand);
if (meta.faviconType === 'png') {
  // ...existing png-favicon branch...
}
```
Also merge `meta.copy` over the `network-themes.ts` resolved copy (document title, tagline) so brand copy wins when present.

- [ ] **Step 6: Replace the logo-shape hardcode in portal-header.tsx**

Replace lines 20-25 (`isSquareishMark = themeId === 'orange_dot' || themeId === 'blue_dot'`) with config-driven shape. Read the active network + brand from the theme context (Task 2 exposed `brand`), then:
```ts
import { resolveBrandMeta } from '../../theme/brand-meta';
const isSquareishMark = resolveBrandMeta(themeId, brand).logoShape === 'square';
```
(Keep the existing sizing branches at lines 29-32 unchanged — they now key off the config-derived `isSquareishMark`.)

- [ ] **Step 7: Verify**

Run: `pnpm --filter ui typecheck && pnpm --filter ui test -- brand-meta`
Run: `grep -n "NETWORKS_WITH_FAVICON_PNG\|themeId === 'orange_dot'\|themeId === 'blue_dot'" apps/ui/src/theme/theme-provider.tsx apps/ui/src/components/layout/portal-header.tsx`
Expected: typecheck passes, tests pass, grep returns NOTHING (hardcodes gone).

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/theme/brand-meta.ts apps/ui/src/theme/__tests__/brand-meta.test.ts apps/ui/src/theme/theme-provider.tsx apps/ui/src/components/layout/portal-header.tsx
git commit -m "feat(ui): drive favicon type, logo shape, and copy from brand config (de-hardcode network ids)"
```

---

### Task 5: Brand-aware logo URLs + onError fallback

**Files:**
- Modify: `apps/ui/src/theme/brand-assets.ts`
- Modify: `apps/ui/src/theme/__tests__/brand-assets.test.ts` (create if absent)
- Modify: callers — `apps/ui/src/components/layout/portal-header.tsx`, `apps/ui/src/components/.../brand-hero.tsx` (the BrandHero/auth-shell logo), and any other `brandLogoUrl(` caller (grep to find all).

**Interfaces:**
- Produces: `brandLogoUrl(networkId, variant?, brandSlug?)` — when `brandSlug` is a real brand (not `'standard'`/empty), returns `/brand/<net-kebab>/<brand-slug>/<file>`; otherwise `/brand/<net-kebab>/<file>` (today's behaviour). Returns `null` for empty `networkId`.
- Produces: `networkLogoUrl(networkId, variant?)` — the network-level path, for use as an `<img onError>` fallback.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ui/src/theme/__tests__/brand-assets.test.ts
import { describe, it, expect } from 'vitest';
import { brandLogoUrl, networkLogoUrl } from '../brand-assets';

describe('brandLogoUrl', () => {
  it('network path when no brand', () => {
    expect(brandLogoUrl('blue_dot')).toBe('/brand/blue-dot/logo.png');
  });
  it('network path for standard brand', () => {
    expect(brandLogoUrl('blue_dot', 'default', 'standard')).toBe('/brand/blue-dot/logo.png');
  });
  it('brand path for real brand', () => {
    expect(brandLogoUrl('blue_dot', 'default', 'upsdm')).toBe('/brand/blue-dot/upsdm/logo.png');
  });
  it('brand path honours variant', () => {
    expect(brandLogoUrl('blue_dot', 'light', 'upsdm')).toBe('/brand/blue-dot/upsdm/logo-light.png');
  });
  it('null for empty network', () => {
    expect(brandLogoUrl('')).toBeNull();
  });
  it('networkLogoUrl returns network path', () => {
    expect(networkLogoUrl('blue_dot', 'light')).toBe('/brand/blue-dot/logo-light.png');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- brand-assets`
Expected: FAIL (`networkLogoUrl` undefined; brandSlug arg unsupported).

- [ ] **Step 3: Update brand-assets.ts**

Replace the `brandLogoUrl` export with a brand-aware version and add `networkLogoUrl` (keep `VARIANT_FILE`, `kebabFromNetworkId`, `BrandLogoVariant` as-is):
```ts
export function networkLogoUrl(
  networkId: string | null | undefined,
  variant: BrandLogoVariant = 'default',
): string | null {
  if (!networkId) return null;
  return `/brand/${kebabFromNetworkId(networkId)}/${VARIANT_FILE[variant]}`;
}

export function brandLogoUrl(
  networkId: string | null | undefined,
  variant: BrandLogoVariant = 'default',
  brandSlug?: string | null,
): string | null {
  if (!networkId) return null;
  const slug = (brandSlug ?? '').trim();
  if (slug && slug !== 'standard') {
    return `/brand/${kebabFromNetworkId(networkId)}/${slug}/${VARIANT_FILE[variant]}`;
  }
  return networkLogoUrl(networkId, variant);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- brand-assets`
Expected: PASS (6 tests).

- [ ] **Step 5: Update callers to pass active brand + onError fallback**

Run `grep -rn "brandLogoUrl(" apps/ui/src` to find every caller. For each, pass the active `brand` (from the theme context, Task 2) as the third arg, and on the `<img>` add an `onError` that swaps to the network fallback once:
```tsx
<img
  src={brandLogoUrl(networkId, variant, brand) ?? undefined}
  onError={(e) => {
    const fb = networkLogoUrl(networkId, variant);
    if (fb && e.currentTarget.src.endsWith(fb) === false) e.currentTarget.src = fb;
  }}
  ...
/>
```

- [ ] **Step 6: Verify**

Run: `pnpm --filter ui typecheck && pnpm --filter ui test -- brand-assets`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/theme/brand-assets.ts apps/ui/src/theme/__tests__/brand-assets.test.ts apps/ui/src/components/layout/portal-header.tsx apps/ui/src
git commit -m "feat(ui): brand-aware logo URLs with network-path onError fallback"
```

---

### Task 6: De-hardcode the tourist app

**Files:**
- Modify: `apps/ui/src/tourist/tourist-top-bar.tsx` (line 13 `TOURIST_NETWORK_ID`, line 33 logo)
- Modify: `apps/ui/index.tourist.html` (lines 6-11: `<title>`, favicon `<link>`, `data-network`)
- Modify: `apps/ui/src/main.tourist.tsx` (line 14 title fallback `|| 'OneTAC'`)
- Modify: `apps/ui/src/tourist/tourist-app.tsx` (already partially softened at line 20 — make brand-aware too)

**Interfaces:**
- Consumes: `resolveBrand`, `brandLogoUrl`, `networkLogoUrl`, `resolveBrandMeta`.
- Produces: the tourist app resolves network + brand at runtime; no hardcoded `'orange_dot'`/`'OneTAC'` literals remain as the only source.

- [ ] **Step 1: Read the four files**

Read `tourist-top-bar.tsx`, `index.tourist.html`, `main.tourist.tsx`, `tourist-app.tsx` to see how the tourist network is currently derived (`tourist-app.tsx:20` uses `import.meta.env.VITE_NETWORK_ID`).

- [ ] **Step 2: index.tourist.html — runtime network+brand**

Replace the hardcoded inline values: set `data-network` and `data-brand` from the same resolution chain as `index.html` (query → `window.__DPG_UI_CONFIG__` → build default → fallback). For the tourist app the network fallback stays `'orange_dot'` (its default deployment) but is now overridable; the favicon `<link>` href is set by JS from the resolved network+brand + `resolveBrandMeta().faviconType`, not a literal `/brand/orange-dot/favicon.png`; remove the literal `<title>OneTAC</title>` (title set in main.tourist.tsx).

- [ ] **Step 3: main.tourist.tsx — drop the OneTAC literal**

Replace line 14:
```ts
document.title = getRuntimeEnv('VITE_TOURIST_APP_TITLE')?.trim() || 'OneTAC';
```
with a title sourced from resolved brand copy, falling back to runtime env then a neutral default:
```ts
const net = /* resolved tourist network */;
const brand = /* resolved brand */;
const meta = resolveBrandMeta(net, brand);
document.title = meta.copy.title || getRuntimeEnv('VITE_TOURIST_APP_TITLE')?.trim() || 'Signals';
```

- [ ] **Step 4: tourist-top-bar.tsx — runtime network + brand logo**

Replace the `const TOURIST_NETWORK_ID = 'orange_dot'` constant (line 13) with the resolved tourist network (read from the tourist app context / runtime config, same source `tourist-app.tsx` uses), and update line 33 to pass the active brand:
```ts
const logoSrc = brandLogoUrl(touristNetworkId, resolved === 'dark' ? 'light' : 'default', touristBrand);
```
with an `onError` fallback to `networkLogoUrl(touristNetworkId, …)`.

- [ ] **Step 5: Verify no hardcoded OneTAC/orange remain as sole source**

Run: `grep -rn "OneTAC\|TOURIST_NETWORK_ID = 'orange_dot'\|/brand/orange-dot/favicon" apps/ui/src apps/ui/index.tourist.html`
Expected: no hardcoded `OneTAC` literal as a default in code; the `orange_dot` fallback may remain ONLY as an overridable default (documented), not as a hardcoded constant used directly for assets.
Run: `pnpm --filter ui build`
Expected: tourist build succeeds (`UI_VARIANT` paths intact).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/tourist apps/ui/index.tourist.html apps/ui/src/main.tourist.tsx
git commit -m "feat(ui): de-hardcode tourist app network/brand (runtime-resolved, OneTAC -> onetac brand)"
```

---

### Task 7: blue_dot migration — restore standard logos, extract UPSDM brand

**Files:**
- Modify: `apps/ui/public/brand/blue-dot/*.png` (restore from `0f59a26`)
- Create: `apps/ui/public/brand/blue-dot/upsdm/*` (current UPSDM emblem assets)
- Create: `examples/schemas/blue_dot/upsdm/brand.json`
- Modify: `examples/schemas/blue_dot/brand.json` (ensure base carries `faviconType: 'svg'`, `logoShape: 'wordmark'` if those fields are read by the registry)

**Interfaces:**
- Produces: base `blue_dot` = standard blue dots; brand `blue_dot/upsdm` = UPSDM emblem.

> Capture-before-restore: move the current UPSDM assets into the `upsdm/` slug BEFORE restoring the base.

- [ ] **Step 1: Capture current UPSDM emblem assets into the upsdm slug**

```bash
mkdir -p apps/ui/public/brand/blue-dot/upsdm
cp -a apps/ui/public/brand/blue-dot/*.png apps/ui/public/brand/blue-dot/upsdm/
```
(This copies the current UPSDM emblem incl. `favicon.png` into the brand slug.)

- [ ] **Step 2: Restore standard blue-dot logos from history into the base**

```bash
git checkout 0f59a26 -- apps/ui/public/brand/blue-dot/logo.png apps/ui/public/brand/blue-dot/logo-light.png apps/ui/public/brand/blue-dot/logo-with-strapline.png apps/ui/public/brand/blue-dot/logo-with-strapline-light.png apps/ui/public/brand/blue-dot/logo-on-brand.png
```
Then remove the base `favicon.png` (UPSDM-specific; base uses svg favicon): `git rm --cached apps/ui/public/brand/blue-dot/favicon.png 2>/dev/null; rm -f apps/ui/public/brand/blue-dot/favicon.png` (the favicon now lives only under `upsdm/`).

- [ ] **Step 3: Verify base logos match the standard restore point**

Run: `git hash-object apps/ui/public/brand/blue-dot/logo.png` → expect `9bb83d0709ef52d7b9f90ad556a7921e83f70697` (standard). And `git hash-object apps/ui/public/brand/blue-dot/upsdm/logo.png` → expect `26feef41d0a1e3cd7f99c7a6a3640bc43593a66a` (UPSDM emblem).

- [ ] **Step 4: Create the UPSDM brand override**

`examples/schemas/blue_dot/upsdm/brand.json` (override-only — include the UPSDM palette `theme`/`colours` deltas if the emblem needs a different accent; at minimum the meta + copy):
```json
{
  "logoShape": "square",
  "faviconType": "png",
  "copy": {
    "title": "UPSDM",
    "tagline": "सबको हुनर, सबको काम",
    "portalLabel": "UPSDM Portal"
  }
}
```
(Adjust copy strings to the approved UPSDM wording; if unknown, set `title: "UPSDM"` and leave others out — absent copy falls back to the blue_dot network defaults.)

- [ ] **Step 5: Ensure base blue_dot brand.json carries default meta**

In `examples/schemas/blue_dot/brand.json`, add (if not present) top-level `"logoShape": "wordmark"` and `"faviconType": "svg"` so the registry base is explicit. Do not change its colours/theme.

- [ ] **Step 6: Verify build emits the brand selector + registry**

Run: `pnpm --filter ui build && grep -ro 'data-network="blue_dot"\]\[data-brand="upsdm"' apps/ui/dist | head`
Expected: build succeeds and the UPSDM brand selector is present in the emitted CSS.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/public/brand/blue-dot examples/schemas/blue_dot
git commit -m "feat(blue_dot): restore standard logos to base; extract UPSDM into blue_dot/upsdm brand"
```

---

### Task 8: orange_dot migration — extract OneTAC, restore generic base

**Files:**
- Create: `apps/ui/public/brand/orange-dot/onetac/*` (current OneTAC assets)
- Modify: `apps/ui/public/brand/orange-dot/*.png` (restore generic from `0678589`)
- Create: `examples/schemas/orange_dot/onetac/brand.json`
- Modify: `examples/schemas/orange_dot/brand.json` (restore generic from `0678589`)

**Interfaces:**
- Produces: base `orange_dot` = generic orange dots; brand `orange_dot/onetac` = OneTAC.

> Capture-before-restore: move OneTAC into the `onetac/` slug BEFORE restoring the base. The generic restore source `0678589` is NOT a branch ancestor but its objects are retrievable via `git show`/`git checkout <sha> -- <path>`.

- [ ] **Step 1: Capture current OneTAC assets into the onetac slug**

```bash
mkdir -p apps/ui/public/brand/orange-dot/onetac
cp -a apps/ui/public/brand/orange-dot/logo.png apps/ui/public/brand/orange-dot/logo-light.png apps/ui/public/brand/orange-dot/logo-with-strapline-light.png apps/ui/public/brand/orange-dot/onetac/
cp -a apps/ui/public/brand/orange-dot/favicon.png apps/ui/public/brand/orange-dot/onetac/ 2>/dev/null || true
```

- [ ] **Step 2: Capture current OneTAC brand.json into the onetac override**

```bash
cp -a examples/schemas/orange_dot/brand.json examples/schemas/orange_dot/onetac/brand.json
```
Then edit `examples/schemas/orange_dot/onetac/brand.json` to add `"logoShape": "square"`, `"faviconType": "png"`, and an OneTAC `copy` block (`title: "OneTAC"`). Keep the OneTAC `theme`/sienna palette.

- [ ] **Step 3: Restore generic-orange base brand.json + logos from history**

```bash
git checkout 0678589 -- examples/schemas/orange_dot/brand.json
git checkout 0678589 -- apps/ui/public/brand/orange-dot/logo.png apps/ui/public/brand/orange-dot/logo-light.png apps/ui/public/brand/orange-dot/logo-with-strapline-light.png
```
Then remove the OneTAC-only base favicon: `rm -f apps/ui/public/brand/orange-dot/favicon.png` (it now lives only under `onetac/`). Do NOT restore `network.json`.

- [ ] **Step 4: Verify base/brand identities**

Run: `git hash-object apps/ui/public/brand/orange-dot/logo.png` → expect `4f7ecb1e46550a6b13098b0ef4eb140516680874` (generic). `git hash-object apps/ui/public/brand/orange-dot/onetac/logo.png` → expect `1fd594dd0a26d93d3d181bbdb0eadc0ea71f06ce` (OneTAC). `grep -m1 name examples/schemas/orange_dot/brand.json` → generic orange, NOT OneTAC.

- [ ] **Step 5: Ensure base orange_dot brand.json default meta**

Add `"logoShape": "wordmark"`, `"faviconType": "svg"` to base `examples/schemas/orange_dot/brand.json`.

- [ ] **Step 6: Build + verify selectors**

Run: `pnpm --filter ui build && grep -ro 'data-brand="onetac"' apps/ui/dist | head`
Expected: build succeeds; onetac brand selector present.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/public/brand/orange-dot examples/schemas/orange_dot
git commit -m "feat(orange_dot): extract OneTAC into orange_dot/onetac; restore generic orange base"
```

---

### Task 9: Docs + env example + Helm runtime config

**Files:**
- Modify: `apps/ui/public/brand/README.md`
- Modify: `apps/ui/.env.example`
- Modify: Helm chart `/config.js` template (locate; may be under `helm/`, `deploy/`, `charts/`, or an external infra repo)

**Interfaces:**
- Produces: documentation + deployment wiring for the brand dimension.

- [ ] **Step 1: Locate the Helm config.js template**

Run: `grep -rl "VITE_NETWORK_NAME" --include="*.js" --include="*.yaml" --include="*.tpl" --include="*.html" . | grep -vi node_modules`
If a chart template that writes `window.__DPG_UI_CONFIG__` is found in-repo, add a `VITE_BRAND_NAME` line beside `VITE_NETWORK_NAME` (driven by a chart value, default empty). If NOT found in-repo, record in the report that the chart lives elsewhere and the deployment team must add `VITE_BRAND_NAME` to `/config.js` (the app already falls back to `VITE_DEFAULT_BRAND`/`'standard'`, so the app is safe without it).

- [ ] **Step 2: Update brand README**

Rewrite `apps/ui/public/brand/README.md` to document: the `<network-kebab>/<brand-slug>/` folder convention, the override-only `examples/schemas/<network>/<brand>/brand.json` model + CSS cascade, the `logoShape`/`faviconType`/`copy` fields (replacing the old manual `NETWORKS_WITH_FAVICON_PNG` instruction), the runtime selection chain (`?brand=` → `VITE_BRAND_NAME` → `VITE_DEFAULT_BRAND` → `standard`), and how to add a brand. Mention current brands `blue_dot/upsdm`, `orange_dot/onetac`.

- [ ] **Step 3: Document env vars**

Add to `apps/ui/.env.example`:
```
# Build-time default brand skin (runtime overridable via ?brand= or VITE_BRAND_NAME).
# 'standard' (or unset) = the network's brand-agnostic theme.
VITE_DEFAULT_BRAND=standard
```

- [ ] **Step 4: Verify**

Run: `grep -c "VITE_DEFAULT_BRAND" apps/ui/.env.example` (>=1) and `grep -ci "brand" apps/ui/public/brand/README.md` (>=1).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/public/brand/README.md apps/ui/.env.example
# plus the chart template if found in-repo
git commit -m "docs(ui): document network/brand convention; add VITE_DEFAULT_BRAND + chart VITE_BRAND_NAME"
```

---

## Self-Review

**Spec coverage:**
- Runtime brand resolution parallel to network → Tasks 1, 2. ✓
- Override-only + inherit (CSS cascade) → Task 3. ✓
- De-hardcode faviconType/logoShape → Task 4. ✓
- Brand-aware logos + fallback → Task 5. ✓
- Brand copy override → Tasks 3 (registry) + 4 (merge). ✓
- Tourist app de-hardcode → Task 6. ✓
- blue_dot migration (restore 0f59a26, UPSDM brand) → Task 7. ✓
- orange_dot migration (OneTAC brand, restore generic 0678589, not network.json) → Task 8. ✓
- Deployment wiring (Helm VITE_BRAND_NAME) + docs + env → Task 9. ✓

**Placeholder scan:** Pure functions (resolve-brand, brand-meta, brand-assets) have complete code + tests. Edits to large existing files (theme-provider, vite.config plugin, index.html, tourist) instruct "read first" then give the exact new snippet — appropriate for an existing-codebase refactor where full-file reproduction would be error-prone. No TBD/TODO.

**Type/name consistency:** `resolveBrand`, `resolveBrandMeta`, `brandLogoUrl(networkId, variant, brandSlug)`, `networkLogoUrl`, `__DEFAULT_BRAND__`, `__BRAND_REGISTRY__`, `VITE_DEFAULT_BRAND`, `VITE_BRAND_NAME`, `data-brand`, slugs `upsdm`/`onetac`/`standard`, restore commits `0f59a26`/`0678589`, blobs `9bb83d0`/`26feef4`/`4f7ecb1`/`1fd594d` are used consistently across tasks. ✓

**Ordering dependencies:** Task 1→2 (resolver before apply); Task 3 before 4 (registry before consumer); Task 7/8 capture-before-restore (guarded). Tasks 7/8 also populate the brand selectors Task 3's build verification expects.
