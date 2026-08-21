# Consent Scroll Gate — Signals-DPG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Signals' blocking consent gate require the reader to scroll through every document before the agree checkbox unlocks, matching the aggregator behaviour exactly.

**Architecture:** Gate mode stops being a tabbed viewer and becomes a single continuous guided read with a progress tracker, mirroring `ConsentGate` in aggregator-dpg. The change is contained in a new `consent-gate.tsx`; `consent-modal.tsx` delegates to it when `mode === 'gate'` and keeps its existing tabbed layout for `mode === 'view'`. **No call site changes** — all four `mode="gate"` usages pick the behaviour up automatically.

**Tech Stack:** React 18 + Vite, TypeScript, Tailwind, shadcn/Radix primitives, vaul `Drawer` on mobile via `ResponsiveDialog`, react-i18next, Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-20-consent-scroll-gate-design.md` — lives in the **aggregator-dpg** repo (`feat/636-consent-scroll-gate`). One spec covers both repos so the behaviour contract has a single home. Link it from the PR.

**Sibling plan:** `docs/superpowers/plans/2026-08-20-consent-scroll-gate-aggregator.md` — behaviour must stay identical. Read its Tasks 2–4 before starting: `computeReadProgress` here is a deliberate port and the two must not diverge.

## Global Constraints

- Branch `feat/636-consent-scroll-gate`, base **`feature`** (not `main`, despite recent merge history targeting `main`).
- Conventional Commits. Open the PR as a **draft**.
- Every i18n key added must go into all three locales: `apps/ui/src/i18n/locales/{en,hi,kn}.json`. Keys are **flat and dotted** (`"consent.title_gate"`), not nested.
- `mode: 'view'` behaviour must not change — it stays a dismissible tabbed viewer.
- The U18 guardian flow is legally sensitive. `apps/ui/src/components/consent/u18/__tests__/u18-guardian-flow.mobile.test.tsx` must stay green.
- PR description includes an **In Plain Terms** section (Signals `CLAUDE.md` line 127).
- Node `>=24`, pnpm `11.1.2`, both pinned via `engines` / `packageManager`.
- Run one file: `pnpm --filter ui exec vitest run <path>`
- Run the package: `pnpm --filter ui test`

## File Structure

| File                                                                   | Responsibility                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/ui/src/components/consent/read-progress.ts` (create)             | `computeReadProgress` (pure) + `useReadProgress` hook. Port of the aggregator module. |
| `apps/ui/src/components/consent/consent-progress-tracker.tsx` (create) | Dots-and-line tracker.                                                                |
| `apps/ui/src/components/consent/consent-gate.tsx` (create)             | Guided-read gate body, rendered inside the existing `ResponsiveDialog`.               |
| `apps/ui/src/components/consent/consent-modal.tsx` (modify)            | Delegates to the gate when `mode === 'gate'`; `view` unchanged.                       |
| `apps/ui/src/i18n/locales/{en,hi,kn}.json` (modify)                    | New `consent.*` gate keys.                                                            |

**Why a separate file rather than editing `consent-modal.tsx` in place.** The modal currently mixes tab layout, gate footer, and dialog wiring in one component. Adding a second layout mode inline would make it harder to read and would put `view`-mode regressions one careless edit away. Splitting keeps the untouched path genuinely untouched.

---

### Task 1: Read-progress logic (port)

**Files:**

- Create: `apps/ui/src/components/consent/read-progress.ts`
- Test: `apps/ui/src/components/consent/__tests__/read-progress.test.ts`

**Interfaces:**

- Produces: `SectionBox`, `ScrollBox`, `ReadProgress`, `computeReadProgress`, `useReadProgress` — identical signatures to the aggregator module, minus the `ConsentDoc` import (Signals passes ids directly).

```ts
export function computeReadProgress(
  scroll: ScrollBox,
  sections: SectionBox[],
  alreadyRead: readonly string[],
): ReadProgress;

export function useReadProgress(
  scrollRef: RefObject<HTMLElement | null>,
  docIds: string[],
): ReadProgress;
```

- [ ] **Step 1: Write the failing test**

Use the exact same cases as aggregator Task 2 — the two implementations must agree case-for-case. Copy the test body from `docs/superpowers/plans/2026-08-20-consent-scroll-gate-aggregator.md` Task 2 Step 1, changing only the import path:

```ts
import { computeReadProgress } from '@/components/consent/read-progress';
```

All seven cases apply unchanged: nothing read at top; read once bottom passes viewport; continuous fill; all read at bottom; sticky after scrolling up; **unscrollable content counts as read**; empty list reports `allRead`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/read-progress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Port the aggregator implementation verbatim (aggregator plan Task 2 Step 3), with two changes:

- `useReadProgress` takes `docIds: string[]` instead of `docs: ConsentDoc[]`, and iterates ids directly.
- Drop the `'use client'` directive — this is Vite, not Next.

Keep `TOLERANCE = 8` and keep the comment explaining why unscrollable content counts as read. That guard is what stops a short policy document locking a network out of signup.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/read-progress.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/consent/read-progress.ts apps/ui/src/components/consent/__tests__/read-progress.test.ts
git commit -m "feat(consent): add scroll read-progress logic for the consent gate (#636)"
```

---

### Task 2: Progress tracker

**Files:**

- Create: `apps/ui/src/components/consent/consent-progress-tracker.tsx`
- Test: `apps/ui/src/components/consent/__tests__/consent-progress-tracker.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface TrackerDoc {
  id: string;
  cap: string;
}
export function ConsentProgressTracker(props: {
  docs: TrackerDoc[];
  progress: ReadProgress;
}): React.JSX.Element | null;
```

Same contract as the aggregator: `data-testid="consent-node-<id>"` with `data-state` of `todo | current | read`, a `consent-progress-fill` element whose width is the fill percent, and `null` for fewer than two documents. Use this repo's Tailwind tokens (`bg-primary`, `text-muted-foreground`, `border-border`) rather than the aggregator's `--bd-*` variables.

- [ ] **Step 1: Write the failing test**

Same three cases as aggregator Task 3 Step 1, with `docs` as `TrackerDoc[]`:

```tsx
const docs = [
  { id: 'privacy', cap: 'Privacy' },
  { id: 'terms', cap: 'Terms' },
];
```

Assert: first current / rest todo at the start; read + fill width at 50%; renders nothing for a single document.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/consent-progress-tracker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Port aggregator Task 3 Step 3, swapping the class tokens for this repo's and using `React.JSX.Element` as the return type (this repo types it that way — see `responsive-dialog.tsx`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/consent-progress-tracker.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/consent/consent-progress-tracker.tsx apps/ui/src/components/consent/__tests__/consent-progress-tracker.test.tsx
git commit -m "feat(consent): add the per-document consent progress tracker (#636)"
```

---

### Task 3: Gate body + i18n

**Files:**

- Create: `apps/ui/src/components/consent/consent-gate.tsx`
- Modify: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`
- Test: `apps/ui/src/components/consent/__tests__/consent-gate.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface ConsentGateDoc {
  id: string;
  cap: string;
  title: string;
  body: string;
}
export function ConsentGateBody(props: {
  docs: ConsentGateDoc[];
  onAccept: () => void;
}): React.JSX.Element;
```

`ConsentGateBody` renders **inside** the existing `ResponsiveDialog` — the dialog wiring stays in `consent-modal.tsx` so the drawer/dialog and dismissal guards are not duplicated.

Existing keys stay as they are (`consent.title_gate`, `consent.desc_gate`, `consent.agree_label`, `consent.accept_continue`). Add two:

`en.json`:

```json
"consent.hint_scroll": "Scroll to the end to unlock the checkbox.",
"consent.hint_done": "You have reached the end — you can agree now.",
```

`hi.json`:

```json
"consent.hint_scroll": "चेकबॉक्स सक्रिय करने के लिए अंत तक स्क्रॉल करें।",
"consent.hint_done": "आप अंत तक पहुँच गए हैं — अब आप सहमति दे सकते हैं।",
```

`kn.json`:

```json
"consent.hint_scroll": "ಚೆಕ್‌ಬಾಕ್ಸ್ ಸಕ್ರಿಯಗೊಳಿಸಲು ಕೊನೆಯವರೆಗೆ ಸ್ಕ್ರಾಲ್ ಮಾಡಿ.",
"consent.hint_done": "ನೀವು ಕೊನೆಯನ್ನು ತಲುಪಿದ್ದೀರಿ — ಈಗ ಸಮ್ಮತಿಸಬಹುದು.",
```

Place each beside the existing `consent.*` keys (around line 439 in `en.json`).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConsentGateBody } from '@/components/consent/consent-gate';

const docs = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'Privacy body' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 'Terms body' },
];

/**
 * jsdom performs no layout, so an unstubbed scroller reads 0x0 and is treated
 * as unscrollable. Stub geometry to exercise the locked path.
 */
function stubScroller(scrollTop: number) {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  docs.forEach((d, i) => {
    const s = el.querySelector<HTMLElement>(`[data-consent-section="${d.id}"]`)!;
    Object.defineProperty(s, 'offsetTop', { value: i * 300, configurable: true });
    Object.defineProperty(s, 'offsetHeight', { value: 300, configurable: true });
  });
  return el;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe('<ConsentGateBody />', () => {
  it('keeps the checkbox and CTA locked until the end is reached', () => {
    render(<ConsentGateBody docs={docs} onAccept={vi.fn()} />);
    fireEvent.scroll(stubScroller(0));
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /accept/i })).toBeDisabled();
  });

  it('unlocks the checkbox at the end, then the CTA once ticked', () => {
    const onAccept = vi.fn();
    render(<ConsentGateBody docs={docs} onAccept={onAccept} />);
    fireEvent.scroll(stubScroller(400));

    const box = screen.getByRole('checkbox');
    expect(box).toBeEnabled();
    const cta = screen.getByRole('button', { name: /accept/i });
    expect(cta).toBeDisabled();
    fireEvent.click(box);
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('treats content shorter than the viewport as read', () => {
    render(
      <ConsentGateBody
        docs={[{ id: 'terms', cap: 'Terms', title: 'Terms', body: 'Short.' }]}
        onAccept={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('renders every document in one scroll region rather than tabs', () => {
    render(<ConsentGateBody docs={docs} onAccept={vi.fn()} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const reader = screen.getByTestId('consent-reader');
    expect(reader.querySelectorAll('[data-consent-section]')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/consent-gate.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Port aggregator Task 4's body, adapted:

- Use this repo's `Checkbox`, `Label`, and `Markdown` (`@/components/consent/markdown`) rather than raw inputs.
- Keep the existing gate CTA classes from `consent-modal.tsx` (`bg-brand-cta`, `text-[var(--brand-cta-foreground)]`, `h-11`) so the button looks unchanged.
- Render only the header-less body: `ResponsiveDialog` and `DialogHeader` stay in `consent-modal.tsx`.
- The scroll region carries `data-testid="consent-reader"`; each section carries `data-consent-section="<id>"`.
- The `Checkbox` must expose `disabled` so `toBeDisabled()` works — pass `disabled={!progress.allRead}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/consent-gate.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/consent/consent-gate.tsx apps/ui/src/components/consent/__tests__/consent-gate.test.tsx apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(consent): add the guided-read consent gate body (#636)"
```

---

### Task 4: Delegate gate mode from `consent-modal.tsx`

**Files:**

- Modify: `apps/ui/src/components/consent/consent-modal.tsx`
- Test: `apps/ui/src/components/consent/__tests__/consent-modal.test.tsx` (extend)

**Interfaces:**

- Consumes: `ConsentGateBody` (Task 3).
- Produces: no signature change. `ConsentModalProps` is untouched, so **all four call sites keep working with no edits.**

Changes:

1. Build `docs` from `config` (respecting the existing `variant === 'u18'` document selection) as `ConsentGateDoc[]`, ordered privacy → terms.
2. When `mode === 'gate'`, render `<ConsentGateBody docs={docs} onAccept={onAccept} />` in place of the `Tabs` + footer.
3. When `mode === 'view'`, render exactly what it renders today.
4. Keep `dismissible={mode !== 'gate'}`, `showCloseButton={mode === 'view'}`, and both guard callbacks unchanged. `responsive-dialog.tsx` documents that `dismissible` — not the callbacks — is what actually blocks swipe dismissal on the mobile Drawer.

`cap` values come from the document titles' first word is **not** reliable; use fixed caps `'Privacy'` and `'Terms'` from the existing `consent.tab_privacy` / `consent.tab_terms` translations so they localise.

- [ ] **Step 1: Write the failing test**

Append to `consent-modal.test.tsx`:

```tsx
describe('gate mode uses the guided read', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('renders no tabs in gate mode', () => {
    render(<ConsentModal open mode="gate" initialTab="privacy" config={config} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('consent-reader')).toBeInTheDocument();
  });

  it('still renders tabs in view mode', () => {
    render(
      <ConsentModal open mode="view" initialTab="privacy" config={config} onOpenChange={vi.fn()} />,
    );
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(0);
  });

  it('shows the U18 documents when variant is u18', () => {
    render(<ConsentModal open mode="gate" initialTab="privacy" config={config} variant="u18" />);
    expect(screen.getByTestId('consent-reader')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/consent/__tests__/consent-modal.test.tsx`
Expected: FAIL — gate mode still renders tabs.

- [ ] **Step 3: Implement**

```tsx
import { ConsentGateBody, type ConsentGateDoc } from './consent-gate';

// inside the component, after `docs`, `privacyVersion`, `termsVersion` are resolved:
const gateDocs: ConsentGateDoc[] = [
  privacyVersion && {
    id: 'privacy',
    cap: t('consent.tab_privacy'),
    title: privacyVersion.title,
    body: privacyVersion.content,
  },
  termsVersion && {
    id: 'terms',
    cap: t('consent.tab_terms'),
    title: termsVersion.title,
    body: termsVersion.content,
  },
].filter(Boolean) as ConsentGateDoc[];
```

Then inside the `ResponsiveDialog`, keep the existing `DialogHeader` and replace the body:

```tsx
{mode === 'gate' ? (
  <ConsentGateBody docs={gateDocs} onAccept={() => onAccept?.()} />
) : (
  /* existing Tabs block, unchanged */
)}
```

- [ ] **Step 4: Run the consent suites**

Run: `pnpm --filter ui exec vitest run src/components/consent/`
Expected: PASS — including `consent-modal.viewport.test.tsx` and `profile-consent-modal.test.tsx`.

- [ ] **Step 5: Run the U18 guardian suites specifically**

Run: `pnpm --filter ui exec vitest run src/components/consent/u18/`
Expected: PASS. These assert the mobile drawer scrolls and that the logout escape hatch stays reachable. If they fail, the gate body's scroll container is fighting the drawer's — fix before continuing rather than adjusting the tests.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/consent/consent-modal.tsx apps/ui/src/components/consent/__tests__/consent-modal.test.tsx
git commit -m "feat(consent): render gate mode as a guided read across all four gates (#636)"
```

---

### Task 5: Public legal pages — contents rail + wire the footer link

**Files:**

- Create: `apps/ui/src/pages/legal/legal-sections.ts`
- Create: `apps/ui/src/pages/legal/legal-document-view.tsx`
- Modify: `apps/ui/src/pages/legal/privacy-page.tsx`
- Modify: `apps/ui/src/pages/legal/terms-page.tsx`
- Modify: `apps/ui/src/components/layout/auth-footer.tsx`
- Test: `apps/ui/src/pages/legal/__tests__/legal-sections.test.ts`
- Test: `apps/ui/src/pages/legal/__tests__/legal-document-view.test.tsx`
- Test: `apps/ui/src/components/layout/__tests__/auth-footer.test.tsx`

**Interfaces:**

- Produces: `extractSections(markdown: string): LegalSection[]` and
  `LegalDocumentView({ doc }: { doc: 'privacy' | 'terms' }): React.JSX.Element` — the view
  reads `useConsentConfig()` itself, matching how `privacy-page.tsx` already does.

**This is largely a repair.** `/privacy` and `/terms` already exist and already render the
config Markdown. `privacy-page.tsx` even carries the comment _"These pages are reachable
straight from the auth footer"_ — but `auth-footer.tsx` opens the read-only `ConsentModal`
instead of navigating. The link was never wired.

Signals has **one** audience (plus the `u18` variant), so unlike the aggregator the rail
lists just the two documents and their sections — no audience grouping.

Read-only: no checkbox, no scroll gating. The gate from Tasks 1–4 is untouched.

**Rail structure — settled against the prototype:**

- The **group header is the navigation**: `PRIVACY POLICY` / `TERMS OF SERVICE` is itself the
  link to `/privacy` / `/terms`, carrying `aria-current` for the one being read.
- **Every section entry reads the same.** An earlier draft rendered the first section
  un-indented and darker, which implied it outranked the others. It does not — "Overview" is
  just another section. Uniform styling, one indent level.
- The group not being read is dimmed, not hidden.

- [ ] **Step 1: Write the failing test for section extraction**

Same four cases as aggregator Task 9 Step 1 — level-2 and level-3 headings in order, fenced
code blocks ignored, colliding ids suffixed, empty list for no headings. Import from
`@/pages/legal/legal-sections`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/pages/legal/__tests__/legal-sections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `legal-sections.ts`**

Port the aggregator implementation (aggregator plan Task 9 Step 3) verbatim. It has no
framework dependency, so the only change is dropping any Next-specific import. Keep the
comment explaining the "Grievances" collision — it is the reason the dedupe exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/pages/legal/__tests__/legal-sections.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for the view**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LegalDocumentView } from '@/pages/legal/legal-document-view';

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({
    isLoading: false,
    config: {
      documents: {
        privacy: {
          current_version: 1,
          versions: [
            { version: 1, title: 'Privacy Policy', content: '## Overview\n### Retention\nx' },
          ],
        },
        terms: {
          current_version: 1,
          versions: [{ version: 1, title: 'Terms of Service', content: '## Overview' }],
        },
      },
    },
  }),
}));

const view = (doc: 'privacy' | 'terms') =>
  render(
    <MemoryRouter>
      <LegalDocumentView doc={doc} />
    </MemoryRouter>,
  );

describe('<LegalDocumentView />', () => {
  it('lists both documents in the rail', () => {
    view('privacy');
    expect(screen.getAllByText('Privacy Policy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Terms of Service').length).toBeGreaterThan(0);
  });

  it('anchors each extracted section', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  it('links to the other document by route', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: /Terms of Service/ })).toHaveAttribute(
      'href',
      '/terms',
    );
  });

  it('captures no consent', () => {
    view('terms');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/pages/legal/__tests__/legal-document-view.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the view and slim both pages**

`legal-document-view.tsx` holds the whole layout: loading state, unavailable state, the
language/theme controls the existing pages carry, the contents rail, and the reading column.
Rail entries for the _current_ document are in-page anchors; the other document is a
react-router `<Link>` to its route.

Then reduce `privacy-page.tsx` and `terms-page.tsx` to:

```tsx
import { LegalDocumentView } from './legal-document-view';

export function PrivacyPage() {
  return <LegalDocumentView doc="privacy" />;
}
```

Keep the loading spinner and the "unavailable" fallback that `privacy-page.tsx` has today —
move them into the view, do not drop them.

Match approach B in `~/KKB/Github/2026-08-20-public-legal-page-approaches.html`, using this
repo's tokens (`bg-background`, `text-muted-foreground`, `border-border`).

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/pages/legal/`
Expected: PASS.

- [ ] **Step 9: Write the failing test for the footer link**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthFooter } from '@/components/layout/auth-footer';

// Mock useConsentConfig and useNetworkTheme as the existing layout tests do —
// copy their exact shape from a neighbouring test in this directory.

describe('<AuthFooter />', () => {
  it('links to the public pages rather than opening a modal', () => {
    render(
      <MemoryRouter>
        <AuthFooter />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/auth-footer.test.tsx`
Expected: FAIL — the footer renders buttons, not links.

- [ ] **Step 11: Rewire the footer**

Replace the two `<button onClick={openModal(...)}>` elements with react-router `<Link to="/privacy">` and `<Link to="/terms">`, keeping the existing classes so the appearance does not change. Then delete the now-unused `ConsentModal` import, `useState`, `modalTab` state, and `openModal` — leaving dead state behind is how the next person concludes the modal is still reachable.

The surrounding sentence ("By continuing you agree to the … and ….") is unchanged.

- [ ] **Step 12: Run tests**

Run: `pnpm --filter ui exec vitest run src/components/layout/ src/pages/legal/`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/ui/src/pages/legal apps/ui/src/components/layout/auth-footer.tsx apps/ui/src/components/layout/__tests__/auth-footer.test.tsx
git commit -m "feat(legal): give the public legal pages a contents rail and link them from the footer (#636)"
```

---

### Task 6: Full verification and draft PR

**Files:** none created.

- [ ] **Step 1: Full package test run**

Run: `pnpm --filter ui test`
Expected: 0 failures. Capture the before/after counts — establish the baseline with `git stash` if you have not already.

- [ ] **Step 2: Typecheck and build**

```bash
pnpm typecheck
pnpm --filter ui build
```

Expected: clean.

- [ ] **Step 3: Manual verification at both breakpoints**

Run `pnpm dev:ui` (or `pnpm --filter ui dev`) and check, at desktop width **and** a 390px phone viewport, for **each of the four gates**:

1. Account creation (`keycloak-login-panel`) — gate opens on Create account, checkbox locked, scrolling to the end unlocks it.
2. Login (`login-page`) and OIDC callback (`oidc-callback-page`) — same.
3. U18 guardian step — same, and the logout escape hatch is still reachable.
4. On mobile the gate is a vaul Drawer: it **cannot** be swiped away, the tracker stays pinned, and the CTA clears the home indicator.

Record what was checked in the PR description.

- [ ] **Step 4: Push and open the draft PR**

```bash
git push -u origin feat/636-consent-scroll-gate
gh pr create --draft --base feature \
  --title "feat(consent): require scrolling through the terms before accepting (#636)" \
  --body-file <(cat <<'BODY'
Part of Blue-Dots-Economy/aggregator-dpg#636 (Signals side; aggregator PR tracked separately).

## In Plain Terms

Until now, the consent popup let someone tick "I agree" the instant it opened,
without scrolling a line. Now the terms and privacy policy appear as one
continuous read, and the agree box stays greyed out until the reader reaches
the end. A row of dots at the top shows which document they are in and how much
is left.

Nothing about what we record changes. What changes is that people have to have
seen the words before they can agree to them.

## Summary

- Gate mode becomes a single continuous guided read with a progress tracker.
  Tabs remain for `mode="view"`, which is unchanged.
- All four gates get it — login, OIDC callback, account creation, and the U18
  guardian step — with **no call-site changes**; `consent-modal.tsx` delegates.
- Two new translated strings for the scroll hint, in en/hi/kn.

## Notes for review

- Content shorter than its viewport counts as read. Without that guard, a
  policy document short enough not to scroll would lock the checkbox forever
  and make signup impossible on that network. Covered by tests.
- `dismissible={false}` is retained on the mobile Drawer — per the comments in
  `responsive-dialog.tsx`, that prop and not the guard callbacks is what
  actually blocks swipe dismissal there.
- The U18 guardian mobile-drawer tests are unchanged and still pass.
- Scroll position evidences reaching the end, not reading it. This is a
  good-faith gate, not a compliance guarantee.

Spec (aggregator-dpg, branch `feat/636-consent-scroll-gate`):
`docs/superpowers/specs/2026-08-20-consent-scroll-gate-design.md`
BODY
)
```

- [ ] **Step 5: Verify CI**

Run: `gh pr checks --watch`
Expected: green.

---

## Self-Review

**Spec coverage.** All four Signals gate call sites → Task 4 (via delegation, so no call site is edited). Scroll gating → Task 1. Tracker → Task 2. Gate body → Task 3. `view` mode unchanged → Task 4 Steps 1 and 3. U18 guardian tests stay green → Task 4 Step 5. Mobile drawer / `dismissible` → Task 4 Step 3 and Task 5 Step 3. i18n across three locales → Task 3. Short-document guard → Tasks 1 and 3.

**Type consistency.** `ReadProgress { readIds, currentId, fillPercent, allRead }` is defined in Task 1 and consumed in Tasks 2 and 3. `TrackerDoc { id, cap }` (Task 2) is a structural subset of `ConsentGateDoc { id, cap, title, body }` (Task 3), so the tracker accepts gate docs directly. `computeReadProgress` and `useReadProgress` keep the aggregator's signatures apart from `useReadProgress` taking `docIds: string[]`, which is called out explicitly in Task 1.

**Cross-repo consistency.** Task 1's test cases are specified as identical to aggregator Task 2's. That is the only mechanism keeping the two implementations honest — the repos share no code, so if one set of cases is weakened the products drift silently.

**Known risk.** Task 4 assumes `Checkbox` from `@/components/ui/checkbox` forwards `disabled` to the underlying input so `toBeDisabled()` resolves. If it does not, Task 3 Step 3 must use `aria-disabled` plus a guard in the change handler, and the tests must assert on that instead. Verify before writing Task 3's implementation.
