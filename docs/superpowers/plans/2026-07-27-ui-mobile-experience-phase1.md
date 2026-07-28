# Mobile Experience Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the unblocked responsive work in `apps/ui` so the Signals portal is phone-usable — viewport-safe modals, mobile bottom-sheets, 44px touch targets, and responsive layouts — without a separate mobile build.

**Architecture:** Responsive-first. Tailwind breakpoints do layout; `useIsMobile()` (768px) swaps component *shape* only where the interaction pattern differs (centred `Dialog` → bottom `Drawer`, `Popover` → sheet). One codebase, one build. Fixes are applied at the design-system level (shared `ResponsiveDialog`, button-variant hit-area policy) so ~100 call sites stay untouched.

**Tech Stack:** React 19, Vite, Tailwind v4, `class-variance-authority`, `radix-ui` (Dialog), `vaul` (Drawer), `vitest` + `@testing-library/react` + `happy-dom`.

## Global Constraints

- **Files are snake_case**; React components PascalCase; Zod schemas PascalCase.
- **No new tooling** — `vitest`/`happy-dom`/`@testing-library/react` are already wired. Run UI tests with `pnpm --filter ui test`.
- **No `// TODO` comments** — open an issue instead.
- **ESM only, strict TS, no `any`.** Use `import type` for type-only imports.
- **One commit per Task (= per workstream).** Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** `feat/ui-mobile-experience` (already created off `feature`). Do **not** commit to `feature`.
- **Breakpoint policy:** Tailwind breakpoints for layout; `useIsMobile()` (768px) only for component swaps. Tested widths: 320 / 390 / 768 / 1280; W1 additionally verifies the 640–767 band.
- **Viewport units:** modal/drawer `max-h` uses `dvh`; page containers use `svh`. Never bare `vh`.
- **Do not touch** files owned by PR #295 or the follow-up design: `pages/home-page.tsx`, `pages/profile-form-page.tsx`, and (for *data* changes) `components/map/map-filters-panel.tsx`. This plan changes only that panel's **presentation**, per the phase-1 scope doc.
- Build order is severity-first: **Task 1 (W2) → Task 2 (W1) → Task 3 (W3) → Task 4 (W4) → Task 5 (W5).**

---

## File Structure

**Created:**
- `apps/ui/src/components/ui/responsive-dialog.tsx` — the shared Dialog↔Drawer swap (Task 3).
- `apps/ui/src/components/ui/__tests__/responsive-dialog.test.tsx` — Task 3 test.
- `apps/ui/src/__tests__/no-raw-vh-units.test.ts` — repo-wide `vh`-guard (Task 1).
- `apps/ui/src/components/ui/__tests__/button-hit-area.test.tsx` — coarse-pointer hit-area (Task 4).
- `apps/ui/src/components/layout/__tests__/top-bar.test.tsx` — search a11y + band (Task 2), if not already present.

**Modified (by task):**
- Task 1 (W2): `consent/consent-modal.tsx`, `match-score/match-score-modal.tsx`, `actions/action-modal.tsx`, `actions/action-status-updater.tsx`, `actions/guardian-otp-dialog.tsx`, `wallet/wallet-import-modal.tsx`, `wallet/providers/dhiway-wallet-provider.tsx`, `cards/item-card.tsx`, `map/map-container.tsx`, `map/map-filters-panel.tsx`, `ui/drawer.tsx`, `layout/auth-shell.tsx`, `pages/my-actions-page.tsx`, `pages/profile-form-page.tsx`, `pages/legal/privacy-page.tsx`, `pages/legal/terms-page.tsx` — `vh` → `dvh`/`svh`.
- Task 2 (W1): `layout/top-bar.tsx`.
- Task 3 (W3): the 7 desktop-only dialogs + `map/map-filters-panel.tsx` (popover→sheet), consuming the new `ResponsiveDialog`.
- Task 4 (W4): `ui/button.tsx`, `map/map-filters-panel.tsx`, `actions/action-list.tsx`.
- Task 5 (W5): `forms/schema-form.tsx`, `layout/brand-hero.tsx`, `pages/my-actions-page.tsx`, `components/actions/action-list.tsx`, `layout/sidebar.tsx`, `layout/page-shell.tsx`.

> Note `profile-form-page.tsx` and `my-actions-page.tsx` appear in Task 1 for their **page-level** `min-h-screen` → `svh` swap only (mechanical, not the #295-conflicting landmark work). `map-filters-panel.tsx` appears in Tasks 1/3/4 for `vh`, popover→sheet, and touch-target/legibility respectively — all presentation, no data plumbing.

---

## Task 1: W2 — Viewport units (`vh` → `dvh`/`svh`)

**Files:**
- Create: `apps/ui/src/__tests__/no-raw-vh-units.test.ts`
- Modify: every file listed under Task 1 above.

**Interfaces:**
- Consumes: nothing.
- Produces: no exported symbols — a class sweep + a guard test other tasks rely on staying green.

**Transformation rule (deterministic):**
- `max-h-[Nvh]` → `max-h-[Ndvh]` (modals/drawers/cards). Applies to `90vh`, `85vh`, `80vh`, `75vh`, `56vh`.
- `max-h-[calc(Nvh…)]` → `max-h-[calc(Ndvh…)]`.
- `h-[calc(100vh-…)]` → `h-[calc(100dvh-…)]` (map container).
- `min-h-screen` → `min-h-svh`; `h-screen` → `h-svh` (page-level containers).

- [ ] **Step 1: Write the failing guard test**

Create `apps/ui/src/__tests__/no-raw-vh-units.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
// Bare vh is banned in favour of dvh/svh. dvh/svh themselves contain "vh" as a
// substring, so match a digit or "(" immediately before "vh" but NOT "d"/"s".
const BANNED = /(?<![ds])\d(?:vh)\b|min-h-screen|(?<![a-z-])h-screen\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') return [];
      return walk(p);
    }
    return p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : [];
  });
}

describe('no raw vh units in apps/ui/src', () => {
  it('uses dvh/svh instead of vh/screen for viewport sizing', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (BANNED.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Raw vh/screen units found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter ui exec vitest run src/__tests__/no-raw-vh-units.test.ts`
Expected: FAIL — offender list includes `consent-modal.tsx`, `match-score-modal.tsx`, `action-modal.tsx`, `drawer.tsx`, `my-actions-page.tsx`, etc.

- [ ] **Step 3: Apply the sweep**

Enumerate every offender, then apply the rule. Fast path:

```bash
cd apps/ui/src
# max-h-[Nvh] -> max-h-[Ndvh]  (covers calc(Nvh...) too)
grep -rlE "max-h-\[[0-9]" --include="*.tsx" . | while read f; do
  perl -0pi -e 's/max-h-\[(\d+)vh\]/max-h-[${1}dvh]/g; s/max-h-\[calc\((\d+)vh/max-h-[calc(${1}dvh/g' "$f"
done
# map container h-[calc(100vh-...)] -> dvh
perl -0pi -e 's/h-\[calc\(100vh/h-[calc(100dvh/g' components/map/map-container.tsx
# page-level min-h-screen / h-screen -> svh
grep -rlE "min-h-screen|h-screen" --include="*.tsx" . | while read f; do
  perl -0pi -e 's/min-h-screen/min-h-svh/g; s/(?<![a-z-])h-screen\b/h-svh/g' "$f"
done
```

Then manually verify the known critical sites now read:
- `components/consent/consent-modal.tsx:65` → `max-h-[90dvh]`
- `components/match-score/match-score-modal.tsx:124` → `max-h-[90dvh]`; `:131` → `max-h-[calc(90dvh-180px)]`
- `components/actions/action-modal.tsx:202,216` → `max-h-[90dvh]`
- `components/ui/drawer.tsx:60,61` → `max-h-[80dvh]`
- `pages/my-actions-page.tsx:77` → `min-h-svh`

- [ ] **Step 4: Add a render assertion on the consent modal**

Append to a new file `apps/ui/src/components/consent/__tests__/consent-modal.viewport.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ConsentModal } from '../consent-modal';

vi.mock('@/theme/theme-provider', () => ({ useNetworkTheme: () => ({ theme: { name: 'Test' } }) }));

const cfg = {
  documents: {
    privacy: { current_version: 1, versions: [{ version: 1, content: 'p' }] },
    terms: { current_version: 1, versions: [{ version: 1, content: 't' }] },
  },
} as never;

describe('ConsentModal viewport safety', () => {
  it('caps height with dvh (not vh) so the accept button stays reachable', () => {
    const { container } = render(
      <ConsentModal open mode="gate" initialTab="privacy" config={cfg} onAccept={() => {}} />,
    );
    const content = container.ownerDocument.querySelector('[data-slot="dialog-content"]');
    expect(content?.className).toMatch(/max-h-\[\d+dvh\]/);
    expect(content?.className).not.toMatch(/max-h-\[\d+vh\]/);
  });
});
```

- [ ] **Step 5: Run the full sweep + both tests**

Run: `pnpm --filter ui exec vitest run src/__tests__/no-raw-vh-units.test.ts src/components/consent/__tests__/consent-modal.viewport.test.tsx`
Expected: PASS (guard green, consent modal uses dvh).

- [ ] **Step 6: Typecheck + full UI suite**

Run: `pnpm --filter ui exec tsc -b && pnpm --filter ui test`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A apps/ui/src
git commit -m "fix(ui): use dvh/svh viewport units so modal CTAs stay on-screen (W2, #338)

Bare 100vh exceeds the visible mobile viewport, pushing primary actions
(worst case the consent accept button) below the fold. Swap modal/drawer
max-h to dvh and page containers to svh, and add a repo-wide guard test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: W1 — Top-bar residual (search a11y + band verify)

**Context:** The headline blocker (search collapsing) is already fixed on `feature` — the search input drops to its own full-width line on mobile (`top-bar.tsx` `order-last w-full sm:flex-1`), and `LanguageSwitcher` already accepts `compact`. This task closes the residual: WCAG S4 (search has no accessible name), and verifies the 640–767 band. **W1.3 (moving controls to overflow) is deferred — it depends on product decision PD-1.**

**Files:**
- Modify: `apps/ui/src/components/layout/top-bar.tsx`
- Test: `apps/ui/src/components/layout/__tests__/top-bar.test.tsx` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing exported.

- [ ] **Step 1: Write the failing a11y test**

Create/extend `apps/ui/src/components/layout/__tests__/top-bar.test.tsx`. Mock the auth context and i18n as the other layout tests do; render `TopBar` and assert the search input is queryable by accessible name:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TopBar } from '../top-bar';

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

function renderBar() {
  return render(
    <MemoryRouter>
      <TopBar
        search=""
        onSearchChange={() => {}}
        viewMode="map"
        onViewModeChange={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('TopBar search accessibility', () => {
  it('exposes the search input by an accessible name', () => {
    renderBar();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
  });
});
```

*(Match the real `TopBar` prop names — check the component's `interface` before finalising the props above; `filtersSlot` may be required.)*

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/top-bar.test.tsx`
Expected: FAIL — no element with an accessible name matching /search/.

- [ ] **Step 3: Add the accessible name**

In `apps/ui/src/components/layout/top-bar.tsx`, on the search `<Input>`, add `aria-label={t('common.search')}`:

```tsx
<Input
  type="search"
  aria-label={t('common.search')}
  placeholder={t('common.search')}
  className="pl-8"
  value={search}
  onChange={(e) => onSearchChange(e.target.value)}
/>
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/top-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Manual band check (record result in the PR)**

At 640, 700, 767px in DevTools responsive mode: confirm the control row does not clip and the search remains visible/usable. If it clips, add `compact` to `<LanguageSwitcher compact />` at `top-bar.tsx` (the prop exists) and re-check; note in the PR whether it was needed.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/layout/top-bar.tsx apps/ui/src/components/layout/__tests__/top-bar.test.tsx
git commit -m "fix(ui): add accessible name to top-bar search (W1/S4, #338)

The blocker (search collapse) is already resolved on feature; this closes
the residual WCAG label gap and verifies the 640-767px band. Header overflow
(W1.3) is deferred pending product decision PD-1.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: W3 — Mobile sheet parity (`ResponsiveDialog`)

**Files:**
- Create: `apps/ui/src/components/ui/responsive-dialog.tsx`
- Create: `apps/ui/src/components/ui/__tests__/responsive-dialog.test.tsx`
- Modify: `consent/consent-modal.tsx`, `consent/profile-consent-modal.tsx`, `support/support-dialog.tsx`, `actions/profile-card-modal.tsx`, `actions/bulk-status-dialog.tsx`, `wallet/wallet-import-modal.tsx`, `match-score/match-score-modal.tsx`, `map/map-filters-panel.tsx`

**Interfaces:**
- Produces (consumed by every migrated dialog):
  ```ts
  // responsive-dialog.tsx
  export interface ResponsiveDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
    // forwarded to DialogContent on desktop; ignored by the Drawer body
    contentClassName?: string;
    showCloseButton?: boolean;
    // guards that must survive on both shapes (consent gate blocks dismissal)
    onInteractOutside?: (e: Event) => void;
    onEscapeKeyDown?: (e: Event) => void;
  }
  export function ResponsiveDialog(props: ResponsiveDialogProps): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/components/ui/__tests__/responsive-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ResponsiveDialog } from '../responsive-dialog';

const isMobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile.value }));

describe('ResponsiveDialog', () => {
  it('renders a Dialog on desktop', () => {
    isMobile.value = false;
    const { baseElement } = render(
      <ResponsiveDialog open onOpenChange={() => {}}><p>body</p></ResponsiveDialog>,
    );
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeFalsy();
  });

  it('renders a Drawer on mobile', () => {
    isMobile.value = true;
    const { baseElement } = render(
      <ResponsiveDialog open onOpenChange={() => {}}><p>body</p></ResponsiveDialog>,
    );
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter ui exec vitest run src/components/ui/__tests__/responsive-dialog.test.tsx`
Expected: FAIL — module `../responsive-dialog` not found.

- [ ] **Step 3: Implement `ResponsiveDialog`**

Create `apps/ui/src/components/ui/responsive-dialog.tsx`, generalising the working swap in `action-modal.tsx:199-222`:

```tsx
import * as React from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Drawer, DrawerContent } from '@/components/ui/drawer';

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  contentClassName?: string;
  showCloseButton?: boolean;
  onInteractOutside?: (e: Event) => void;
  onEscapeKeyDown?: (e: Event) => void;
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  children,
  contentClassName,
  showCloseButton = true,
  onInteractOutside,
  onEscapeKeyDown,
}: ResponsiveDialogProps): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90dvh] overflow-hidden p-0">
          {children}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={showCloseButton}
        className={cn('flex max-h-[90dvh] flex-col overflow-hidden p-0', contentClassName)}
        onInteractOutside={onInteractOutside}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter ui exec vitest run src/components/ui/__tests__/responsive-dialog.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Migrate the dialogs, one at a time**

For each of the 7 dialogs, replace the `Dialog`/`DialogContent` wrapper with `ResponsiveDialog`, moving the `DialogContent` className to `contentClassName` and preserving guards. Worked example — `consent/consent-modal.tsx` (keeps the gate's dismissal guards):

```tsx
// remove the Dialog/DialogContent imports; add:
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
// ...
return (
  <ResponsiveDialog
    open={open}
    onOpenChange={handleOpenChange}
    showCloseButton={mode === 'view'}
    contentClassName="max-w-2xl gap-0"
    onInteractOutside={(e) => { if (mode === 'gate') e.preventDefault(); }}
    onEscapeKeyDown={(e) => { if (mode === 'gate') e.preventDefault(); }}
  >
    <DialogHeader className="px-6 pt-6 pb-4 shrink-0 text-left"> … </DialogHeader>
    <div className="flex flex-col flex-1 overflow-hidden px-6 pb-4 gap-4"> … </div>
  </ResponsiveDialog>
);
```

Keep `DialogHeader`/`DialogTitle`/`DialogDescription` — they render fine inside both shapes. Repeat for `profile-consent-modal`, `support-dialog`, `profile-card-modal`, `bulk-status-dialog`, `wallet-import-modal`, `match-score-modal`. For `match-score-modal.tsx` the body already uses `max-h-[calc(90dvh-180px)]` (from Task 1) — leave that.

- [ ] **Step 6: Convert the filters popover to a sheet (W3.3)**

In `components/map/map-filters-panel.tsx`, the panel opens as a `PopoverContent` (~`:296`). On mobile, render its body inside `ResponsiveDialog` (Drawer) instead of the popover; keep the desktop popover. Gate the swap on `useIsMobile()`. **Touch only the presentation wrapper — do not change any filter *state* or query logic** (that's the follow-up design's P-follow-3).

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm --filter ui exec tsc -b && pnpm --filter ui test`
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A apps/ui/src
git commit -m "feat(ui): shared ResponsiveDialog so dialogs become bottom sheets on mobile (W3, #338)

Extract the Dialog<->Drawer swap already used by action-modal into one
component and migrate 7 desktop-only dialogs plus the map filters popover
onto it. Centred desktop modals on a phone become full-width bottom sheets.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: W4 — Touch targets and density

**Files:**
- Modify: `apps/ui/src/components/ui/button.tsx`, `components/map/map-filters-panel.tsx`, `components/actions/action-list.tsx`
- Test: `apps/ui/src/components/ui/__tests__/button-hit-area.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change to `Button` — only its variant classes gain a coarse-pointer expanded hit area.

**Approach:** On coarse pointers, every interactive `Button` variant gets a ≥44px hit area via a transparent pseudo-element, so the *visual* size and desktop density are unchanged. Tailwind supports `pointer-coarse:` variants.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/components/ui/__tests__/button-hit-area.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { buttonVariants } from '../button';

describe('button hit area on touch', () => {
  it('sub-44px variants carry a coarse-pointer expansion', () => {
    for (const size of ['xs', 'icon-xs', 'sm', 'icon', 'icon-sm'] as const) {
      const cls = buttonVariants({ size });
      expect(cls, `size=${size}`).toMatch(/pointer-coarse:/);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter ui exec vitest run src/components/ui/__tests__/button-hit-area.test.tsx`
Expected: FAIL — no `pointer-coarse:` classes on the variants.

- [ ] **Step 3: Add the coarse-pointer hit area**

In `apps/ui/src/components/ui/button.tsx`, add a shared expansion to the base `cva` string (a transparent `::before` that grows the hit area to 44px only on coarse pointers, without affecting layout):

```ts
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']",
  { /* variants unchanged */ }
);
```

`size-11` = 44px. `before:` is transparent and absolutely positioned, so it enlarges the tap target without shifting layout or changing the visual button. The base already has no `position`, so `relative` is added to anchor the pseudo-element.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter ui exec vitest run src/components/ui/__tests__/button-hit-area.test.tsx`
Expected: PASS.

- [ ] **Step 5: Fix the non-Button touch/legibility sites**

These use raw `<button>`/spans, so the Button fix does not reach them:
- `components/map/map-filters-panel.tsx`: filter chips (`px-2.5 py-1 text-[11px]`, ~21px) → give a `min-h-11` hit area with `≥8px` spacing on mobile; the close button (`size-5`, 20px) → `size-11` hit area (keep the icon `size-5` inside). Raise `text-[10px]`/`text-[11px]` interactive labels to a `text-xs` (12px) floor.
- `components/actions/action-list.tsx:111` filter pills (`px-3 py-1.5 text-xs`) → add `min-h-11` on mobile; `:165` count badge is non-interactive → leave.

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm --filter ui exec tsc -b && pnpm --filter ui test`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A apps/ui/src
git commit -m "fix(ui): 44px touch targets on coarse pointers (W4, #338)

Add a transparent coarse-pointer hit-area expansion to the button variants
(visual size unchanged, ~100 call sites untouched) and fix the raw filter
chips, filter close button, and sub-12px legibility labels.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: W5 — Layout fixes and landmarks

**Files:**
- Modify: `apps/ui/src/components/forms/schema-form.tsx`, `components/layout/brand-hero.tsx`, `pages/my-actions-page.tsx`, `components/actions/action-list.tsx`, `components/layout/sidebar.tsx`, `components/layout/page-shell.tsx`
- Test: reuse render tests; add `apps/ui/src/components/forms/__tests__/schema-form.responsive.test.tsx`

**Interfaces:** none exported.

> **W5.4a (profile-form landmarks) is NOT in this task** — blocked on #295.

- [ ] **Step 1: Write the failing grid test**

Create `apps/ui/src/components/forms/__tests__/schema-form.responsive.test.tsx` asserting the two-field row layout is single-column by default and two-column only from `sm:`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('schema-form two-field rows are responsive (grid-cols-1 sm:grid-cols-2)', () => {
  const src = readFileSync(join(__dirname, '..', 'schema-form.tsx'), 'utf8');
  expect(src).not.toMatch(/className="grid grid-cols-2 gap-3"/);
  expect(src).toMatch(/grid-cols-1 sm:grid-cols-2/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter ui exec vitest run src/components/forms/__tests__/schema-form.responsive.test.tsx`
Expected: FAIL — still `grid grid-cols-2 gap-3`.

- [ ] **Step 3: Apply the layout fixes**

- `components/forms/schema-form.tsx:173`: `grid grid-cols-2 gap-3` → `grid grid-cols-1 gap-3 sm:grid-cols-2`.
- `components/layout/brand-hero.tsx:26`: `grid grid-cols-4 gap-4` → `grid grid-cols-2 gap-4 sm:grid-cols-4`.
- `pages/my-actions-page.tsx:88` and `:112`: `px-6` → `px-4 sm:px-6`.
- `components/actions/action-list.tsx:99-100`: the outer row is already `flex flex-wrap`; make the inner filter pill group (`inline-flex gap-1 …`) wrap or scroll on mobile — add `flex-wrap` (or `max-sm:overflow-x-auto`) so the `ml-auto` Refresh button is never pushed off-screen.

- [ ] **Step 4: Add the landmarks (W5.4b, W5.4c)**

- `components/layout/sidebar.tsx`: wrap the primary nav in `<nav aria-label="Primary">…</nav>` (W5.4b).
- `components/layout/page-shell.tsx`: add a visually-hidden skip link as the first focusable element (W5.4c):
  ```tsx
  <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:shadow">
    {t('a11y.skip_to_content')}
  </a>
  ```
  and ensure the main content wrapper has `id="main-content"`. Add the `a11y.skip_to_content` key to `en`/`hi`/`kn` locale files (English: "Skip to content").

- [ ] **Step 5: Run the grid test + full suite**

Run: `pnpm --filter ui exec vitest run src/components/forms/__tests__/schema-form.responsive.test.tsx && pnpm --filter ui exec tsc -b && pnpm --filter ui test`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A apps/ui/src
git commit -m "fix(ui): responsive layout + landmarks (W5, #338)

Single-column form rows and brand-hero grid on phones, responsive page
padding, a wrapping My-Actions toolbar, plus a primary <nav> landmark and a
skip link. Profile-form landmarks (W5.4a) are deferred behind #295.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (before opening the draft PR)

- [ ] `pnpm --filter ui exec tsc -b` — clean.
- [ ] `pnpm --filter ui test` — all pass.
- [ ] Manual QA at 390×844, 320×568, 390×640 (short — W2 modals), 640–767 (W1 top bar): consent/action modals reachable; See-Match-Score / profile card / filters open as bottom sheets; filter chips & close button tappable; Create-Profile fields stack; My-Actions Refresh reachable.
- [ ] Open **one draft PR** `feat/ui-mobile-experience` → `feature` with the **In Plain Terms** section, listing the 5 workstream commits and the explicit out-of-scope items (W5.4a, W6, W1.3/PD-1, PD-5).
```
