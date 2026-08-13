# Profile create/edit — in-shell layout + inline consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the profile create/edit form inside the main app shell (sidebar + app bar, Option B wide-form + sticky action bar) and capture `profile_creation` consent inline on the form for drafts, promoting draft→live with full guardian-OTP parity for minors.

**Architecture:** Reuse `PageShell` for `/profile/new` + `/profile/:id/edit`; add a `variant='form'` to `TopBar` that hides browse controls and shows Back+title. Extract the home page's consent-accept + guardian-OTP logic into a `useProfileConsentAccept` hook and consume it from the form page. `ProfileConsentGate` on home is retained unchanged.

**Tech Stack:** React 19 + Vite, React Query, react-router-dom, RJSF (`SchemaForm`), Vitest + Testing Library, i18next.

**Spec:** `docs/superpowers/specs/2026-08-03-profile-form-in-shell-consent-design.md`

## Global Constraints

- **Branch:** `feat/first-time-login-flow` (do NOT branch off / merge to `feature` or `develop`).
- **`ProfileConsentGate` / `ProfileConsentModal` on `home-page.tsx` must remain behaviorally identical** — the live+draft "select the draft on home → popup" case is unchanged.
- **Draft→live is server-authoritative:** `POST /consent/profile-accept` (`acceptProfileConsent`) promotes; the UI never sets `lifecycle_status` itself.
- **Minor on a guardian-gated domain must never self-promote:** consent for such a ward goes through the guardian-OTP flow (`issueProfileConsentOtp` → `GuardianOtpDialog`, `U18GuardianFlow` capture fallback).
- **No `any`, strict TS, ESM, `import type` for types. Files snake_case, components PascalCase.** No `console.log`. No `// TODO`.
- **i18n:** every new user-facing string added to `en.json`, `hi.json`, `kn.json` (kn retained even if not enabled by default).
- **Gates per task:** `pnpm --filter ui exec vitest run <files>` green for the task's tests; end of plan: full `pnpm --filter ui test` + `pnpm typecheck` clean.

## File Structure

- `apps/ui/src/components/layout/top-bar.tsx` — add `variant`/`title`/`subtitle`/`onBack`; browse props optional. **Test:** `top-bar.test.tsx` (new).
- `apps/ui/src/components/layout/page-shell.tsx` — thread the new props to `TopBar`; browse props optional. **Test:** `page-shell.test.tsx` (new).
- `apps/ui/src/hooks/use-profile-consent-accept.tsx` (new) — shared consent-accept + guardian flow. **Test:** `use-profile-consent-accept.test.tsx` (new).
- `apps/ui/src/pages/profile-form-page.tsx` — render in `PageShell`, Option B layout, sticky action bar, inline consent for edit-of-draft. **Test:** extend `apps/ui/src/pages/__tests__/profile-form-page.test.tsx` (create if absent).
- `apps/ui/src/pages/home-page.tsx` — refactor to consume the hook (Task 6, behavior-preserving).
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — new strings (folded into the tasks that use them).

---

### Task 1: `TopBar` — `variant: 'browse' | 'form'`

**Files:**
- Modify: `apps/ui/src/components/layout/top-bar.tsx`
- Create: `apps/ui/src/components/layout/__tests__/top-bar.test.tsx`
- Modify: `apps/ui/src/i18n/locales/{en,hi,kn}.json`

**Interfaces:**
- Produces: `TopBarProps` extended with
  ```ts
  variant?: 'browse' | 'form';          // default 'browse'
  title?: string;                        // shown in 'form'
  subtitle?: string;                     // optional, shown in 'form'
  onBack?: () => void;                   // Back control in 'form'
  // browse-only — now optional:
  search?: string;
  onSearchChange?: (v: string) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (m: ViewMode) => void;
  filtersSlot?: React.ReactNode;
  ```
- Consumes: existing `LanguageSwitcher`, `ThemeModeToggle`, `UserMenu`, `NotificationBell`, `SidebarTrigger`.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/components/layout/__tests__/top-bar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false }) }));
vi.mock('@/hooks/use-actions', () => ({ usePendingActionsCount: () => ({ data: 0 }) }));
vi.mock('@/components/auth/user-menu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }));
vi.mock('@/components/layout/theme-mode-toggle', () => ({ ThemeModeToggle: () => <div data-testid="theme" /> }));
vi.mock('@/components/layout/language-switcher', () => ({ LanguageSwitcher: () => <div data-testid="lang" /> }));

import { TopBar } from '@/components/layout/top-bar';

function renderBar(props: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  return render(
    <MemoryRouter>
      <TopBar variant="form" title="Edit Provider Profile" onBack={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe('TopBar — form variant', () => {
  it('hides browse controls and shows Back + title', () => {
    renderBar();
    expect(screen.getByText('Edit Provider Profile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    // view toggle (map/list) is gone
    expect(screen.queryByRole('radio', { name: /map view/i })).not.toBeInTheDocument();
    // account controls stay
    expect(screen.getByTestId('user-menu')).toBeInTheDocument();
    expect(screen.getByTestId('theme')).toBeInTheDocument();
    expect(screen.getByTestId('lang')).toBeInTheDocument();
  });

  it('browse variant still renders search + view toggle', () => {
    renderBar({ variant: 'browse', title: undefined, onBack: undefined,
      search: '', onSearchChange: vi.fn(), viewMode: 'map', onViewModeChange: vi.fn() });
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /map view/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/top-bar.test.tsx`
Expected: FAIL (form variant not implemented; `search` currently required so browse test may also error).

- [ ] **Step 3: Implement the variant**

In `top-bar.tsx`: add the new props (make browse props optional). Guard the search `<Input>` block, `filtersSlot`, and the `ToggleGroup` behind `variant === 'browse'`. When `variant === 'form'`, render a leading Back button + title/subtitle in their place. The right-hand cluster (language/theme/bell/user menu) is unchanged.

```tsx
import { ArrowLeft } from 'lucide-react';
// ...
export function TopBar({
  variant = 'browse', title, subtitle, onBack,
  search, onSearchChange, viewMode, onViewModeChange, filtersSlot,
}: TopBarProps) {
  // ...
  return (
    <header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-gradient-to-r from-background to-primary/5 px-4 py-2 sm:flex-nowrap sm:py-0 sm:px-6">
      <SidebarTrigger className="md:hidden" />
      {variant === 'form' ? (
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="sm" onClick={onBack} className="gap-1.5" aria-label={t('common.back')}>
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">{t('common.back')}</span>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-foreground sm:text-[15px]">{title}</h1>
            {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
      ) : (
        <>
          <div className="relative order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1 sm:max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="search" aria-label={t('common.search')} placeholder={t('common.search')}
              className="pl-8" value={search ?? ''} onChange={(e) => onSearchChange?.(e.target.value)} />
          </div>
          {filtersSlot}
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {variant === 'browse' && (
          <ToggleGroup type="single" value={viewMode} onValueChange={(v) => { if (v) onViewModeChange?.(v as ViewMode); }}>
            <ToggleGroupItem value="map" aria-label={t('nav.map_view')}><MapPinned className="h-4 w-4" /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label={t('nav.list_view')}><List className="h-4 w-4" /></ToggleGroupItem>
          </ToggleGroup>
        )}
        {/* language/theme/bell/user-menu block — unchanged */}
      </div>
    </header>
  );
}
```

Add `common.back` to all three locale files (`en`: "Back", `hi`: "वापस", `kn`: "ಹಿಂದೆ").

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/top-bar.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/layout/top-bar.tsx apps/ui/src/components/layout/__tests__/top-bar.test.tsx apps/ui/src/i18n/locales/en.json apps/ui/src/i18n/locales/hi.json apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): TopBar form variant (Back+title, hide browse controls) (#376)"
```

---

### Task 2: `PageShell` — thread the form variant

**Files:**
- Modify: `apps/ui/src/components/layout/page-shell.tsx`
- Create: `apps/ui/src/components/layout/__tests__/page-shell.test.tsx`

**Interfaces:**
- Consumes: `TopBar` props from Task 1.
- Produces: `PageShellProps` extended with `variant?: 'browse' | 'form'`, `title?`, `subtitle?`, `onBack?`; `search`/`onSearchChange`/`viewMode`/`onViewModeChange` made optional. Forwarded verbatim to `TopBar`. Sidebar props unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/components/layout/__tests__/page-shell.test.tsx`. Mock `AppSidebar` and `TopBar` to assert prop pass-through:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/layout/sidebar', () => ({ AppSidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('@/components/layout/top-bar', () => ({
  TopBar: (p: { variant?: string; title?: string }) => <div data-testid="topbar" data-variant={p.variant} data-title={p.title} />,
}));
vi.mock('@/components/ui/sidebar', () => ({ SidebarProvider: (p: { children: React.ReactNode }) => <>{p.children}</> }));
vi.mock('@/components/ui/tooltip', () => ({ TooltipProvider: (p: { children: React.ReactNode }) => <>{p.children}</> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { PageShell } from '@/components/layout/page-shell';

it('forwards form variant + title to TopBar and renders children + sidebar', () => {
  render(
    <PageShell variant="form" title="Edit Provider Profile" onBack={() => {}}
      domains={[]} selectedDomain={null} onDomainSelect={() => {}}>
      <div data-testid="child" />
    </PageShell>,
  );
  const bar = screen.getByTestId('topbar');
  expect(bar.getAttribute('data-variant')).toBe('form');
  expect(bar.getAttribute('data-title')).toBe('Edit Provider Profile');
  expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  expect(screen.getByTestId('child')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/page-shell.test.tsx`
Expected: FAIL — `variant`/`title`/`onBack` not accepted; `search`/`viewMode` currently required (TS/runtime error).

- [ ] **Step 3: Implement**

In `page-shell.tsx`: add `variant`, `title`, `subtitle`, `onBack` to `PageShellProps`; make `search`, `onSearchChange`, `viewMode`, `onViewModeChange` optional. Pass all through to `TopBar`:

```tsx
<TopBar
  variant={variant}
  title={title}
  subtitle={subtitle}
  onBack={onBack}
  search={search}
  onSearchChange={onSearchChange}
  viewMode={viewMode}
  onViewModeChange={onViewModeChange}
  filtersSlot={filtersSlot}
/>
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ui exec vitest run src/components/layout/__tests__/page-shell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/layout/page-shell.tsx apps/ui/src/components/layout/__tests__/page-shell.test.tsx
git commit -m "feat(ui): PageShell threads form variant to TopBar (#376)"
```

---

### Task 3: `ProfileFormPage` renders inside `PageShell` (Option B layout, consent behavior unchanged)

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`
- Create/modify: `apps/ui/src/pages/__tests__/profile-form-page.test.tsx`

**Interfaces:**
- Consumes: `PageShell` (Task 2), `useMyItems(network)`, `getStoredActiveProfileId` (`@/lib/active-profile-storage`).
- Produces: the page rendered inside `PageShell variant='form'` for the role-picker, create, and edit states; a unified sticky action bar (`data-testid="profile-action-bar"`) holding status + Cancel + primary submit. `formValid` tracked in BOTH create and edit. `SchemaForm` `hideSubmit` set in BOTH modes (submit lives in the action bar, `type="submit" form="profile-form"`).

> **Scope note:** This task does NOT change consent semantics. Create keeps its exact consent behavior (moved verbatim into the action bar); edit keeps "save fields only" (consent added in Task 5). It only relocates the layout into the shell.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/pages/__tests__/profile-form-page.test.tsx`. Mock `PageShell` to a passthrough that records `variant`, mock network/config/consent/my-items hooks, `SchemaForm` to a button that submits, and `useEditItem` to return a live item. Assert:

```tsx
// (mocks omitted here for brevity — see neighboring page tests for the pattern:
//  auth-context, theme-provider, use-network-config, use-consent-config, use-my-items,
//  item-api create/update, react-router useNavigate/useParams/useLocation)
vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: { variant?: string; children: React.ReactNode }) =>
    <div data-testid="shell" data-variant={p.variant}>{p.children}</div>,
}));

it('renders the edit form inside PageShell in form variant, with a single action bar', async () => {
  // params id set, useEditItem → { lifecycle_status: 'live', item_state: {...} }
  renderPage();
  await screen.findByTestId('shell');
  expect(screen.getByTestId('shell').getAttribute('data-variant')).toBe('form');
  expect(screen.getByTestId('profile-action-bar')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /update/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/profile-form-page.test.tsx`
Expected: FAIL — no `PageShell`, no `profile-action-bar`.

- [ ] **Step 3: Implement the shell + layout**

1. Replace the `AuthShell` wrapper (and the role-picker's `AuthShell`) with `PageShell` in `variant='form'`. Compute `title` (role-aware: create → `t('profile.create_heading')`; edit → `t('profile.edit_heading', { role })`), `onBack` = existing back nav.
2. Source sidebar props: `const myItems = useMyItems(network).data ?? []; const activeProfileId = getStoredActiveProfileId(network?.id ?? '');` and pass the same sidebar props home passes (`networks`, `selectedNetwork`, `domains`, `selectedDomain`, `myItems`, `activeProfileId`, callbacks that navigate as today).
3. Wrap the form body in the Option B container: `<div className="mx-auto max-w-[1040px] pb-24">…form card…</div>`.
4. `SchemaForm`: set `hideSubmit` **always true**, and `onValidityChange={setFormValid}` **always** (remove the `!isEdit ?` guards).
5. Replace the two separate submit UIs (the create block + SchemaForm's edit submit) with ONE sticky action bar rendered for both modes:

```tsx
<div data-testid="profile-action-bar"
     className="sticky bottom-0 z-30 mt-4 flex flex-wrap items-center gap-3 rounded-xl border bg-background/95 p-3 shadow-[0_-6px_20px_rgba(15,23,42,0.06)] backdrop-blur sm:px-4">
  <div className="flex items-center gap-2 text-sm text-muted-foreground">
    {formValid
      ? <span className="text-emerald-600">{t('profile.required_complete')}</span>
      : <span className="text-amber-700">{t('profile.fill_required_hint')}</span>}
  </div>
  <div className="ml-auto flex items-center gap-2">
    {/* consentSlot — empty in this task; filled in Task 5 */}
    <Button variant="ghost" onClick={onBack}>{t('common.cancel')}</Button>
    <button type="submit" form="profile-form" disabled={submitDisabled}
      className="h-11 rounded-md bg-brand-cta px-5 font-semibold text-white disabled:opacity-50">
      {primaryLabel}
    </button>
  </div>
</div>
```

where for THIS task `primaryLabel = isEdit ? t('profile.btn_update') : t('profile.btn_create')` and `submitDisabled` preserves the existing create gate (`!formValid || consentLoading || (consentRequired && !consentChecked) || (minorGatedCreate && !guardianVerifiedForCreate)`) for create and `!formValid` for edit. Keep the existing `ConsentCheckbox` + minor interstitial for CREATE, relocated into the action bar's consent slot area (behavior identical). Preserve the wallet import button, `formError` alert, and completion prompt inside the form card.

Add strings: `profile.required_complete` ("All required fields complete"), `common.cancel`, `profile.edit_heading` ("Edit {{role}} Profile") to all locales.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/profile-form-page.test.tsx`
Expected: PASS. Also run the existing otp-page/post-login tests to confirm no regressions: `pnpm --filter ui exec vitest run src/pages/auth src/lib/post-login-route.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/profile-form-page.tsx apps/ui/src/pages/__tests__/profile-form-page.test.tsx apps/ui/src/i18n/locales/*.json
git commit -m "feat(ui): render profile form inside PageShell with sticky action bar (Option B) (#376)"
```

---

### Task 4: `useProfileConsentAccept` hook (shared accept + guardian flow)

**Files:**
- Create: `apps/ui/src/hooks/use-profile-consent-accept.tsx`
- Create: `apps/ui/src/hooks/__tests__/use-profile-consent-accept.test.tsx`

**Interfaces:**
- Consumes: `acceptProfileConsent`, `issueProfileConsentOtp` (`@/lib/consent-api`), `GuardianOtpDialog`, `U18GuardianFlow`, `isGuardianConsentRequiredDomain`, `queryKeys`, `useQueryClient`.
- Produces:
  ```ts
  type ProfileConsentAcceptArgs = {
    network: string; brand: string | null;
    item: { item_id: string; item_domain: string; item_type: string };
    version: number; isMinor: boolean;
    onDone: () => void;   // called after consent recorded + caches updated (adult or post-guardian-OTP)
  };
  function useProfileConsentAccept(): {
    accept: (args: ProfileConsentAcceptArgs) => Promise<void>;
    dialogs: React.ReactNode;   // render once in the tree; hosts GuardianOtpDialog + capture flow
    isPending: boolean;
  };
  ```
- The hook encapsulates: adult/ungated → `acceptProfileConsent(...)` + cache updates (`setQueryData(profileConsent, add id)`, invalidate `myItems` + `['browse-items', network]`) + `onDone`. Minor+gated → `issueProfileConsentOtp(ref)` → hosts `GuardianOtpDialog` (via internal `guardianProfileRef`) whose success runs the same cache updates + `onDone`; on `409 GUARDIAN_REQUIRED` hosts `U18GuardianFlow` capture then re-issues. Toasts for `429`/`503`/generic mirror home-page (`top-bar` copy keys reused).

- [ ] **Step 1: Write the failing test**

Create the test. Mock `@/lib/consent-api` (`acceptProfileConsent`, `issueProfileConsentOtp`), `GuardianOtpDialog`/`U18GuardianFlow` to inert testids, and a `QueryClientProvider`.

```tsx
// Adult path: accept() calls acceptProfileConsent + onDone; updates profileConsent cache.
it('adult accept records consent and calls onDone', async () => {
  const onDone = vi.fn();
  const { result } = renderHook(() => useProfileConsentAccept(), { wrapper });
  await act(() => result.current.accept({
    network: 'blue_dot', brand: null, item: { item_id: 'p1', item_domain: 'seeker', item_type: 'profile_1.0' },
    version: 1, isMinor: false, onDone,
  }));
  expect(acceptProfileConsent).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'p1', version: 1 }));
  expect(onDone).toHaveBeenCalled();
});

// Minor+gated path: accept() issues guardian OTP instead of self-accept.
it('minor on gated domain issues guardian OTP and does not self-accept', async () => {
  const { result } = renderHook(() => useProfileConsentAccept(), { wrapper });
  await act(() => result.current.accept({ /* isMinor:true, seeker gated */ }));
  expect(issueProfileConsentOtp).toHaveBeenCalled();
  expect(acceptProfileConsent).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-profile-consent-accept.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook**

Port the logic from `home-page.tsx:1671-1780` (the `issueProfileOtp` callback, the `guardianSetupForProfileModal`, and the `onAccept` adult branch with its cache updates) into the hook, parameterized by `ProfileConsentAcceptArgs` and `isGuardianConsentRequiredDomain(network, item_domain)` for the gate. Return the guardian dialogs as `dialogs`. Keep the exact toast keys and error branches (`409 GUARDIAN_REQUIRED` → capture flow → re-issue; `429`; `503`; generic).

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-profile-consent-accept.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/hooks/use-profile-consent-accept.tsx apps/ui/src/hooks/__tests__/use-profile-consent-accept.test.tsx
git commit -m "feat(ui): extract useProfileConsentAccept (accept + guardian-OTP) hook (#376)"
```

---

### Task 5: Inline consent for edit-of-draft in `ProfileFormPage`

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`
- Modify: `apps/ui/src/pages/__tests__/profile-form-page.test.tsx`
- Modify: `apps/ui/src/i18n/locales/{en,hi,kn}.json`

**Interfaces:**
- Consumes: `useProfileConsentAccept` (Task 4), `useConsentConfig` (already imported), the `profileConsent` query set (to know if THIS draft is already consented), `getU18Status`/`u18IsMinor` (already computed for create; extend to edit).
- Produces: `needsConsent` computed for create AND edit-of-draft; consent control rendered in the action bar's consent slot; primary button blocked until consent when `needsConsent`; edit-of-draft submit → `updateItem` then `accept(...)`.

- [ ] **Step 1: Write the failing tests**

Add to `profile-form-page.test.tsx`:

```tsx
// needsConsent truth table
it('edit of a DRAFT (un-consented) shows consent and blocks submit until ticked', async () => {
  // useEditItem → lifecycle_status 'draft'; consent config has a profile_creation statement; not in profileConsent set
  renderPage();
  const submit = await screen.findByRole('button', { name: /save & publish|update/i });
  expect(submit).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /agree/i }));
  expect(submit).toBeEnabled();
});
it('edit of a LIVE profile shows no consent and enables submit', async () => {
  // lifecycle_status 'live'
  renderPage();
  expect(screen.queryByRole('checkbox', { name: /agree/i })).not.toBeInTheDocument();
});
it('edit-of-draft submit (adult) updates then records consent', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('checkbox', { name: /agree/i }));
  await userEvent.click(screen.getByRole('button', { name: /save & publish/i }));
  await waitFor(() => expect(updateItem).toHaveBeenCalled());
  expect(acceptMock).toHaveBeenCalledWith(expect.objectContaining({ isMinor: false }));
});
it('edit-of-draft submit (minor, gated) routes through guardian flow', async () => {
  // getU18Status → isMinor true; seeker gated
  renderPage();
  await userEvent.click(screen.getByRole('checkbox', { name: /agree/i }));
  await userEvent.click(screen.getByRole('button', { name: /save & publish/i }));
  expect(acceptMock).toHaveBeenCalledWith(expect.objectContaining({ isMinor: true }));
});
```

(Mock `@/hooks/use-profile-consent-accept` to expose `acceptMock` + inert `dialogs`.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/profile-form-page.test.tsx`
Expected: FAIL — consent not shown on edit; submit path doesn't call accept.

- [ ] **Step 3: Implement**

1. Compute `alreadyConsented`: read `queryClient.getQueryData<Set<string>>(queryKeys.profileConsent(network.id))` (or via a small `useProfileConsentStatus` read) and test `existingItem?.item_id`.
2. Replace `consentRequired` with:
   ```ts
   const isDraft = !isEdit || editItem.data?.lifecycle_status === 'draft';
   const needsConsent = !!statement && isDraft && !(existingItem && alreadyConsented.has(existingItem.item_id));
   ```
3. Extend the `u18IsMinor` effect to also run in edit mode when `isDraft` (drop the `if (isEdit) return;` guard for the draft case).
4. Render the consent slot in the action bar for `needsConsent` (the same `ConsentCheckbox` + minor interstitial already used for create). `primaryLabel` = `needsConsent ? t('profile.btn_save_publish') : (isEdit ? t('profile.btn_update') : t('profile.btn_create'))`. `submitDisabled` includes `needsConsent && !consentChecked`.
5. In `handleSubmit`, add the edit-of-draft branch: after `updateItem(...)`, if `needsConsent`, call the hook:
   ```ts
   await accept({
     network: network.id, brand: brand === 'standard' ? null : brand,
     item: { item_id: existingItem.item_id, item_domain: selectedDomain, item_type: existingItem.item_type },
     version: profileDoc.current_version, isMinor: u18IsMinor === true,
     onDone: () => {
       queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
       navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
     },
   });
   return; // navigation handled by onDone (covers async guardian-OTP)
   ```
   For adult, `accept` resolves synchronously → `onDone` runs. For minor, `accept` opens the guardian dialog; `onDone` runs after OTP success. Render `dialogs` from the hook in the page tree.
6. Keep create path exactly as-is.

Add strings: `profile.btn_save_publish` ("Save & publish") to all locales.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/profile-form-page.test.tsx`
Expected: PASS (all needsConsent + submit cases).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/profile-form-page.tsx apps/ui/src/pages/__tests__/profile-form-page.test.tsx apps/ui/src/i18n/locales/*.json
git commit -m "feat(ui): inline profile_creation consent on edit-of-draft, promote to live (#376)"
```

---

### Task 6: Refactor `home-page.tsx` to consume `useProfileConsentAccept` (dedup)

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`

**Interfaces:**
- Consumes: `useProfileConsentAccept` (Task 4).
- Produces: no behavior change — `ProfileConsentModal`'s `onAccept` delegates to the hook's `accept`; `home-page`'s inline `issueProfileOtp`/`guardianSetupForProfileModal`/`guardianProfileRef` state is removed in favor of the hook's `dialogs`. `ProfileConsentGate` behavior is byte-for-byte equivalent.

> If the reviewer judges this refactor too risky to land with the feature, it may be deferred to a follow-up PR — the feature (Tasks 1–5) is complete without it. Log the deferral rather than silently skipping.

- [ ] **Step 1: Run the existing home-page tests as the baseline**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/home-page*.test.tsx`
Record the passing set — this is the regression gate.

- [ ] **Step 2: Refactor**

Replace the inline consent-accept + guardian-OTP state/handlers in `home-page.tsx` with `const { accept, dialogs } = useProfileConsentAccept();`. In `ProfileConsentModal.onAccept`, call `accept({ ..., isMinor: u18Status?.isMinor === true, onDone: () => { /* existing setQueryData + activeProfile/pending resets */ } })`. Render `dialogs` where `guardianSetupForProfileModal`/`GuardianOtpDialog` were rendered. Remove the now-dead `issueProfileOtp`, `guardianSetupRef`, `guardianProfileRef` if fully subsumed.

- [ ] **Step 3: Run the regression gate**

Run: `pnpm --filter ui exec vitest run src/pages/__tests__/home-page*.test.tsx`
Expected: identical pass set to Step 1.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/pages/home-page.tsx
git commit -m "refactor(ui): home ProfileConsentGate uses shared useProfileConsentAccept (#376)"
```

---

## Final gates (after all tasks)

- [ ] `pnpm typecheck` clean (api + ui).
- [ ] `pnpm --filter ui test` fully green.
- [ ] Manual smoke on `blue_dot` local with the seeded testers: T1 (create → consent inline → live), T2/T3 (edit draft → consent inline → live, seeker vs provider prompt), T4 (multi-draft), T5–T8 (no redirect; edit live has no consent control), and the retained home popup for T6 (select draft on home).
- [ ] Push updates PR #478.

## Self-review

- **Spec coverage:** in-shell layout (T1–T3), Option B sticky bar (T3), inline consent create+edit (T3 create preserved, T5 edit), minor parity (T4+T5), `ProfileConsentGate` retained (T6 preserves behavior; home gate untouched functionally). ✓
- **Type consistency:** `ProfileConsentAcceptArgs`/`accept`/`dialogs`/`isPending` used identically in T4, T5, T6. `variant`/`title`/`subtitle`/`onBack` consistent across T1/T2. ✓
- **No placeholders:** each step has concrete code or precise transformation + exact commands. ✓
