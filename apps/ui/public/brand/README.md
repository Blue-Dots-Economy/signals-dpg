# Brand assets (logos & favicons)

Per-network logo assets for `signals-ui`. The UI loads them by convention — drop
files here with the **exact names** below and they're picked up automatically; no
code change needed for an existing network shape.

How the UI consumes these (for reference):
- `src/theme/brand-assets.ts` — maps a network id to `/brand/<kebab>/<file>.png`
- `src/theme/theme-provider.tsx` — favicon selection
- `src/components/layout/portal-header.tsx` — header rendering & sizing

## Folder & naming

One folder per network, named by the **kebab-case** network id (`blue_dot` →
`blue-dot/`):

```
public/brand/<network-kebab>/
  logo.png
  logo-light.png
  logo-with-strapline.png
  logo-with-strapline-light.png
  logo-on-brand.png
  favicon.png            # square-mark networks only (see Favicon)
```

Filenames are mapped literally in `brand-assets.ts` — they must match exactly.
If a file is missing the UI falls back to a generated dot-mark / text branding.

## Variant set

| File | Variant key | Use | Background |
|------|-------------|-----|------------|
| `logo.png` | `default` | Primary colour logo (header, sidebar) | light |
| `logo-light.png` | `light` | Light/white version | **dark** theme & dark hero |
| `logo-with-strapline.png` | `withStrapline` | Adds the "Seeded by …" strapline (auth / hero / footer) | light |
| `logo-with-strapline-light.png` | `withStraplineLight` | Strapline version | dark |
| `logo-on-brand.png` | `onBrand` | Tuned for the brand-colour hero background | brand colour |

- **`logo.png` and `logo-light.png` are required** — the app has light/dark themes
  and auto-selects the light variant on dark backgrounds.
- The others are recommended; omit `onBrand` if `logo.png` already reads on the hero.

## Format

- **PNG, 32-bit RGBA, transparent background.** Transparency is required — logos
  render on white sidebars, dark headers, and coloured hero backgrounds.
- **SVG is not currently supported** (the loader maps to `.png`). Ship PNG.
- Optimise/compress: keep each file **< ~150 KB**.

## Dimensions & aspect ratio

Logos render by **height** (`object-contain`, width auto, capped by a max-width),
so the aspect ratio is preserved — just keep transparent padding **trimmed tight**
(internal whitespace makes the mark look small).

| Mark shape | Aspect | Recommended source size |
|------------|--------|-------------------------|
| Horizontal wordmark / lockup (e.g. blue, purple) | ~5 : 1 | ~900–1200 px wide (≈180–240 px tall); strapline variants ~900×240–290 |
| Compact / square mark (e.g. orange) | ~1.78 : 1 or 1 : 1 | ~512 px on the long edge |

Rendered display heights for context (provide **2–3× for retina**, i.e. ≥ ~180–240 px tall):
- Wordmark: ~28 px (sidebar) → ~48 px (auth/hero)
- Square mark: ~48 px → ~80 px

## Favicon

- **Square PNG, ≥ 180×180** (180 = Apple touch icon), ideally also **512×512**.
  Save as `favicon.png` in the network folder.
- A wide wordmark is unreadable at 16×16, so **wordmark-only networks
  auto-generate** a colour-matched dot-mark from the `--brand-cta` CSS token and
  do **not** need a `favicon.png`.
- To use a real PNG favicon, the network must be added to
  `NETWORKS_WITH_FAVICON_PNG` in `theme-provider.tsx`.

## New networks

- A **square/compact** mark needs the header to size it up: it's gated by
  `isSquareishMark` in `portal-header.tsx` (currently keyed to `orange_dot`). Add
  the new network id there, or it will render at wordmark height and look tiny.
- Accessibility: the header sets the `<img>` `alt` from the network display name,
  so the mark itself doesn't need embedded text — but make sure it's legible at
  ~28 px height.

## Source of truth

Designer assets are authored in **aggregator-dpg's `brand.json` logo set** and
copied verbatim into this folder. Add/update them there first, then sync here so
the two stay aligned.
