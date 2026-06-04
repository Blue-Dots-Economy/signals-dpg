# Bulk Actions UI + Map-Popup Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the two bulk action APIs (`/action/perform`, `/action/update-status`) in the UI via click-to-select on the existing cards, and redesign the map marker popup with a theme-coloured branded card carrying Connect + See Match Score.

**Architecture:** Three reusable selection primitives (`useCardSelection` hook, `SelectableCard` wrapper, `BulkActionBar`) compose over the *existing* cards untouched. Two new bulk API client functions return the raw `{results, summary}` envelope so partial-success (207) is surfaced. The map popup is redesigned as a presentational component and threaded through a new optional `renderPopup` render-prop on the provider contract; `home-page` supplies popup content (actions + match-score data) from its existing scope.

**Tech Stack:** React 19 + Vite + TypeScript (strict), TanStack Query, react-i18next (flat dotted keys, locales `en`/`hi`/`kn`), Tailwind, shadcn/ui, Leaflet + Google Maps providers, axios.

**Spec:** `docs/superpowers/specs/2026-06-04-bulk-actions-ui-design.md`

**Branch:** `bulk-actions-ui` (already created, based on `feature`).

## Verification model

`apps/ui` has **no test runner** (confirmed: no vitest, no testing-library, no test scripts). Per the repo norm and the user's decision, every task is verified by:

1. **Typecheck:** `pnpm --filter ui exec tsc --noEmit` → expected: no errors.
2. **Manual:** the steps described per task (run `pnpm dev:ui` if not already running; the dev server is typically already up during this work).

No `.test.ts` files are created.

## i18n note

Locale files use **flat dotted keys** with `keySeparator: false` (e.g. `"actions.btn_accept"`). A missing key renders the literal key string (no crash, no type error), but we add every new key to all three locales (`en.json`, `hi.json`, `kn.json`) up front in Task 1 so no English-fallback or raw-key text ever shows. Plurals use the i18next `_one`/`_other` suffix convention already present (`header.listings_one`/`_other`).

## File structure

**New files**
- `apps/ui/src/hooks/use-card-selection.ts` — selection state (Set + lock).
- `apps/ui/src/components/selection/selectable-card.tsx` — ring/check wrapper + click-to-toggle.
- `apps/ui/src/components/selection/bulk-action-bar.tsx` — sticky bottom bar.
- `apps/ui/src/components/actions/bulk-status-dialog.tsx` — bulk accept/reject/cancel confirm.

**Modified files**
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — new keys.
- `apps/ui/src/lib/bulk.ts` — `postBulkEnvelope` + `bulkFailureIndices`.
- `apps/ui/src/lib/action-api.ts` — `performActionsBulk`, `updateActionStatusBulk`.
- `apps/ui/src/lib/item-api.ts` — re-export `performActionsBulk`.
- `apps/ui/src/hooks/use-actions.ts` — `useUpdateActionStatusBulk`.
- `apps/ui/src/components/cards/domain-card.tsx` — `selectionMode` prop.
- `apps/ui/src/components/match-score/match-score-card.tsx` — forward `selectionMode`.
- `apps/ui/src/components/actions/action-card.tsx` — `selectionMode` prop.
- `apps/ui/src/components/actions/action-list.tsx` — Select toggle + wrap cards + selection props.
- `apps/ui/src/pages/my-actions-page.tsx` — selection state + bulk dialog wiring.
- `apps/ui/src/pages/home-page.tsx` — Select toggle, wrap cards, domain lock, bulk connect modal, hoist `ActionHandler`, `renderPopup`.
- `apps/ui/src/engine/types.ts` — `renderPopup` on `MapProviderProps`.
- `apps/ui/src/components/map/map-container.tsx` — accept + forward `renderPopup`.
- `apps/ui/src/components/map/providers/leaflet-provider.tsx` — `renderPopup` fallback.
- `apps/ui/src/components/map/providers/google-maps-provider.tsx` — `renderPopup` fallback.
- `apps/ui/src/components/map/marker-popup-card.tsx` — redesign.

---

## Task 1: Add all i18n keys (en / hi / kn)

**Files:**
- Modify: `apps/ui/src/i18n/locales/en.json`
- Modify: `apps/ui/src/i18n/locales/hi.json`
- Modify: `apps/ui/src/i18n/locales/kn.json`

These are flat-key JSON objects. Add the following keys (insert anywhere; keep valid JSON — add a comma after the preceding entry). Use the exact key strings; only the values differ per locale.

- [ ] **Step 1: Add keys to `en.json`**

```json
"selection.select": "Select",
"selection.done": "Done",
"selection.clear": "Clear",
"selection.n_selected_one": "{{count}} selected",
"selection.n_selected_other": "{{count}} selected",
"home.bulk_connect_all_one": "Connect ({{count}})",
"home.bulk_connect_all_other": "Connect all ({{count}})",
"home.bulk_connected_all_one": "Connected {{count}} request",
"home.bulk_connected_all_other": "Connected {{count}} requests",
"home.bulk_connected_partial": "Connected {{succeeded}} of {{total}}",
"home.bulk_connect_failed": "Could not send connection requests",
"home.bulk_connect_first_error": "First error: {{message}}",
"actions.bulk_accept": "Accept",
"actions.bulk_reject": "Reject",
"actions.bulk_cancel": "Cancel requests",
"actions.bulk_confirm_accept_title_one": "Accept {{count}} request?",
"actions.bulk_confirm_accept_title_other": "Accept {{count}} requests?",
"actions.bulk_confirm_reject_title_one": "Reject {{count}} request?",
"actions.bulk_confirm_reject_title_other": "Reject {{count}} requests?",
"actions.bulk_confirm_cancel_title_one": "Cancel {{count}} request?",
"actions.bulk_confirm_cancel_title_other": "Cancel {{count}} requests?",
"actions.bulk_reason_label": "Reason (optional, applied to all)",
"actions.bulk_reason_placeholder": "Add an optional note…",
"actions.bulk_confirm_btn": "Confirm",
"actions.bulk_done_all_one": "Updated {{count}} request",
"actions.bulk_done_all_other": "Updated {{count}} requests",
"actions.bulk_done_partial": "Updated {{succeeded}} of {{total}}",
"actions.bulk_failed": "Could not update requests",
"map.connect": "Connect",
"map.see_match_score": "See Match Score"
```

- [ ] **Step 2: Add the same keys to `hi.json` (Hindi values)**

```json
"selection.select": "चुनें",
"selection.done": "हो गया",
"selection.clear": "हटाएँ",
"selection.n_selected_one": "{{count}} चयनित",
"selection.n_selected_other": "{{count}} चयनित",
"home.bulk_connect_all_one": "जोड़ें ({{count}})",
"home.bulk_connect_all_other": "सभी जोड़ें ({{count}})",
"home.bulk_connected_all_one": "{{count}} अनुरोध भेजा गया",
"home.bulk_connected_all_other": "{{count}} अनुरोध भेजे गए",
"home.bulk_connected_partial": "{{total}} में से {{succeeded}} भेजे गए",
"home.bulk_connect_failed": "कनेक्शन अनुरोध नहीं भेजे जा सके",
"home.bulk_connect_first_error": "पहली त्रुटि: {{message}}",
"actions.bulk_accept": "स्वीकारें",
"actions.bulk_reject": "अस्वीकारें",
"actions.bulk_cancel": "अनुरोध रद्द करें",
"actions.bulk_confirm_accept_title_one": "{{count}} अनुरोध स्वीकारें?",
"actions.bulk_confirm_accept_title_other": "{{count}} अनुरोध स्वीकारें?",
"actions.bulk_confirm_reject_title_one": "{{count}} अनुरोध अस्वीकारें?",
"actions.bulk_confirm_reject_title_other": "{{count}} अनुरोध अस्वीकारें?",
"actions.bulk_confirm_cancel_title_one": "{{count}} अनुरोध रद्द करें?",
"actions.bulk_confirm_cancel_title_other": "{{count}} अनुरोध रद्द करें?",
"actions.bulk_reason_label": "कारण (वैकल्पिक, सभी पर लागू)",
"actions.bulk_reason_placeholder": "वैकल्पिक टिप्पणी जोड़ें…",
"actions.bulk_confirm_btn": "पुष्टि करें",
"actions.bulk_done_all_one": "{{count}} अनुरोध अपडेट हुआ",
"actions.bulk_done_all_other": "{{count}} अनुरोध अपडेट हुए",
"actions.bulk_done_partial": "{{total}} में से {{succeeded}} अपडेट हुए",
"actions.bulk_failed": "अनुरोध अपडेट नहीं हो सके",
"map.connect": "जोड़ें",
"map.see_match_score": "मैच स्कोर देखें"
```

- [ ] **Step 3: Add the same keys to `kn.json` (Kannada values)**

```json
"selection.select": "ಆಯ್ಕೆಮಾಡಿ",
"selection.done": "ಮುಗಿದಿದೆ",
"selection.clear": "ತೆರವುಗೊಳಿಸಿ",
"selection.n_selected_one": "{{count}} ಆಯ್ಕೆಯಾಗಿದೆ",
"selection.n_selected_other": "{{count}} ಆಯ್ಕೆಯಾಗಿವೆ",
"home.bulk_connect_all_one": "ಸಂಪರ್ಕಿಸಿ ({{count}})",
"home.bulk_connect_all_other": "ಎಲ್ಲವನ್ನೂ ಸಂಪರ್ಕಿಸಿ ({{count}})",
"home.bulk_connected_all_one": "{{count}} ವಿನಂತಿ ಕಳುಹಿಸಲಾಗಿದೆ",
"home.bulk_connected_all_other": "{{count}} ವಿನಂತಿಗಳನ್ನು ಕಳುಹಿಸಲಾಗಿದೆ",
"home.bulk_connected_partial": "{{total}} ರಲ್ಲಿ {{succeeded}} ಕಳುಹಿಸಲಾಗಿದೆ",
"home.bulk_connect_failed": "ಸಂಪರ್ಕ ವಿನಂತಿಗಳನ್ನು ಕಳುಹಿಸಲಾಗಲಿಲ್ಲ",
"home.bulk_connect_first_error": "ಮೊದಲ ದೋಷ: {{message}}",
"actions.bulk_accept": "ಸ್ವೀಕರಿಸಿ",
"actions.bulk_reject": "ತಿರಸ್ಕರಿಸಿ",
"actions.bulk_cancel": "ವಿನಂತಿಗಳನ್ನು ರದ್ದುಗೊಳಿಸಿ",
"actions.bulk_confirm_accept_title_one": "{{count}} ವಿನಂತಿ ಸ್ವೀಕರಿಸಬೇಕೆ?",
"actions.bulk_confirm_accept_title_other": "{{count}} ವಿನಂತಿಗಳನ್ನು ಸ್ವೀಕರಿಸಬೇಕೆ?",
"actions.bulk_confirm_reject_title_one": "{{count}} ವಿನಂತಿ ತಿರಸ್ಕರಿಸಬೇಕೆ?",
"actions.bulk_confirm_reject_title_other": "{{count}} ವಿನಂತಿಗಳನ್ನು ತಿರಸ್ಕರಿಸಬೇಕೆ?",
"actions.bulk_confirm_cancel_title_one": "{{count}} ವಿನಂತಿ ರದ್ದುಗೊಳಿಸಬೇಕೆ?",
"actions.bulk_confirm_cancel_title_other": "{{count}} ವಿನಂತಿಗಳನ್ನು ರದ್ದುಗೊಳಿಸಬೇಕೆ?",
"actions.bulk_reason_label": "ಕಾರಣ (ಐಚ್ಛಿಕ, ಎಲ್ಲದಕ್ಕೂ ಅನ್ವಯ)",
"actions.bulk_reason_placeholder": "ಐಚ್ಛಿಕ ಟಿಪ್ಪಣಿ ಸೇರಿಸಿ…",
"actions.bulk_confirm_btn": "ದೃಢೀಕರಿಸಿ",
"actions.bulk_done_all_one": "{{count}} ವಿನಂತಿ ನವೀಕರಿಸಲಾಗಿದೆ",
"actions.bulk_done_all_other": "{{count}} ವಿನಂತಿಗಳನ್ನು ನವೀಕರಿಸಲಾಗಿದೆ",
"actions.bulk_done_partial": "{{total}} ರಲ್ಲಿ {{succeeded}} ನವೀಕರಿಸಲಾಗಿದೆ",
"actions.bulk_failed": "ವಿನಂತಿಗಳನ್ನು ನವೀಕರಿಸಲಾಗಲಿಲ್ಲ",
"map.connect": "ಸಂಪರ್ಕಿಸಿ",
"map.see_match_score": "ಮ್ಯಾಚ್ ಸ್ಕೋರ್ ನೋಡಿ"
```

- [ ] **Step 4: Typecheck + verify JSON valid**

Run: `cd apps/ui && node -e "['en','hi','kn'].forEach(l=>{const o=require('./src/i18n/locales/'+l+'.json'); if(!('map.connect' in o)) throw new Error(l+' missing map.connect'); }); console.log('ok')"`
Expected: `ok`

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): i18n keys for bulk actions + map popup"
```

---

## Task 2: `useCardSelection` hook

Owns *which ids are selected* and *what group the batch is locked to*. No rendering, no API.

**Files:**
- Create: `apps/ui/src/hooks/use-card-selection.ts`

- [ ] **Step 1: Create the hook**

```ts
import * as React from 'react';

export interface CardSelection {
  /** Whether select mode is active. */
  selectMode: boolean;
  /** Turn select mode on. */
  enterSelect: () => void;
  /** Turn select mode off AND clear selection + lock. */
  exitSelect: () => void;
  /** Currently selected item ids. */
  selected: Set<string>;
  /** True when this id is selected. */
  isSelected: (id: string) => boolean;
  /**
   * Toggle an id. `groupKey` is the lock group the id belongs to (e.g. its
   * domain, or its status). The first toggle in an empty selection sets the
   * lock; while a lock is set, toggling an id from a different group is ignored.
   */
  toggle: (id: string, groupKey?: string) => void;
  /** Returns true when an id may be selected given the current lock. */
  canSelect: (groupKey?: string) => boolean;
  /** Empty the selection (and release the lock) but stay in select mode. */
  clear: () => void;
  /** The group key the batch is locked to, or null when nothing is selected. */
  lockKey: string | null;
  /** Replace the selection with the given ids (used to keep failed ids selected). */
  setSelected: (ids: string[]) => void;
}

export function useCardSelection(): CardSelection {
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelectedState] = React.useState<Set<string>>(new Set());
  const [lockKey, setLockKey] = React.useState<string | null>(null);

  const enterSelect = React.useCallback(() => setSelectMode(true), []);

  const clear = React.useCallback(() => {
    setSelectedState(new Set());
    setLockKey(null);
  }, []);

  const exitSelect = React.useCallback(() => {
    setSelectMode(false);
    setSelectedState(new Set());
    setLockKey(null);
  }, []);

  const canSelect = React.useCallback(
    (groupKey?: string) => lockKey === null || groupKey === undefined || groupKey === lockKey,
    [lockKey],
  );

  const toggle = React.useCallback(
    (id: string, groupKey?: string) => {
      setSelectedState((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          if (next.size === 0) setLockKey(null);
          return next;
        }
        // Adding: enforce lock.
        if (lockKey !== null && groupKey !== undefined && groupKey !== lockKey) {
          return prev; // ignore off-lock additions
        }
        next.add(id);
        if (prev.size === 0 && groupKey !== undefined) setLockKey(groupKey);
        return next;
      });
    },
    [lockKey],
  );

  const setSelected = React.useCallback((ids: string[]) => {
    setSelectedState(new Set(ids));
    if (ids.length === 0) setLockKey(null);
  }, []);

  const isSelected = React.useCallback((id: string) => selected.has(id), [selected]);

  return {
    selectMode,
    enterSelect,
    exitSelect,
    selected,
    isSelected,
    toggle,
    canSelect,
    clear,
    lockKey,
    setSelected,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/hooks/use-card-selection.ts
git commit -m "feat(ui): useCardSelection hook (set + group lock)"
```

---

## Task 3: `SelectableCard` wrapper

Adds the Style-1 ring + corner check and a click-to-toggle target in select mode. Passthrough otherwise.

**Files:**
- Create: `apps/ui/src/components/selection/selectable-card.tsx`

- [ ] **Step 1: Create the component**

```tsx
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectableCardProps {
  id: string;
  selectMode: boolean;
  selected: boolean;
  /** When false (only meaningful in select mode), the card is dimmed + non-interactive. */
  selectable?: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

export function SelectableCard({
  id,
  selectMode,
  selected,
  selectable = true,
  onToggle,
  children,
}: SelectableCardProps) {
  // Out of select mode: render children untouched, no wrapper behaviour.
  if (!selectMode) return <>{children}</>;

  const interactive = selectable;

  const handleActivate = () => {
    if (interactive) onToggle(id);
  };

  return (
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-pressed={selected}
      aria-disabled={!interactive}
      onClick={handleActivate}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(id);
        }
      }}
      className={cn(
        'relative rounded-[18px] transition-shadow',
        interactive ? 'cursor-pointer' : 'cursor-not-allowed opacity-45',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      {/* Block clicks from reaching the inner card's own handlers while selecting. */}
      <div className="pointer-events-none">{children}</div>
      {selected && (
        <span className="absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      )}
    </div>
  );
}
```

> **Note:** the `pointer-events-none` inner wrapper means inner card buttons never receive clicks during select mode; combined with the `selectionMode` prop (Task 6) that hides those buttons, the whole card is one clean selection target.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/components/selection/selectable-card.tsx
git commit -m "feat(ui): SelectableCard wrapper (ring + check, click-to-toggle)"
```

---

## Task 4: `BulkActionBar`

Sticky bottom bar: count + Clear + caller-supplied action buttons.

**Files:**
- Create: `apps/ui/src/components/selection/bulk-action-bar.tsx`

- [ ] **Step 1: Create the component**

```tsx
import * as React from 'react';
import { useTranslation } from 'react-i18next';

interface BulkActionBarProps {
  count: number;
  onClear: () => void;
  /** Action buttons (Connect / Accept+Reject / Cancel). */
  children: React.ReactNode;
}

export function BulkActionBar({ count, onClear, children }: BulkActionBarProps) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <div className="sticky bottom-4 z-[1100] mt-4 flex items-center justify-between gap-3 rounded-2xl bg-foreground px-4 py-3 text-background shadow-lg">
      <span className="text-sm font-semibold">{t('selection.n_selected', { count })}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg border border-background/30 px-3 py-1.5 text-xs font-semibold text-background/80 transition hover:text-background"
        >
          {t('selection.clear')}
        </button>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/components/selection/bulk-action-bar.tsx
git commit -m "feat(ui): BulkActionBar sticky bar"
```

---

## Task 5: Bulk API client functions

Return the full `{results, summary}` envelope (resolve on 200/201/207, return the body on 422 all-failed, rethrow genuine errors).

**Files:**
- Modify: `apps/ui/src/lib/bulk.ts`
- Modify: `apps/ui/src/lib/action-api.ts`
- Modify: `apps/ui/src/lib/item-api.ts:111-118`
- Modify: `apps/ui/src/hooks/use-actions.ts`

- [ ] **Step 1: Add `postBulkEnvelope` + `bulkFailureIndices` to `lib/bulk.ts`**

Append to the end of `apps/ui/src/lib/bulk.ts`:

```ts
/**
 * Await a bulk POST that wraps an array of payloads, returning the full
 * envelope. On 200/201/207 axios resolves → return data. On 422 (all items
 * failed) axios rejects with the envelope in response.data → return that.
 * Genuine request-level errors (401, network failure, 400 {error,message}
 * without `results`) are rethrown unchanged.
 */
export async function postBulkEnvelope<T extends object>(
  request: Promise<{ data: BulkEnvelope<NoStatusField<T>> }>,
): Promise<BulkEnvelope<T>> {
  try {
    const res = await request;
    return res.data as BulkEnvelope<T>;
  } catch (err) {
    if (
      isAxiosError(err) &&
      err.response?.data &&
      Array.isArray((err.response.data as Partial<BulkEnvelope<NoStatusField<T>>>).results)
    ) {
      return err.response.data as BulkEnvelope<T>;
    }
    throw err;
  }
}

/** The request indices (echoed by the server as `index`) of items that failed. */
export function bulkFailureIndices<T>(env: BulkEnvelope<T>): number[] {
  return env.results.filter((r) => r.status === 'error').map((r) => r.index);
}

/** The first per-item error message in the envelope, if any. */
export function firstBulkError<T>(env: BulkEnvelope<T>): string | null {
  const f = env.results.find((r) => r.status === 'error');
  return f && f.status === 'error' ? f.message : null;
}
```

> `isAxiosError` and `BulkEnvelope` / `NoStatusField` are already imported/declared at the top of `bulk.ts`.

- [ ] **Step 2: Add bulk functions to `action-api.ts`**

In `apps/ui/src/lib/action-api.ts`, update the import on line 3 and add the two functions after `updateActionStatus` (after line 288).

Change line 3 from:
```ts
import { unwrapBulkSingle, type BulkEnvelope } from './bulk';
```
to:
```ts
import { unwrapBulkSingle, postBulkEnvelope, type BulkEnvelope } from './bulk';
```

Add after line 288:
```ts
/**
 * Perform multiple actions in one bulk call. All payloads share the same source
 * instance (the source item's instance), so a single array POST is correct; the
 * backend loops per-item over the peer endpoint. Returns the full envelope so
 * callers can surface partial-success (207).
 */
export async function performActionsBulk(
  payloads: PerformActionPayload[],
  sourceInstanceUrl?: string,
): Promise<BulkEnvelope<PerformActionResponse>> {
  const client = sourceInstanceUrl
    ? createInstanceApiClient(sourceInstanceUrl)
    : apiClient;
  return postBulkEnvelope<PerformActionResponse>(
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform', payloads),
  );
}

/**
 * Update multiple action statuses in one bulk call. All target actions are
 * self-owned and live on the caller's instance, so a single array POST is
 * correct. Returns the full envelope.
 */
export async function updateActionStatusBulk(
  payloads: UpdateActionStatusPayload[],
): Promise<BulkEnvelope<UpdateActionStatusResponse>> {
  return postBulkEnvelope<UpdateActionStatusResponse>(
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', payloads),
  );
}
```

- [ ] **Step 3: Re-export `performActionsBulk` from `item-api.ts`**

In `apps/ui/src/lib/item-api.ts`, change the re-export block (lines 111-118) to add the bulk function:

```ts
// Re-export action-related types and functions from action-api.ts
export {
  type ItemRef,
  type TargetItemRef,
  type PerformActionPayload,
  type PerformActionResponse,
  performAction,
  performActionsBulk,
} from './action-api';
```

- [ ] **Step 4: Add `useUpdateActionStatusBulk` to `use-actions.ts`**

In `apps/ui/src/hooks/use-actions.ts`, change the import (lines 7-13) to add the bulk fn + types:

```ts
import {
  fetchMyActions,
  updateActionStatus,
  updateActionStatusBulk,
  type FetchMyActionsQuery,
  type UpdateActionStatusPayload,
  type UpdateActionStatusResponse,
  type Action,
} from '@/lib/action-api';
import type { BulkEnvelope } from '@/lib/bulk';
```

Add after `useUpdateActionStatus` (after line 129):
```ts
/**
 * Bulk update action statuses. Returns the full envelope (so callers can show
 * partial-success). Invalidates all action queries on settle.
 */
export function useUpdateActionStatusBulk() {
  const queryClient = useQueryClient();

  return useMutation<BulkEnvelope<UpdateActionStatusResponse>, Error, UpdateActionStatusPayload[]>({
    mutationFn: (payloads) => updateActionStatusBulk(payloads),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: actionKeys.all });
    },
  });
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/bulk.ts apps/ui/src/lib/action-api.ts apps/ui/src/lib/item-api.ts apps/ui/src/hooks/use-actions.ts
git commit -m "feat(ui): bulk action API clients + envelope helpers"
```

---

## Task 6: `selectionMode` prop on the inner cards

When `selectionMode` is true, the card hides its own action footer (so the SelectableCard wrapper is the only interactive surface).

**Files:**
- Modify: `apps/ui/src/components/cards/domain-card.tsx`
- Modify: `apps/ui/src/components/match-score/match-score-card.tsx`
- Modify: `apps/ui/src/components/actions/action-card.tsx`

- [ ] **Step 1: Add `selectionMode` to `DomainCard`**

In `apps/ui/src/components/cards/domain-card.tsx`, add the prop to the interface (after line 35, before the closing `}`):
```ts
  onViewMatchDetails?: () => void;
  /** When true, hide the action/match footer (the card is a selection target). */
  selectionMode?: boolean;
```

Add `selectionMode` to the destructure (after `onViewMatchDetails,` on line 54):
```ts
  onViewMatchDetails,
  selectionMode = false,
```

Wrap the footer condition (line 96) so it never renders in select mode. Change:
```tsx
      {(actions.length > 0 && onAction) || (networkItem && onCalculateMatch) ? (
```
to:
```tsx
      {!selectionMode && ((actions.length > 0 && onAction) || (networkItem && onCalculateMatch)) ? (
```

- [ ] **Step 2: Forward `selectionMode` through `MatchScoreCard`**

In `apps/ui/src/components/match-score/match-score-card.tsx`, add to the interface (after line 20 `networkItem: Item;`):
```ts
  networkItem: Item;
  selectionMode?: boolean;
```

Add to the destructure (after line 34 `networkItem,`):
```ts
  networkItem,
  selectionMode = false,
```

Pass it to `DomainCard` (after line 93 `networkItem={networkItem}`):
```tsx
        networkItem={networkItem}
        selectionMode={selectionMode}
```

- [ ] **Step 3: Add `selectionMode` to `ActionCard`**

In `apps/ui/src/components/actions/action-card.tsx`, add to the interface (after line 25):
```ts
  onStatusUpdate?: (action: Action, targetStatus: string) => void;
  /** When true, hide the action footer (the card is a selection target). */
  selectionMode?: boolean;
```

Update the destructure (line 94):
```tsx
export function ActionCard({ action, ownershipRole, onStatusUpdate, selectionMode = false }: ActionCardProps) {
```

Wrap the actions footer (line 287). Change:
```tsx
        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
```
to:
```tsx
        {/* Actions */}
        {!selectionMode && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
```
and add a closing `)}` immediately after the closing `</div>` of that block (after line 324, before the `<ContactDetailsModal` element):
```tsx
          )}
        </div>
        )}

      <ContactDetailsModal
```
> Be precise: the existing actions `<div>` closes on the line that currently reads `        </div>` just before `<ContactDetailsModal`. Add `)}` after that `</div>`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual check**

Run the app; nothing visually changes yet (no caller passes `selectionMode`). Confirm Browse cards and My Actions cards still render their buttons normally.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/cards/domain-card.tsx apps/ui/src/components/match-score/match-score-card.tsx apps/ui/src/components/actions/action-card.tsx
git commit -m "feat(ui): selectionMode prop hides card footers"
```

---

## Task 7: Browse bulk connect (home-page)

Select toggle (gated on `myItem`), wrap cards in `SelectableCard` (single-domain + All, with domain lock), bulk bar, and one shared `ActionModal` → `performActionsBulk`.

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`

- [ ] **Step 1: Add imports**

In `apps/ui/src/pages/home-page.tsx`, add to imports near the top (after line 23):
```tsx
import { MatchScoreCard } from '@/components/match-score';
import { useCardSelection } from '@/hooks/use-card-selection';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import { ActionModal } from '@/components/actions/action-modal';
import { Button } from '@/components/ui/button';
import { CheckSquare } from 'lucide-react';
```
> `Button` is already imported on line 19 — do NOT add a duplicate; only add `useCardSelection`, `SelectableCard`, `BulkActionBar`, `ActionModal`, and the `CheckSquare` icon import. Add `performActionsBulk` to the existing `@/lib/item-api` import on line 25:
```tsx
import { fetchItems, performAction, performActionsBulk, type Item } from '@/lib/item-api';
```

- [ ] **Step 2: Add selection state + bulk-connect modal state**

Inside the `HomePage` component body, near the other `useState` declarations (e.g. just after line ~185), add:
```tsx
  const browseSelection = useCardSelection();
  const [bulkConnectOpen, setBulkConnectOpen] = React.useState(false);
  const [bulkConnectBusy, setBulkConnectBusy] = React.useState(false);
```

- [ ] **Step 3: Add the Select toggle to `ContentHeader` (gated on `myItem`)**

Change the `ContentHeader` usage (lines 671-676) to pass an `actions` slot. Replace:
```tsx
        <ContentHeader
          title={contentTitle}
          description={contentDescription}
          count={loading ? undefined : contentCount}
          noProfilePrompt={{ show: !myItem, networkId: selectedNetworkId ?? '' }}
        />
```
with:
```tsx
        <ContentHeader
          title={contentTitle}
          description={contentDescription}
          count={loading ? undefined : contentCount}
          noProfilePrompt={{ show: !myItem, networkId: selectedNetworkId ?? '' }}
          actions={
            myItem && viewMode === 'list' ? (
              <Button
                type="button"
                variant={browseSelection.selectMode ? 'default' : 'outline'}
                size="sm"
                onClick={() =>
                  browseSelection.selectMode
                    ? browseSelection.exitSelect()
                    : browseSelection.enterSelect()
                }
              >
                <CheckSquare className="mr-1.5 h-4 w-4" />
                {browseSelection.selectMode ? t('selection.done') : t('selection.select')}
              </Button>
            ) : undefined
          }
        />
```

- [ ] **Step 4: Wrap the All-tab `MatchScoreCard` in `SelectableCard`**

In the All-tab branch (lines 794-820), wrap the returned `MatchScoreCard`. Replace the `return (` block that renders `<MatchScoreCard …/>` with one that wraps it:
```tsx
                      return (
                        <SelectableCard
                          key={item.id}
                          id={item.id}
                          selectMode={browseSelection.selectMode}
                          selected={browseSelection.isSelected(item.id)}
                          selectable={browseSelection.canSelect(item.domain ?? '')}
                          onToggle={(id) => browseSelection.toggle(id, item.domain ?? '')}
                        >
                          <MatchScoreCard
                            schema={schema!}
                            schemaDescription={domainDescription}
                            domainLabel={domainLabel}
                            data={item.data}
                            actions={domainActions}
                            selectionMode={browseSelection.selectMode}
                            onAction={(type, actionSchema) =>
                              triggerAction(type, actionSchema, item.id)
                            }
                            localItem={myItem}
                            networkItem={fullItem || {
                              item_id: item.id,
                              item_network: network?.id || '',
                              item_domain: selectedDomain || '',
                              item_type: 'profile',
                              item_instance_url: null,
                              item_schema_url: null,
                              item_state: item.data,
                              item_latitude: null,
                              item_longitude: null,
                              created_at: new Date().toISOString(),
                              updated_at: new Date().toISOString(),
                            }}
                          />
                        </SelectableCard>
                      );
```
> `item` here is the `CardItem` (`{ id, domain, data }`) produced by `itemToCardItem`, so `item.domain` is the lock group key.

- [ ] **Step 5: Make the single-domain `CardGrid` selectable**

The single-domain branch (lines 827-842) uses `CardGrid`, which renders its own cards internally. To keep changes contained, wrap with selection at the `CardGrid` call by passing selection props through. Replace the `<CardGrid …/>` block with a selection-aware grid that renders `MatchScoreCard`/`DomainCard` directly is heavier; instead pass three new optional props to `CardGrid` and have it wrap each card.

Add to `apps/ui/src/components/cards/card-grid.tsx` `CardGridProps` (after `selectedDomain?: string | null;`):
```ts
  selectedDomain?: string | null;
  /** Selection mode passthrough (browse bulk connect). */
  selection?: {
    selectMode: boolean;
    isSelected: (id: string) => boolean;
    canSelect: (groupKey?: string) => boolean;
    toggle: (id: string, groupKey?: string) => void;
  };
```

In `card-grid.tsx`, import the wrapper at top:
```ts
import { SelectableCard } from '@/components/selection/selectable-card';
```

Find where each item's card is rendered (the `.map` that returns `<MatchScoreCard>`/`<DomainCard>` around lines 84-101) and wrap the returned element:
```tsx
        return (
          <SelectableCard
            key={item.id}
            id={item.id}
            selectMode={selection?.selectMode ?? false}
            selected={selection?.isSelected(item.id) ?? false}
            selectable={selection?.canSelect(selectedDomain ?? '') ?? true}
            onToggle={(id) => selection?.toggle(id, selectedDomain ?? '')}
          >
            {cardElement}
          </SelectableCard>
        );
```
where `cardElement` is the existing `<MatchScoreCard …/>` or `<DomainCard …/>` (assign it to a const first), and pass `selectionMode={selection?.selectMode ?? false}` into that card element.

> Read `card-grid.tsx` lines 60-121 before editing to match its exact map/return shape; the change is: (a) compute the card element as today but add `selectionMode`, (b) wrap it in `SelectableCard`. Single domain → `selectedDomain` is the lock group, identical for every card, so the lock is a no-op.

Then in `home-page.tsx`, pass `selection` to the single-domain `CardGrid` (after line 841 `selectedDomain={selectedDomain}`):
```tsx
                selectedDomain={selectedDomain}
                selection={browseSelection}
```

- [ ] **Step 6: Render the bulk bar + bulk ActionModal**

Inside the `viewMode === 'list'` branch, after the `</ActionHandler>` close (around line 845), add the bulk bar and modal. The connect action for the locked domain:
```tsx
          {browseSelection.selectMode && (() => {
            const lockDomain = browseSelection.lockKey ?? selectedDomain ?? '';
            const connectAction = lockDomain ? getActionsForDomain(lockDomain)[0] : undefined;
            return (
              <>
                <BulkActionBar
                  count={browseSelection.selected.size}
                  onClear={browseSelection.clear}
                >
                  <button
                    type="button"
                    disabled={!connectAction || bulkConnectBusy}
                    onClick={() => setBulkConnectOpen(true)}
                    className="rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
                  >
                    {t('home.bulk_connect_all', { count: browseSelection.selected.size })}
                  </button>
                </BulkActionBar>
                {connectAction && (
                  <ActionModal
                    open={bulkConnectOpen}
                    onOpenChange={(open) => !open && setBulkConnectOpen(false)}
                    actionSchema={connectAction}
                    loading={bulkConnectBusy}
                    onSubmit={(formData) => handleBulkConnect(connectAction.action_type, formData)}
                  />
                )}
              </>
            );
          })()}
```

- [ ] **Step 7: Implement `handleBulkConnect`**

Add this callback in the component body (near `getActionsForDomain`, after line ~430). It mirrors the single `onActionSubmit` logic but builds one payload per selected id and calls `performActionsBulk`:
```tsx
  const handleBulkConnect = React.useCallback(
    async (actionType: string, formData: Record<string, unknown>) => {
      if (!myItem || !network) return;
      setBulkConnectBusy(true);
      try {
        const allItems = Object.values(domainItems).flat();
        const ids = Array.from(browseSelection.selected);

        const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
        const consent =
          consentRaw &&
          typeof consentRaw === 'object' &&
          (consentRaw as { acknowledged?: unknown }).acknowledged === true &&
          typeof (consentRaw as { text?: unknown }).text === 'string'
            ? { acknowledged: true as const, text: (consentRaw as { text: string }).text }
            : undefined;

        const sourceItemInstanceUrl = myItem.item_instance_url?.includes('localhost')
          ? apiConfig.getUrl()
          : resolveTargetInstanceUrl(myItem, network, apiConfig.getUrl(), 'source');

        // Build payloads in id order so envelope results[i] maps back to ids[i].
        const payloads = ids
          .map((id) => allItems.find((i) => i.item_id === id))
          .filter((t): t is Item => !!t)
          .map((targetItem) => {
            const targetItemInstanceUrl = targetItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()
              : resolveTargetInstanceUrl(targetItem, network, apiConfig.getUrl(), 'target');
            return {
              action_type: actionType,
              source_item: {
                item_network: myItem.item_network,
                item_domain: myItem.item_domain,
                item_type: myItem.item_type,
                item_id: myItem.item_id,
              },
              target_item: {
                item_network: targetItem.item_network,
                item_domain: targetItem.item_domain,
                item_type: targetItem.item_type,
                item_id: targetItem.item_id,
                item_instance_url: targetItemInstanceUrl,
              },
              requirements_snapshot: requirementsSnapshot,
              ...(consent ? { consent } : {}),
            };
          });

        const env = await performActionsBulk(payloads, sourceItemInstanceUrl);
        setBulkConnectOpen(false);

        if (env.summary.failed === 0) {
          toast.success(t('home.bulk_connected_all', { count: env.summary.succeeded }));
          browseSelection.exitSelect();
        } else {
          const failedIdxs = new Set(
            env.results.filter((r) => r.status === 'error').map((r) => r.index),
          );
          const failedIds = ids.filter((_, i) => failedIdxs.has(i));
          const firstErr = env.results.find((r) => r.status === 'error');
          toast.warning(
            t('home.bulk_connected_partial', {
              succeeded: env.summary.succeeded,
              total: env.summary.total,
            }),
            {
              description:
                firstErr && firstErr.status === 'error'
                  ? t('home.bulk_connect_first_error', { message: firstErr.message })
                  : undefined,
            },
          );
          browseSelection.setSelected(failedIds);
        }
      } catch (err) {
        toast.error(t('home.bulk_connect_failed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBulkConnectBusy(false);
      }
    },
    [myItem, network, domainItems, browseSelection, t],
  );
```
> `resolveTargetInstanceUrl`, `apiConfig`, `ACTION_CONSENT_SENTINEL`, `domainItems`, `getActionsForDomain` are all already in scope (confirmed in the current file). Verify `resolveTargetInstanceUrl` is imported — it is used at lines 718/724 already.

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Manual check**

1. Sign in with a profile. On a single-domain tab, click **Select** → cards become click-targets (buttons hidden), header button shows **Done**.
2. Click two cards → ring + check appear; sticky bar shows "2 selected · Clear · Connect (2)".
3. Click **Connect** → the shared requirements form + consent opens once; submit → success toast; selection exits.
4. On the **All** tab, select a Provider card → Seeker cards dim (non-selectable) until Clear.
5. As a guest (signed out) the **Select** button is absent.

- [ ] **Step 10: Commit**

```bash
git add apps/ui/src/pages/home-page.tsx apps/ui/src/components/cards/card-grid.tsx
git commit -m "feat(ui): bulk connect on Browse via card selection"
```

---

## Task 8: `BulkStatusDialog` (accept / reject / cancel confirm)

One confirm dialog for a selection of actions, with a shared optional reason for reject and shared consent when the interaction requires it.

**Files:**
- Create: `apps/ui/src/components/actions/bulk-status-dialog.tsx`

- [ ] **Step 1: Create the component**

```tsx
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Action } from '@/lib/action-api';
import { useUpdateActionStatusBulk } from '@/hooks/use-actions';
import { useNetworkConfig } from '@/hooks/use-network-config';
import { ConsentCheckbox } from './consent-checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface BulkStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected actions to update. */
  actions: Action[];
  /** Target status: 'accepted' | 'rejected' | 'cancelled'. */
  targetStatus: string;
  /** Called after the bulk call settles (so the page can clear selection). */
  onSettled: (succeeded: number, total: number, failedIds: string[]) => void;
}

export function BulkStatusDialog({
  open,
  onOpenChange,
  actions,
  targetStatus,
  onSettled,
}: BulkStatusDialogProps) {
  const { t } = useTranslation();
  const { mutateAsync, isPending } = useUpdateActionStatusBulk();
  const [remarks, setRemarks] = React.useState('');
  const [consentChecked, setConsentChecked] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setRemarks('');
      setConsentChecked(false);
    }
  }, [open]);

  // Resolve consent text from the first action's network config (the selection
  // is homogeneous in practice — same action_type within a tab).
  const first = actions[0] ?? null;
  const { data: networkConfig } = useNetworkConfig(first?.target_item_network ?? null);

  const interaction = React.useMemo(() => {
    if (!networkConfig || !first) return null;
    const actionDef = networkConfig.actions?.[first.action_type];
    if (!actionDef) return null;
    return (
      (actionDef.interactions ?? []).find((i) => {
        const fromNet = i.from_network ?? networkConfig.id;
        const toNet = i.to_network ?? networkConfig.id;
        return (
          fromNet === first.source_item_network &&
          i.from_domain === first.source_item_domain &&
          toNet === first.target_item_network &&
          i.to_domain === first.target_item_domain
        );
      }) ?? null
    );
  }, [networkConfig, first]);

  const revealStatuses = interaction?.reveals_pii_on_status ?? [];
  const consentText = (interaction?.consent_text_receiver ?? '').trim();
  const requiresConsent = revealStatuses.includes(targetStatus) && consentText !== '';

  const titleKey =
    targetStatus === 'accepted'
      ? 'actions.bulk_confirm_accept_title'
      : targetStatus === 'rejected'
        ? 'actions.bulk_confirm_reject_title'
        : 'actions.bulk_confirm_cancel_title';

  const handleConfirm = async () => {
    const ids = actions.map((a) => a.action_id);
    const sharedRemarks = remarks.trim();
    const payloads = ids.map((action_id) => ({
      action_id,
      action_status: targetStatus,
      ...(requiresConsent
        ? { consent: { acknowledged: true as const, text: consentText } }
        : sharedRemarks
          ? { remarks: sharedRemarks }
          : {}),
    }));

    try {
      const env = await mutateAsync(payloads);
      const failedIdxs = new Set(
        env.results.filter((r) => r.status === 'error').map((r) => r.index),
      );
      const failedIds = ids.filter((_, i) => failedIdxs.has(i));
      if (env.summary.failed === 0) {
        toast.success(t('actions.bulk_done_all', { count: env.summary.succeeded }));
      } else {
        toast.warning(
          t('actions.bulk_done_partial', {
            succeeded: env.summary.succeeded,
            total: env.summary.total,
          }),
        );
      }
      onOpenChange(false);
      onSettled(env.summary.succeeded, env.summary.total, failedIds);
    } catch (err) {
      toast.error(t('actions.bulk_failed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const confirmDisabled = isPending || (requiresConsent && !consentChecked) || actions.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] gap-0 p-6">
        <h2 className="text-lg font-bold">{t(titleKey, { count: actions.length })}</h2>
        <div className="py-4">
          {requiresConsent ? (
            <ConsentCheckbox
              text={consentText}
              checked={consentChecked}
              onCheckedChange={setConsentChecked}
            />
          ) : targetStatus === 'rejected' ? (
            <div className="space-y-2">
              <Label htmlFor="bulk-reason">{t('actions.bulk_reason_label')}</Label>
              <Textarea
                id="bulk-reason"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder={t('actions.bulk_reason_placeholder')}
              />
            </div>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={confirmDisabled} className="min-w-[120px] font-semibold">
            {isPending ? t('actions.btn_updating') : t('actions.bulk_confirm_btn')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/components/actions/bulk-status-dialog.tsx
git commit -m "feat(ui): BulkStatusDialog for bulk accept/reject/cancel"
```

---

## Task 9: My Actions bulk selection wiring

Select toggle in `ActionList`, wrap each `ActionCard`, compute `selectable` from status per tab, bulk bar (Received → Accept/Reject; Initiated → Cancel), and the confirm dialog.

**Files:**
- Modify: `apps/ui/src/components/actions/action-list.tsx`
- Modify: `apps/ui/src/pages/my-actions-page.tsx`

- [ ] **Step 1: Extend `ActionListProps` and render selection**

In `apps/ui/src/components/actions/action-list.tsx`, add imports:
```ts
import { CheckSquare } from 'lucide-react';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import type { CardSelection } from '@/hooks/use-card-selection';
```

Add to `ActionListProps` (after line 19 `isRefetching: boolean;`):
```ts
  isRefetching: boolean;
  /** Selection state owned by the page (drives bulk accept/reject/cancel). */
  selection: CardSelection;
  /** Open the bulk confirm dialog for the given target status. */
  onBulkAction: (targetStatus: string) => void;
```

Add `selection, onBulkAction` to the destructure (after line 43 `isRefetching,`):
```ts
  isRefetching,
  selection,
  onBulkAction,
```

In the toolbar row (after the filter chips `</div>` on line 88, before the Refresh `Button`), add the Select toggle:
```tsx
        <Button
          variant={selection.selectMode ? 'default' : 'outline'}
          size="sm"
          onClick={() => (selection.selectMode ? selection.exitSelect() : selection.enterSelect())}
        >
          <CheckSquare className="mr-2 h-4 w-4" />
          {selection.selectMode ? t('selection.done') : t('selection.select')}
        </Button>
```

Wrap each `ActionCard` in the grid (lines 163-172). An action is `selectable` only when actionable for its tab (pending; cancel applies to initiated, accept/reject to received). Replace the `.map`:
```tsx
          {visible.map((action) => {
            const isPending =
              action.action_status === 'created' || action.action_status === 'pending';
            return (
              <SelectableCard
                key={action.action_id}
                id={action.action_id}
                selectMode={selection.selectMode}
                selected={selection.isSelected(action.action_id)}
                selectable={isPending}
                onToggle={(id) => selection.toggle(id, activeTab)}
              >
                <ActionCard
                  action={action}
                  ownershipRole={activeTab}
                  onStatusUpdate={onStatusUpdate}
                  selectionMode={selection.selectMode}
                />
              </SelectableCard>
            );
          })}
```

After the grid `</div>` that closes the content block (after line 173), add the bulk bar:
```tsx
      {selection.selectMode && selection.selected.size > 0 && (
        <BulkActionBar count={selection.selected.size} onClear={selection.clear}>
          {activeTab === 'received' ? (
            <>
              <button
                type="button"
                onClick={() => onBulkAction('rejected')}
                className="rounded-lg bg-background px-4 py-1.5 text-xs font-bold text-red-600"
              >
                {t('actions.bulk_reject')}
              </button>
              <button
                type="button"
                onClick={() => onBulkAction('accepted')}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white"
              >
                {t('actions.bulk_accept')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onBulkAction('cancelled')}
              className="rounded-lg bg-background px-4 py-1.5 text-xs font-bold text-red-600"
            >
              {t('actions.bulk_cancel')}
            </button>
          )}
        </BulkActionBar>
      )}
```

> The reason note is collected in the dialog (Task 8), not here. Clear selection when switching tabs (next step).

- [ ] **Step 2: Wire selection + dialog in `my-actions-page.tsx`**

In `apps/ui/src/pages/my-actions-page.tsx`, add imports:
```ts
import { useCardSelection } from '@/hooks/use-card-selection';
import { BulkStatusDialog } from '@/components/actions/bulk-status-dialog';
```

Add state in the component (after line 19):
```tsx
  const selection = useCardSelection();
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkStatus, setBulkStatus] = React.useState<string>('');
```

Clear selection when the tab changes — wrap `setActiveTab`:
```tsx
  const handleTabChange = (tab: TabValue) => {
    selection.exitSelect();
    setActiveTab(tab);
  };
```

Compute the selected `Action[]` for the dialog:
```tsx
  const sourceActions = activeTab === 'initiated' ? initiatedActions : receivedActions;
  const selectedActions = sourceActions.filter((a) => selection.selected.has(a.action_id));
```

Pass props to `ActionList` (replace the `onTabChange` line 107 and add the two new props):
```tsx
          onTabChange={handleTabChange}
          onStatusUpdate={(action, targetStatus) => handleStatusUpdate(action, targetStatus)}
          onRefresh={handleRefresh}
          isRefetching={isRefetching}
          selection={selection}
          onBulkAction={(targetStatus) => {
            setBulkStatus(targetStatus);
            setBulkOpen(true);
          }}
```

Add the dialog after `<ActionStatusUpdater …/>` (after line 119):
```tsx
      <BulkStatusDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        actions={selectedActions}
        targetStatus={bulkStatus}
        onSettled={(_succeeded, _total, failedIds) => {
          if (failedIds.length === 0) selection.exitSelect();
          else selection.setSelected(failedIds);
        }}
      />
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual check**

1. Open My Actions → Received. Click **Select**; only Pending cards are selectable, others dim.
2. Select 2 pending → bar shows "2 selected · Reject · Accept".
3. **Accept** → confirm dialog (consent if required) → confirm → toast, list refreshes, selection clears.
4. **Reject** → dialog shows reason note → confirm → applied to all.
5. Switch to Initiated → selection resets; pending cards selectable → bar shows **Cancel requests**.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/actions/action-list.tsx apps/ui/src/pages/my-actions-page.tsx
git commit -m "feat(ui): bulk accept/reject/cancel on My Actions"
```

---

## Task 10: Redesign `MarkerPopupCard`

Presentational Option-B card: branded gradient header (dynamic `--primary`), schema-driven fields, Connect + See Match Score (embeds `useMatchScore` + `MatchScoreModal`). All new props optional → default render path still works for callers that don't pass them.

**Files:**
- Modify: `apps/ui/src/components/map/marker-popup-card.tsx`

- [ ] **Step 1: Rewrite the component**

Replace the entire contents of `apps/ui/src/components/map/marker-popup-card.tsx` with:

```tsx
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Plug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MapMarker, DotActionSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useMatchScore } from '@/hooks/use-match-score';
import { MatchScoreModal } from '@/components/match-score/match-score-modal';

const HIDDEN_KEYS = new Set(['item_latitude', 'item_longitude', 'item_domain']);

interface PrecisionInfo {
  labelKey: string;
}

export function getPrecisionInfo(precision: string): PrecisionInfo {
  switch (precision) {
    case 'exact':
      return { labelKey: 'map.precision.exact' };
    case 'geocoded_pincode':
      return { labelKey: 'map.precision.pincode' };
    case 'geocoded_full_address':
      return { labelKey: 'map.precision.full_address' };
    case 'geocoded_city_only':
      return { labelKey: 'map.precision.city' };
    default:
      return { labelKey: 'map.precision.unknown' };
  }
}

function getInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

interface MarkerPopupCardProps {
  marker: MapMarker;
  onViewDetails?: (id: string) => void;
  /** Connect action(s) available for this marker's domain (first is used). */
  actions?: DotActionSchema[];
  /** Initiate the connect flow for this marker. */
  onConnect?: () => void;
  /** Local (own) profile item — required for match score. */
  localItem?: Item | null;
  /** Full network Item for this marker — required for match score. */
  networkItem?: Item | null;
}

export function MarkerPopupCard({
  marker,
  onViewDetails,
  actions = [],
  onConnect,
  localItem,
  networkItem,
}: MarkerPopupCardProps) {
  const { t } = useTranslation();
  const initials = getInitials(marker.label);
  const precisionInfo = getPrecisionInfo(marker.precision);
  const [modalOpen, setModalOpen] = React.useState(false);

  const canMatch = !!localItem && !!networkItem;
  const canConnect = actions.length > 0 && !!onConnect;

  const { score, isLoading, calculate, recalculate } = useMatchScore({
    localItem: localItem ?? null,
    networkItem: networkItem ?? ({ item_id: marker.id, item_state: marker.data } as Item),
  });

  const fields = Object.entries(marker.data)
    .filter(([key]) => !key.startsWith('_') && !HIDDEN_KEYS.has(key))
    .slice(0, 4);

  return (
    <div className="w-[300px] overflow-hidden rounded-2xl bg-background text-foreground shadow-sm">
      {/* Branded header — colour is the per-network theme var */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{
          background:
            'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))',
        }}
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/25 text-sm font-bold text-white">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-tight text-white">{marker.label}</p>
          {marker.domain && (
            <Badge className="mt-1 border-0 bg-white/25 px-1.5 py-0 text-[10px] font-semibold text-white hover:bg-white/25">
              {titleCase(marker.domain)}
            </Badge>
          )}
          <p className="mt-1 text-[10px] leading-none text-white/85">{t(precisionInfo.labelKey)}</p>
        </div>
      </div>

      {/* Fields (schema-driven; unchanged resolution from marker.data) */}
      {fields.length > 0 && (
        <div className="space-y-1.5 px-4 py-3">
          {fields.map(([key, val]) => (
            <div key={key} className="flex items-start gap-2 text-xs">
              <span className="w-[92px] shrink-0 font-medium text-muted-foreground">{titleCase(key)}</span>
              <span className="min-w-0 flex-1 break-words text-foreground">{String(val ?? '—')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Buttons */}
      {(canMatch || canConnect) ? (
        <div className="flex gap-2 px-4 pb-4 pt-1">
          {canMatch && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={isLoading}
              onClick={() => {
                if (!score) void calculate();
                setModalOpen(true);
              }}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {t('map.see_match_score')}
            </Button>
          )}
          {canConnect && (
            <Button size="sm" className="flex-1" onClick={onConnect}>
              <Plug className="mr-1.5 h-3.5 w-3.5" />
              {t('map.connect')}
            </Button>
          )}
        </div>
      ) : (
        onViewDetails && (
          <div className="px-4 pb-3">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs font-medium"
              onClick={() => onViewDetails(marker.id)}
            >
              {t('map.view_details')}
            </Button>
          </div>
        )
      )}

      {canMatch && (
        <MatchScoreModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          score={score}
          isLoading={isLoading}
          localItemName={String(localItem?.item_state?.name ?? 'Your Profile')}
          networkItemName={marker.label}
          onRecalculate={() => void recalculate()}
          onProceed={
            canConnect
              ? () => {
                  setModalOpen(false);
                  onConnect?.();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
```

> `DotActionSchema` is exported from `@/engine/types`. `Plug` and `Sparkles` are valid lucide icons. The component still exports `getPrecisionInfo` (no other module imports it, but keep the export to avoid churn).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual check**

The popup still renders via the default path (providers pass only `marker` + `onViewDetails`), so it shows the branded header + fields + a **View details** link (no Connect/Match yet — wired in Task 12). Confirm the header colour matches the network theme (purple_dot purple). Switch network (or `?network=`) and confirm the header recolours.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/map/marker-popup-card.tsx
git commit -m "feat(ui): redesign map popup (branded header, dynamic colour)"
```

---

## Task 11: `renderPopup` render-prop threading

Add an optional `renderPopup` to the provider contract and `MapView`; both providers fall back to the default popup when absent.

**Files:**
- Modify: `apps/ui/src/engine/types.ts:142-150`
- Modify: `apps/ui/src/components/map/map-container.tsx`
- Modify: `apps/ui/src/components/map/providers/leaflet-provider.tsx:296-302`
- Modify: `apps/ui/src/components/map/providers/google-maps-provider.tsx:208-215`

- [ ] **Step 1: Add `renderPopup` to `MapProviderProps`**

In `apps/ui/src/engine/types.ts`, change the `MapProviderProps` interface (lines 142-150) to add:
```ts
export interface MapProviderProps {
  center: [number, number];
  zoom: number;
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  /** When true, the provider should NOT auto-fit bounds on first render */
  initialViewSet?: boolean;
  children?: React.ReactNode;
  /** Optional custom popup renderer; falls back to the default MarkerPopupCard. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
}
```

- [ ] **Step 2: Forward `renderPopup` through `MapView`**

In `apps/ui/src/components/map/map-container.tsx`, add to `MapViewProps` (after `filtersSlot?: React.ReactNode;` on line 36):
```ts
  filtersSlot?: React.ReactNode;
  /** Optional custom popup renderer passed to the active provider. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
```

Add `renderPopup` to the destructured props (after `filtersSlot,` on line 50):
```ts
  filtersSlot,
  renderPopup,
```

Pass it to the provider (in the `<MapProviderComponent …/>` block, after `initialViewSet={initialViewSet}` on line 197):
```tsx
        initialViewSet={initialViewSet}
        renderPopup={renderPopup}
```

- [ ] **Step 3: Leaflet provider fallback**

In `apps/ui/src/components/map/providers/leaflet-provider.tsx`, add `renderPopup` to the destructured props (line 239-245 function signature):
```tsx
export function LeafletMapProvider({
  center,
  zoom,
  markers,
  onMarkerClick,
  initialViewSet = false,
  renderPopup,
}: MapProviderProps) {
```

Change the `<Popup>` content (lines 297-302):
```tsx
              <Popup>
                {renderPopup ? (
                  renderPopup(marker)
                ) : (
                  <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
                )}
              </Popup>
```

- [ ] **Step 4: Google provider fallback**

In `apps/ui/src/components/map/providers/google-maps-provider.tsx`:

Add `renderPopup` to `ClusteredMarkerProps` (after `onMarkerReady` on line 140):
```ts
  onMarkerReady: (id: string, el: NonNullable<AdvancedMarkerRef> | null) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
```

Destructure it in `ClusteredMarker` (after `onMarkerReady,` on line 149) and use it in the `InfoWindow` (lines 208-215):
```tsx
      {isActive && markerEl && (
        <InfoWindow anchor={markerEl} onCloseClick={onClose}>
          {renderPopup ? (
            renderPopup(marker)
          ) : (
            <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
          )}
        </InfoWindow>
      )}
```

Thread `renderPopup` from `GoogleMapProvider` → `ClustererManager` → `ClusteredMarker`:
- Add `renderPopup` to `GoogleMapProvider`'s destructure (after `initialViewSet = false,` ~line 363).
- Add `renderPopup?: (marker: MapMarker) => React.ReactNode;` to `ClustererManagerProps` (after `onMarkerClick?` ~line 271) and destructure it (~line 279).
- Pass `renderPopup={renderPopup}` to `<ClustererManager …/>` (~line 405-411) and to `<ClusteredMarker …/>` (~line 342-350).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/engine/types.ts apps/ui/src/components/map/map-container.tsx apps/ui/src/components/map/providers/leaflet-provider.tsx apps/ui/src/components/map/providers/google-maps-provider.tsx
git commit -m "feat(ui): renderPopup render-prop on map providers"
```

---

## Task 12: Hoist `ActionHandler` + wire `renderPopup` in home-page

Wrap both list and map in one `ActionHandler` so the map popup can call `triggerAction`; supply `renderPopup` that resolves each marker's actions + match-score data.

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`

- [ ] **Step 1: Move `ActionHandler` to wrap both views**

Currently (lines 678-857) the structure is:
```tsx
      {viewMode === 'list' ? (
        <ActionHandler onActionSubmit={…}>
          {(triggerAction) => /* list */}
        </ActionHandler>
      ) : (
        <MapView … />
      )}
```

Restructure so `ActionHandler` wraps both, and the `triggerAction` is available to both branches:
```tsx
      <ActionHandler
        onActionSubmit={async (actionType, _actionSchema, formData, targetItemId) => {
          /* …existing onActionSubmit body, unchanged… */
        }}
      >
        {(triggerAction) =>
          viewMode === 'list' ? (
            <>
              {/* …existing list branch (All tab + single-domain) + bulk bar/modal from Task 7… */}
            </>
          ) : (
            <MapView
              schema={activeSchema!}
              items={Object.values(filteredDomainItems).flat()}
              focusPoint={
                myItem && myItem.item_latitude != null && myItem.item_longitude != null
                  ? { lat: myItem.item_latitude, lng: myItem.item_longitude }
                  : null
              }
              filtersSlot={filtersPanel}
              renderPopup={(marker) => {
                const fullItem = Object.values(domainItems)
                  .flat()
                  .find((i) => i.item_id === marker.id) ?? null;
                const domainActions = marker.domain ? getActionsForDomain(marker.domain) : [];
                const connectAction = domainActions[0];
                return (
                  <MarkerPopupCard
                    marker={marker}
                    onViewDetails={undefined}
                    actions={myItem && connectAction ? [connectAction] : []}
                    onConnect={
                      myItem && connectAction
                        ? () => triggerAction(connectAction.action_type, connectAction, marker.id)
                        : undefined
                    }
                    localItem={myItem}
                    networkItem={fullItem}
                  />
                );
              }}
            />
          )
        }
      </ActionHandler>
```

> Keep the existing `onActionSubmit` body verbatim — it already resolves source/target instance URLs and calls `performAction` for the single-target case used by the popup's Connect. Move the Task-7 bulk bar/modal inside the `list` branch's fragment.

- [ ] **Step 2: Import `MarkerPopupCard`**

Add to imports in `home-page.tsx`:
```tsx
import { MarkerPopupCard } from '@/components/map/marker-popup-card';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual check**

1. Sign in with a profile, switch to **Map** view, click a marker → popup shows branded header + fields + **See Match Score** + **Connect**.
2. **Connect** → opens the requirements form + consent (same single-connect flow) → submit → success toast.
3. **See Match Score** → calculates and opens the match modal; **Proceed** → opens Connect.
4. As a guest, the popup shows fields + **View details** only (no Connect/Match).
5. Switch network → popup header recolours to that network's `--primary`.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/home-page.tsx
git commit -m "feat(ui): wire Connect + Match Score into map popup"
```

---

## Task 13: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole UI**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Build**

Run: `pnpm --filter ui build`
Expected: build succeeds (tsc + vite build).

- [ ] **Step 3: End-to-end manual checklist**

With services running (`pnpm dev:api` + `pnpm dev:ui`) and signed in with a profile:

- Browse single-domain: Select → pick 3 → Connect all → shared form → success; DB/My-Actions shows 3 new initiated.
- Browse All tab: domain lock dims the other domain; bulk connect works for the locked domain.
- Force a partial failure (e.g. select one already-connected target): toast reads "Connected X of N", failed card stays selected.
- My Actions Received: bulk Accept (consent if required) and bulk Reject (with shared note); verify statuses update.
- My Actions Initiated: bulk Cancel pending requests.
- Map popup: Connect + See Match Score work; guest sees View details only; header colour is theme-dynamic.
- Guest (signed out) Browse: no Select toggle.
- `?lang=hi` and `?lang=kn`: all new buttons/toasts render translated.

- [ ] **Step 4: Codacy (per CLAUDE.md)**

Per repo rule, run `codacy_cli_analyze` on the edited files (skip complexity/coverage). Fix any flagged issues.

---

## Self-Review

**Spec coverage:**
- Selection primitives (hook / SelectableCard / BulkActionBar) → Tasks 2-4. ✔
- `selectionMode` hiding card footers → Task 6. ✔
- Bulk API clients (envelope, partial) → Task 5. ✔
- Browse bulk connect, single + All tab, domain lock, shared form, gate on `myItem` → Task 7. ✔
- My Actions bulk accept/reject/cancel, only-actionable selectable, shared note/consent → Tasks 8-9. ✔
- Map popup redesign (Option B, dynamic colour, schema fields untouched, Connect + Match) → Task 10. ✔
- `renderPopup` threading + ActionHandler hoist → Tasks 11-12. ✔
- i18n all three locales → Task 1. ✔
- Constraints: schema-driven fields preserved (Task 10 keeps `marker.data` filtering); Select gated on `myItem` (Task 7 Step 3) → ✔
- Partial-result (207) handling → Tasks 7 & 8. ✔

**Type consistency:** `CardSelection` shape (Task 2) is consumed identically in Tasks 7/9; `performActionsBulk`/`updateActionStatusBulk` signatures (Task 5) match call sites; `BulkEnvelope` results carry `index`/`status` used by failure-mapping in Tasks 7/8; `MarkerPopupCardProps` (Task 10) matches the `renderPopup` call in Task 12; `renderPopup` signature `(marker: MapMarker) => React.ReactNode` is identical across types/MapView/both providers.

**Placeholder scan:** No TBD/TODO; every code step shows the code. The two "read the exact shape before editing" notes (card-grid map in Task 7 Step 5; google provider threading in Task 11 Step 4) point at concrete line ranges and describe the exact change — the implementer must open those spots because the surrounding JSX is larger than is worth transcribing, but the transformation is fully specified.
