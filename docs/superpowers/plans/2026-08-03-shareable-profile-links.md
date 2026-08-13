# Shareable Profile Links + Public Profile View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users copy a shareable link from a live profile card and let anyone open that link (unauthenticated) to see the profile on a public, masked view page.

**Architecture:** UI-only for v1 — no backend change. The Share button copies `${origin}/p/<network>/<domain>/<item_type>/<item_id>?network=<network>` (the `?network=` drives theming). A new unauthenticated route `/p/:network/:domain/:itemType/:itemId` renders a `PublicProfilePage` that fetches the one profile via the existing `useItemDetail` hook (which calls the public, masked, jittered, live-only `GET /api/v1/network/item/fetch`) and renders it with the existing `DomainCard`. Live item → render; empty/error → an "unavailable"/"error" page.

**Tech Stack:** React 19, TypeScript, Vite SPA, `react-router-dom` v7, `@tanstack/react-query`, `react-i18next`, `sonner` (toasts), `lucide-react` (icons), Vitest + `@testing-library/react`.

## Global Constraints

- **Worktree / branch:** work only in `/Users/srivastha/KKB/Github/Signals-DPG.worktrees/shareable-profile-links` on branch `feat/shareable-profile-links`. Do not touch other worktrees.
- **UI-only, no backend / no deploy config change.** Reuse `GET /api/v1/network/item/fetch` via `useItemDetail`. The nginx SPA fallback (`apps/ui/Dockerfile` `try_files $uri /index.html`) already serves deep links.
- **Link format = raw key** (no token store). Build via `buildProfileShareUrl`, always including `?network=<network>`.
- **Share button only when `lifecycle_status === 'live'`.** No owner opt-in, no minor gating.
- **Recipient states are binary + transient-error:** live → render; empty (paused/retired/draft/gone) → "unavailable"; API error → "something went wrong / try again"; loading → skeleton. Never surface a raw error or PII.
- **Public page shows only the masked `item_state`** (the reused endpoint never returns `item_private_state`; locations are jittered at storage). No contact/PII on the page.
- **i18n:** every user-facing string uses `t('key', 'English default')` and adds the key to all three locales: `apps/ui/src/i18n/locales/{en,hi,kn}.json` (flat dotted-key JSON objects).
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Run a single UI test file:** `pnpm --filter ui exec vitest run <path>` (from repo root). Full UI suite: `pnpm --filter ui test`. Typecheck: `pnpm --filter ui exec tsc --noEmit`.

---

## File Structure

**Create:**
- `apps/ui/src/lib/share-profile.ts` — `buildProfileShareUrl(item, origin?)` + `copyTextToClipboard(text)`.
- `apps/ui/src/lib/__tests__/share-profile.test.ts` — tests for both utils.
- `apps/ui/src/components/share/share-profile-button.tsx` — `ShareProfileButton` (live-gated, copies + toasts).
- `apps/ui/src/components/share/__tests__/share-profile-button.test.tsx` — tests.
- `apps/ui/src/pages/public-profile-page.tsx` — `PublicProfilePage` + its sub-states.
- `apps/ui/src/pages/__tests__/public-profile-page.test.tsx` — tests.

**Modify:**
- `apps/ui/src/components/cards/item-card.tsx` — add `headerAction?: React.ReactNode` prop + render it top-right of the header.
- `apps/ui/src/components/cards/domain-card.tsx` — add `shareItem?: Item | null` prop; pass a `ShareProfileButton` into `ItemCard`'s `headerAction`.
- `apps/ui/src/pages/home-page.tsx` — pass `shareItem={item}` to the list-grid `DomainCard`.
- `apps/ui/src/components/layout/profile-row-actions.tsx` — render `ShareProfileButton` in the row.
- `apps/ui/src/hooks/use-item-detail.ts` — expose `isError` (additive).
- `apps/ui/src/app.tsx` — add the public route.
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — new `share.*` and `public_profile.*` keys.

---

## Task 1: Share utilities (`buildProfileShareUrl`, `copyTextToClipboard`)

**Files:**
- Create: `apps/ui/src/lib/share-profile.ts`
- Test: `apps/ui/src/lib/__tests__/share-profile.test.ts`

**Interfaces:**
- Consumes: `Item` from `@/lib/item-api` (uses only `item_network`, `item_domain`, `item_type`, `item_id`).
- Produces:
  - `buildProfileShareUrl(item: Pick<Item, 'item_network'|'item_domain'|'item_type'|'item_id'>, origin?: string): string`
  - `copyTextToClipboard(text: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/lib/__tests__/share-profile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProfileShareUrl, copyTextToClipboard } from '../share-profile';

const item = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: '9b545eb9-5406-4bce-bc71-0cdac4b63bd0',
};

describe('buildProfileShareUrl', () => {
  it('builds a /p/<network>/<domain>/<type>/<id>?network= URL from the given origin', () => {
    expect(buildProfileShareUrl(item, 'https://signals.example.org')).toBe(
      'https://signals.example.org/p/blue_dot/seeker/profile_1.0/9b545eb9-5406-4bce-bc71-0cdac4b63bd0?network=blue_dot',
    );
  });

  it('defaults the origin to window.location.origin', () => {
    // jsdom origin is http://localhost:3000 by default
    expect(buildProfileShareUrl(item)).toContain('/p/blue_dot/seeker/profile_1.0/');
    expect(buildProfileShareUrl(item)).toContain('?network=blue_dot');
  });
});

describe('copyTextToClipboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    vi.unstubAllGlobals();
  });

  it('falls back to execCommand when the Clipboard API is absent', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn().mockReturnValue(true);
    // @ts-expect-error test shim
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/lib/__tests__/share-profile.test.ts`
Expected: FAIL — cannot find module `../share-profile`.

- [ ] **Step 3: Write the implementation**

Create `apps/ui/src/lib/share-profile.ts`:

```ts
import type { Item } from '@/lib/item-api';

/**
 * Canonical public share URL for a profile, built from its key.
 * Includes `?network=` because the network theme provider resolves the brand
 * from that query param (URL-wins), so a cold-loaded link renders in the
 * profile's own network theme. The path also carries the network for the fetch.
 */
export function buildProfileShareUrl(
  item: Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id'>,
  origin: string = window.location.origin,
): string {
  const seg = (s: string) => encodeURIComponent(s);
  const path = `/p/${seg(item.item_network)}/${seg(item.item_domain)}/${seg(item.item_type)}/${seg(item.item_id)}`;
  return `${origin}${path}?network=${seg(item.item_network)}`;
}

/**
 * Copy text to the clipboard. Prefers the async Clipboard API; falls back to a
 * hidden textarea + `execCommand('copy')` for browsers without it (or when the
 * Clipboard API rejects, e.g. permissions). Returns true on success.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/lib/__tests__/share-profile.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/share-profile.ts apps/ui/src/lib/__tests__/share-profile.test.ts
git commit -m "feat(ui): share-profile url builder + clipboard util (#476)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ShareProfileButton` component + i18n keys

**Files:**
- Create: `apps/ui/src/components/share/share-profile-button.tsx`
- Test: `apps/ui/src/components/share/__tests__/share-profile-button.test.tsx`
- Modify: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`

**Interfaces:**
- Consumes: `buildProfileShareUrl`, `copyTextToClipboard` (Task 1); `toast` from `sonner`; `Item` from `@/lib/item-api`.
- Produces: `ShareProfileButton({ item, className? })` — renders `null` unless `item?.lifecycle_status === 'live'`; on click copies the share URL and toasts.

- [ ] **Step 1: Add i18n keys**

Add to `apps/ui/src/i18n/locales/en.json` (alongside the other flat keys):

```json
  "share.button": "Share profile",
  "share.copied": "Link copied to clipboard",
  "share.copy_failed": "Could not copy the link",
```

Add to `apps/ui/src/i18n/locales/hi.json`:

```json
  "share.button": "प्रोफ़ाइल साझा करें",
  "share.copied": "लिंक क्लिपबोर्ड पर कॉपी हो गया",
  "share.copy_failed": "लिंक कॉपी नहीं हो सका",
```

Add to `apps/ui/src/i18n/locales/kn.json`:

```json
  "share.button": "ಪ್ರೊಫೈಲ್ ಹಂಚಿಕೊಳ್ಳಿ",
  "share.copied": "ಲಿಂಕ್ ಕ್ಲಿಪ್‌ಬೋರ್ಡ್‌ಗೆ ನಕಲಿಸಲಾಗಿದೆ",
  "share.copy_failed": "ಲಿಂಕ್ ನಕಲಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ",
```

- [ ] **Step 2: Write the failing test**

Create `apps/ui/src/components/share/__tests__/share-profile-button.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareProfileButton } from '../share-profile-button';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }));
const copyMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/share-profile', () => ({
  buildProfileShareUrl: () => 'https://x/p/blue_dot/seeker/profile_1.0/abc?network=blue_dot',
  copyTextToClipboard: (t: string) => copyMock(t),
}));

const liveItem = {
  item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0',
  item_id: 'abc', lifecycle_status: 'live' as const,
};

beforeEach(() => { toastSuccess.mockClear(); toastError.mockClear(); copyMock.mockClear(); });

describe('ShareProfileButton', () => {
  it('renders nothing for a missing item', () => {
    const { container } = render(<ShareProfileButton item={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a non-live profile', () => {
    const { container } = render(<ShareProfileButton item={{ ...liveItem, lifecycle_status: 'paused' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a button for a live profile and copies + toasts on click', async () => {
    render(<ShareProfileButton item={liveItem} />);
    const btn = screen.getByRole('button', { name: 'Share profile' });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith('https://x/p/blue_dot/seeker/profile_1.0/abc?network=blue_dot'),
    );
    expect(toastSuccess).toHaveBeenCalledWith('Link copied to clipboard');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/share/__tests__/share-profile-button.test.tsx`
Expected: FAIL — cannot find module `../share-profile-button`.

- [ ] **Step 4: Write the implementation**

Create `apps/ui/src/components/share/share-profile-button.tsx`:

```tsx
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Share2 } from 'lucide-react';
import type { Item } from '@/lib/item-api';
import { buildProfileShareUrl, copyTextToClipboard } from '@/lib/share-profile';

export interface ShareProfileButtonProps {
  /** The profile to share. The button renders only when this is a LIVE item. */
  item:
    | Pick<Item, 'item_network' | 'item_domain' | 'item_type' | 'item_id' | 'lifecycle_status'>
    | null
    | undefined;
  /** Optional button styling override (e.g. white on a coloured card header). */
  className?: string;
}

/**
 * Copy-link Share affordance shown ONLY on live profiles. Copies the canonical
 * public share URL and toasts success/failure. Renders null for a missing or
 * non-live item, so call sites can drop it in unconditionally.
 */
export function ShareProfileButton({ item, className }: ShareProfileButtonProps) {
  const { t } = useTranslation();
  if (!item || item.lifecycle_status !== 'live') return null;

  const onShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyTextToClipboard(buildProfileShareUrl(item));
    if (ok) toast.success(t('share.copied', 'Link copied to clipboard'));
    else toast.error(t('share.copy_failed', 'Could not copy the link'));
  };

  return (
    <button
      type="button"
      onClick={onShare}
      aria-label={t('share.button', 'Share profile')}
      title={t('share.button', 'Share profile')}
      className={
        className ??
        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
      }
    >
      <Share2 className="h-4 w-4" />
    </button>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/share/__tests__/share-profile-button.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/share/ apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): ShareProfileButton (live-only copy-link) + i18n (#476)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the Share button into the cards + own-profile row

**Files:**
- Modify: `apps/ui/src/components/cards/item-card.tsx`
- Modify: `apps/ui/src/components/cards/domain-card.tsx`
- Modify: `apps/ui/src/pages/home-page.tsx`
- Modify: `apps/ui/src/components/layout/profile-row-actions.tsx`
- Test: `apps/ui/src/components/cards/__tests__/item-card-header-action.test.tsx` (new)

**Interfaces:**
- Consumes: `ShareProfileButton` (Task 2); `Item` from `@/lib/item-api`.
- Produces: `ItemCard` gains `headerAction?: React.ReactNode`; `DomainCard` gains `shareItem?: Item | null`.

- [ ] **Step 1: Write the failing test (ItemCard renders `headerAction`)**

Create `apps/ui/src/components/cards/__tests__/item-card-header-action.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemCard } from '../item-card';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

describe('ItemCard headerAction slot', () => {
  it('renders the headerAction node in the header', () => {
    render(
      <ItemCard
        schema={{ type: 'object', properties: {} }}
        data={{ name: 'Asha' }}
        headerAction={<button data-testid="share-slot">share</button>}
      />,
    );
    expect(screen.getByTestId('share-slot')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/cards/__tests__/item-card-header-action.test.tsx`
Expected: FAIL — `headerAction` is not a prop; the slot node is not rendered.

- [ ] **Step 3: Add the `headerAction` prop to `ItemCard`**

In `apps/ui/src/components/cards/item-card.tsx`, add to `ItemCardProps` (after `actions`):

```ts
  /** Optional node rendered top-right of the coloured header (e.g. a Share button). */
  headerAction?: React.ReactNode;
```

Add `headerAction` to the destructured props of `ItemCard({ ... })` (next to `actions`).

In the header `<div style={{ background: HEADER_GRADIENT }}>` block, immediately **after** the `<div className="min-w-0"> ... </div>` (the title/badge block) and before the header `</div>`, add:

```tsx
        {headerAction && <div className="ml-auto shrink-0">{headerAction}</div>}
```

(The `ml-auto` pushes it to the top-right of the flex header.)

- [ ] **Step 4: Run the ItemCard test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/cards/__tests__/item-card-header-action.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add `shareItem` to `DomainCard` and pass a white Share button into the header**

In `apps/ui/src/components/cards/domain-card.tsx`:

Add the import:
```ts
import { ShareProfileButton } from '@/components/share/share-profile-button';
```

Add to `DomainCardProps` (after `selectionMode`):
```ts
  /** When live, shows a Share button in the card header. Full item (for its key). */
  shareItem?: Item | null;
```

Add `shareItem` to the destructured props.

Change the returned `<ItemCard ... />` to pass a `headerAction`:
```tsx
    <ItemCard
      variant="list"
      schema={schema}
      cardConfig={cardConfig}
      data={data}
      domainLabel={domainLabel}
      onClick={onClick}
      actions={footer}
      headerAction={
        <ShareProfileButton
          item={shareItem}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white hover:bg-white/25"
        />
      }
    />
```

(`ShareProfileButton` renders null unless `shareItem` is live, so the header stays clean for non-live/absent items.)

- [ ] **Step 6: Pass `shareItem` from the list grid in `home-page.tsx`**

In `apps/ui/src/pages/home-page.tsx`, in the list-grid map `allFlatItems.map(({ item, schema, domainActions, domainDescription, domainLabel, cardConfig }) => { ... })` (around line 2386), find the `<DomainCard ... />` render and add the prop:

```tsx
                                shareItem={item}
```

(There are two `<DomainCard>` usages in that block — the "All" tab and the single-domain tab, both around lines 2421 and 2436 with `cardConfig={cardConfig}`. Add `shareItem={item}` to each.)

- [ ] **Step 7: Add the Share button to the own-profile row**

In `apps/ui/src/components/layout/profile-row-actions.tsx`:

Add the import:
```ts
import { ShareProfileButton } from '@/components/share/share-profile-button';
```

In the returned `<div className="flex items-center gap-0.5">` action row, add `ShareProfileButton` as the first child (it self-gates to live, so it only shows on a live profile — matching `showPause`):

```tsx
      <ShareProfileButton item={profile} />
```

- [ ] **Step 8: Write + run a test for the own-profile row gating**

Append to `apps/ui/src/components/layout/__tests__/` a new file `profile-row-share.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileRowActions } from '../profile-row-actions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/item-api', () => ({ setItemLifecycle: vi.fn() }));
import { TooltipProvider } from '@/components/ui/tooltip';

const base = {
  item_id: 'abc', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0',
  item_instance_url: null, item_schema_url: null, item_state: {}, item_locations: [],
  created_at: '', updated_at: '',
};

function renderRow(status: 'live' | 'paused') {
  // ProfileRowActions uses Radix Tooltip for its icon buttons, which needs a
  // TooltipProvider ancestor; wrap so the row mounts in a test.
  return render(
    <TooltipProvider>
      <ProfileRowActions
        profile={{ ...base, lifecycle_status: status }}
        pauseEnabled
        onEdit={() => {}}
        onChanged={() => {}}
      />
    </TooltipProvider>,
  );
}

describe('ProfileRowActions Share button', () => {
  it('shows Share on a live profile', () => {
    renderRow('live');
    expect(screen.getByRole('button', { name: 'Share profile' })).toBeInTheDocument();
  });
  it('hides Share on a paused profile', () => {
    renderRow('paused');
    expect(screen.queryByRole('button', { name: 'Share profile' })).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter ui exec vitest run src/components/cards/__tests__/item-card-header-action.test.tsx src/components/layout/__tests__/profile-row-share.test.tsx`
Expected: PASS (3 tests total).

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/ui/src/components/cards/item-card.tsx apps/ui/src/components/cards/domain-card.tsx apps/ui/src/pages/home-page.tsx apps/ui/src/components/layout/profile-row-actions.tsx apps/ui/src/components/cards/__tests__/item-card-header-action.test.tsx apps/ui/src/components/layout/__tests__/profile-row-share.test.tsx
git commit -m "feat(ui): Share button on live cards + own-profile row (#476)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Expose `isError` from `useItemDetail`

**Files:**
- Modify: `apps/ui/src/hooks/use-item-detail.ts`
- Test: `apps/ui/src/hooks/__tests__/use-item-detail-error.test.tsx` (new)

**Interfaces:**
- Produces: `useItemDetail(...)` now returns `{ item: Item | null; isLoading: boolean; isError: boolean }` (additive; existing callers that read only `item`/`isLoading` are unaffected).

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/__tests__/use-item-detail-error.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useItemDetail } from '../use-item-detail';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn().mockRejectedValue(new Error('boom')),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useItemDetail isError', () => {
  it('surfaces isError when the fetch rejects', async () => {
    const { result } = renderHook(
      () => useItemDetail('blue_dot', { item_id: 'abc', item_domain: 'seeker', item_type: 'profile_1.0' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.item).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-item-detail-error.test.tsx`
Expected: FAIL — `result.current.isError` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/ui/src/hooks/use-item-detail.ts`, change the return type and value:

```ts
interface UseItemDetailResult {
  item: Item | null;
  isLoading: boolean;
  isError: boolean;
}
```

and the final return:

```ts
  return { item: query.data ?? null, isLoading: query.isLoading, isError: query.isError };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-item-detail-error.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/hooks/use-item-detail.ts apps/ui/src/hooks/__tests__/use-item-detail-error.test.tsx
git commit -m "feat(ui): surface isError from useItemDetail (#476)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `PublicProfilePage` + route + state i18n

**Files:**
- Create: `apps/ui/src/pages/public-profile-page.tsx`
- Test: `apps/ui/src/pages/__tests__/public-profile-page.test.tsx`
- Modify: `apps/ui/src/app.tsx`
- Modify: `apps/ui/src/i18n/locales/{en,hi,kn}.json`

**Interfaces:**
- Consumes: `useParams`, `useSearchParams` (`react-router-dom`); `useResolvedNetwork` (`@/hooks/use-network-config`); `useItemDetail` (Task 4); `DomainCard` (`@/components/cards/domain-card`); `Item`, `DotNetworkSchema`.
- Produces: `PublicProfilePage()` default-exported React component + a route `/p/:network/:domain/:itemType/:itemId`.

- [ ] **Step 1: Add state i18n keys**

Add to `apps/ui/src/i18n/locales/en.json`:
```json
  "public_profile.loading": "Loading profile…",
  "public_profile.unavailable_title": "Profile unavailable",
  "public_profile.unavailable_body": "This profile is no longer available, or the link is invalid.",
  "public_profile.error_title": "Something went wrong",
  "public_profile.error_body": "We couldn't load this profile. Please try again.",
  "public_profile.retry": "Try again",
```

Add to `apps/ui/src/i18n/locales/hi.json`:
```json
  "public_profile.loading": "प्रोफ़ाइल लोड हो रही है…",
  "public_profile.unavailable_title": "प्रोफ़ाइल उपलब्ध नहीं",
  "public_profile.unavailable_body": "यह प्रोफ़ाइल अब उपलब्ध नहीं है, या लिंक अमान्य है।",
  "public_profile.error_title": "कुछ गलत हो गया",
  "public_profile.error_body": "हम यह प्रोफ़ाइल लोड नहीं कर सके। कृपया पुनः प्रयास करें।",
  "public_profile.retry": "पुनः प्रयास करें",
```

Add to `apps/ui/src/i18n/locales/kn.json`:
```json
  "public_profile.loading": "ಪ್ರೊಫೈಲ್ ಲೋಡ್ ಆಗುತ್ತಿದೆ…",
  "public_profile.unavailable_title": "ಪ್ರೊಫೈಲ್ ಲಭ್ಯವಿಲ್ಲ",
  "public_profile.unavailable_body": "ಈ ಪ್ರೊಫೈಲ್ ಇನ್ನು ಲಭ್ಯವಿಲ್ಲ, ಅಥವಾ ಲಿಂಕ್ ಅಮಾನ್ಯವಾಗಿದೆ.",
  "public_profile.error_title": "ಏನೋ ತಪ್ಪಾಗಿದೆ",
  "public_profile.error_body": "ನಾವು ಈ ಪ್ರೊಫೈಲ್ ಲೋಡ್ ಮಾಡಲಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
  "public_profile.retry": "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",
```

- [ ] **Step 2: Write the failing test**

Create `apps/ui/src/pages/__tests__/public-profile-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PublicProfilePage } from '../public-profile-page';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

const useItemDetail = vi.fn();
vi.mock('@/hooks/use-item-detail', () => ({ useItemDetail: (...a: unknown[]) => useItemDetail(...a) }));

const resolvedNetwork = {
  domains: [{ id: 'seeker', description: 'seekers', card: { title_field: 'name' }, item_schemas: { 'profile_1.0': { type: 'object', properties: { name: { type: 'string', title: 'Name' } } } } }],
};
const useResolvedNetwork = vi.fn();
vi.mock('@/hooks/use-network-config', () => ({ useResolvedNetwork: (...a: unknown[]) => useResolvedNetwork(...a) }));

// Render the real DomainCard would pull in many deps; stub it to a marker.
vi.mock('@/components/cards/domain-card', () => ({
  DomainCard: ({ data }: { data: Record<string, unknown> }) => <div data-testid="domain-card">{String(data.name ?? '')}</div>,
}));

const ID = '9b545eb9-5406-4bce-bc71-0cdac4b63bd0';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/p/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useResolvedNetwork.mockReturnValue({ data: resolvedNetwork, isLoading: false, isError: false });
  useItemDetail.mockReset();
});

describe('PublicProfilePage', () => {
  it('renders the profile card for a live item', () => {
    useItemDetail.mockReturnValue({ item: { item_state: { name: 'Asha' }, lifecycle_status: 'live' }, isLoading: false, isError: false });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByTestId('domain-card')).toHaveTextContent('Asha');
  });

  it('shows the loading state', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: true, isError: false });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Loading profile…')).toBeInTheDocument();
  });

  it('shows unavailable when the item is empty', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
  });

  it('shows the error state on a transient error', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: true });
    renderAt(`/p/blue_dot/seeker/profile_1.0/${ID}`);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows unavailable for a malformed item id (no fetch)', () => {
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderAt('/p/blue_dot/seeker/profile_1.0/not-a-uuid');
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/public-profile-page.test.tsx`
Expected: FAIL — cannot find module `../public-profile-page`.

- [ ] **Step 4: Implement the page**

Create `apps/ui/src/pages/public-profile-page.tsx`:

```tsx
import * as React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import { useResolvedNetwork } from '@/hooks/use-network-config';
import { useItemDetail } from '@/hooks/use-item-detail';
import { DomainCard } from '@/components/cards/domain-card';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function titleCaseDomain(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Centered standalone chrome for every state (themed by NetworkThemeProvider). */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function Message({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-background p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Public, unauthenticated single-profile view for a shared link
 * (`/p/:network/:domain/:itemType/:itemId`). Fetches the one profile via the
 * public, masked, jittered, live-only item endpoint (through `useItemDetail`)
 * and renders it with the shared `DomainCard`. Never exposes PII or a raw
 * error: empty/invalid → "unavailable"; transient failure → "try again".
 */
export function PublicProfilePage() {
  const { t } = useTranslation();
  const { network, domain, itemType, itemId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // Keep the theme aligned to the link's network (the theme provider reads the
  // `?network=` query param; our own links include it, but sync it defensively
  // for links that lost the query string).
  React.useEffect(() => {
    if (network && searchParams.get('network') !== network) {
      const next = new URLSearchParams(searchParams);
      next.set('network', network);
      setSearchParams(next, { replace: true });
    }
  }, [network, searchParams, setSearchParams]);

  const keyValid = Boolean(network && domain && itemType && itemId && UUID_RE.test(itemId));

  const { data: net, isLoading: netLoading } = useResolvedNetwork(keyValid ? network! : null);
  const { item, isLoading: itemLoading, isError } = useItemDetail(
    keyValid ? network! : null,
    keyValid ? { item_id: itemId!, item_domain: domain!, item_type: itemType! } : null,
  );

  if (!keyValid) {
    return (
      <Shell>
        <Message title={t('public_profile.unavailable_title', 'Profile unavailable')} body={t('public_profile.unavailable_body', 'This profile is no longer available, or the link is invalid.')} />
      </Shell>
    );
  }

  if (netLoading || itemLoading) {
    return (
      <Shell>
        <div className="rounded-2xl bg-background p-6 text-center text-sm text-muted-foreground shadow-sm">
          {t('public_profile.loading', 'Loading profile…')}
        </div>
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell>
        <Message
          title={t('public_profile.error_title', 'Something went wrong')}
          body={t('public_profile.error_body', "We couldn't load this profile. Please try again.")}
          action={
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {t('public_profile.retry', 'Try again')}
            </button>
          }
        />
      </Shell>
    );
  }

  // Live-only endpoint: a returned item is live. Guard defensively anyway.
  if (!item || (item.lifecycle_status && item.lifecycle_status !== 'live')) {
    return (
      <Shell>
        <Message title={t('public_profile.unavailable_title', 'Profile unavailable')} body={t('public_profile.unavailable_body', 'This profile is no longer available, or the link is invalid.')} />
      </Shell>
    );
  }

  const domainCfg = net?.domains.find((d) => d.id === domain);
  const schema = (domainCfg?.item_schemas?.[itemType!] ??
    (domainCfg?.item_schemas ? Object.values(domainCfg.item_schemas)[0] : undefined)) as
    | RJSFSchema
    | undefined;

  return (
    <Shell>
      <DomainCard
        schema={(schema ?? { type: 'object', properties: {} }) as RJSFSchema}
        cardConfig={domainCfg?.card ?? null}
        data={item.item_state}
        domainLabel={titleCaseDomain(domain!)}
      />
    </Shell>
  );
}

export default PublicProfilePage;
```

- [ ] **Step 5: Run the page test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/public-profile-page.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Register the route**

In `apps/ui/src/app.tsx`, add the import:
```ts
import { PublicProfilePage } from './pages/public-profile-page';
```

Add the route inside `<Routes>` (place it with the other public routes, e.g. after the `/terms` route). It MUST NOT be wrapped in `RequireAuth`:
```tsx
            <Route path="/p/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
```

- [ ] **Step 7: Typecheck + run the touched suites**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/public-profile-page.test.tsx src/lib/__tests__/share-profile.test.ts src/components/share/__tests__/share-profile-button.test.tsx`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/pages/public-profile-page.tsx apps/ui/src/pages/__tests__/public-profile-page.test.tsx apps/ui/src/app.tsx apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): public profile view page + /p/:network/... route (#476)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Full UI test suite: `pnpm --filter ui test` — all green.
- [ ] Typecheck: `pnpm --filter ui exec tsc --noEmit` — clean.
- [ ] Manual smoke (optional, local): run the UI (`run-signals-dpg` skill), open a live profile, click Share, confirm the toast; paste the copied link into a fresh incognito window and confirm the profile renders unauthenticated; edit `item_id` in the URL to a random UUID and confirm the "unavailable" page.

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| Share button on live browse cards | Task 3 (DomainCard `shareItem` → ItemCard header) |
| Share button on own-profile row (live only) | Task 3 (ProfileRowActions) |
| Copy link + toast + clipboard fallback | Tasks 1–2 |
| Raw-key link `/p/...?network=` | Task 1 (`buildProfileShareUrl`) |
| Public unauthenticated route + page | Task 5 (route outside `RequireAuth`) |
| Reuse public masked/jittered/live-only fetch | Task 5 via `useItemDetail` (Task 4) |
| Reuse `DomainCard` schema-driven render | Task 5 |
| Theming by the link's network | Task 1 (`?network=`) + Task 5 (defensive sync) |
| Binary available/unavailable + transient error | Tasks 4–5 |
| i18n en/hi/kn | Tasks 2 & 5 |
| No PII / no minor gating / no owner opt-in | By construction (reused masked endpoint; no gating added) |
| SPA deep-link fallback | Pre-existing nginx `try_files`; no change needed |

**Deferred (not in this plan, per spec):** OpenGraph previews, native share sheet, analytics, opaque token store, direct-to-instance federation routing.
