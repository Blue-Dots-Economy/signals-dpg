# Mobile Experience — Phase 1 Execution Scope

**Date:** 2026-07-27
**Status:** Approved — ready for implementation planning
**Scope:** `apps/ui` (Signals seeker/provider portal)
**Branch:** `feat/ui-mobile-experience` (off `feature`)
**Issue:** [#338](https://github.com/Blue-Dots-Economy/signals-dpg/issues/338)

## Parent specs (the authoritative fix-level design)

This is an *execution scope* document — it records what Phase 1 ships, in what
structure, and how it is re-scoped against the current `feature` code. The
file-and-line-level fixes live in the two committed design docs on
`spec/ui-mobile-experience`:

- `2026-07-27-ui-mobile-experience-design.md` — the engineering spec (W1–W6).
- `2026-07-27-ui-mobile-product-decisions.md` — the five product decisions (PD-1…PD-5).

Where those specs and this document disagree on *scope*, this document wins for
Phase 1 (it was reconciled against the real code); where they disagree on *how a
fix is applied*, the engineering spec wins.

## Why a separate Phase 1 scope

The engineering spec was written against the pre-#295 production build. Verifying
each workstream against the current `feature` branch surfaced one material drift
and confirmed the rest:

- **W1's headline "Blocker" is already fixed on `feature`.** `top-bar.tsx` already
  drops the search input to its own full-width line on mobile
  (`order-last w-full ... sm:flex-1`), and `language-switcher.tsx` already accepts
  the `compact` prop. So W1 shrinks to the residual items.
- **W2, W3, W4, W5.2 targets are all still present** in `feature` — verified by
  grep: 16 files still carry raw `vh` units; 7+ dialogs are still Dialog-only;
  `button.tsx` still ships `xs`/`icon-xs` sub-44px variants; the unconditional
  `grid-cols-2` / `grid-cols-4` grids are unchanged.

## Sequencing (the agreed plan)

1. **Now:** implement the unblocked workstreams (this document).
2. **In parallel:** PR #295 (`feat/ui-caching-strategy`) merges into `feature`.
3. **Then:** the blocked items — W5.4a (profile-form landmarks) and W6 (#295's new
   surfaces) — rebase onto `feature` and ship separately.
4. **Then:** the map/list server-side search/relevance separation (follow-up design),
   which rebases onto the corrected mobile markup.

## Phase 1 scope — the workstreams that ship

| WS | Ships | Re-scope vs engineering spec |
| :- | :- | :- |
| **W1** | 640–767px band verification; W1.2 search min-width floor *if still needed after the feature fix*; W1.4 `aria-label="Search listings"` on the search input | W1.1 (collapse) already done on `feature` → skip. **W1.3 (move controls to overflow) deferred — depends on PD-1.** |
| **W2** | `vh` → `dvh` on all modal/drawer `max-h`; `min-h-screen`/`h-screen` → `svh`; CI grep rejecting new `vh` in `apps/ui/src` | Full scope. Highest severity-per-effort — a `vh` modal can put the consent-modal accept button below the fold. |
| **W3** | Extract one shared `ResponsiveDialog` (Dialog↔Drawer swap, from the working `action-modal.tsx` pattern); migrate the desktop-only dialogs and the filters popover onto it | Full scope. **Excludes `MarkerDetailPopup`** (added by #295 → W6). |
| **W4** | Fix sub-44px at the **design-system variant level** (transparent expanded hit-area; visual size and desktop density unchanged); filter chips, filters close-button, and the ≥12px legibility floor | Full scope. **Excludes audit P3** (map popup actions → W6, #295 replaces that popup). |
| **W5** | W5.1 My-Actions clipped controls row; W5.2 `grid-cols-1 sm:grid-cols-2` (schema-form) + responsive `brand-hero` grid; W5.3 `px-4 sm:px-6`; W5.4b `<nav aria-label="Primary">`; W5.4c skip link | **W5.4a (profile-form landmarks) excluded — blocked on #295** (rewrites 110+/109- of that file). |

## PR structure

- **One branch**, `feat/ui-mobile-experience`, off `feature`.
- **One draft PR** into `feature` (user marks ready).
- **One commit per workstream** (W1, W2, W3, W4, W5) so regressions stay isolable
  within the single review, and the PR can be reviewed workstream-by-workstream.
- Within a workstream, shared primitives land first: W3 extracts `ResponsiveDialog`
  before migrating consumers; W4 sets the variant policy before touching call sites.
  Both are refactors of existing working code.

## Build order

Severity-first: **W2 → W1 → W3 → W4 → W5.**

## Testing

- Viewport-parameterised vitest render tests at **320 / 390 / 768 / 1280** per
  workstream, using the already-wired `vitest` + `@testing-library/react` +
  `happy-dom`/`jsdom`. No new tooling.
- Three shared helpers per the engineering spec: one hit-area assertion (W4), one
  `vh`-unit grep (W2), one Dialog↔Drawer helper (W3).
- Run with `pnpm --filter ui test`.
- Manual QA widths: 390×844 (primary), 320×568 (tight), 390×640 short pass (the W2
  below-the-fold modal case), 640–767 band (W1 top bar only). Real-device pass for
  W2/W3/W4 is the gold standard — DevTools "Responsive" does not simulate the
  collapsing mobile URL bar that triggers the `vh` bug.

## Explicitly out of Phase 1

- **W5.4a** (profile-form landmarks) — blocked on #295.
- **W6** (mobile treatment of #295's new surfaces: count pill, map empty state,
  federation banners, `MarkerDetailPopup`) — surfaces do not exist on `feature` yet.
- **W1.3** (header overflow menu) — needs product decision PD-1.
- **PD-5 / audit S1** (brand colour contrast across six network palettes) — a
  product/brand sign-off item, not engineering scope. Flag to product early: it is
  the only hard blocker in #338 and has no safe default.
- Map/list server-side search, relevance, and indexing (separate follow-up design).

## Open dependencies to raise with product (do not block Phase 1)

- **PD-1** — ranked list of which controls stay in the phone header (unblocks W1.3).
- **PD-5** — brand contrast route (A: darken `--primary`; B: flip foreground) and
  named sign-off, including white-label owners (`upsdm`, `onetac`).
