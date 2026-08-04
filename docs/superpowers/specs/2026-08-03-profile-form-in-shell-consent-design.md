# Profile create/edit — in-shell layout + inline consent (design)

**Date:** 2026-08-03
**Branch:** `feat/first-time-login-flow` (extends #376)
**Related:** #376 (first-time login profile redirect), consent v1 (`.claude/rules/consent-v1.md`), aggregator-dpg#464/#275 (draft→live promotion gate)

## Goal

Two linked UX changes to the profile create/edit experience:

1. **Render the create/edit form inside the main app shell** (`PageShell` — sidebar + app bar), replacing the current standalone `AuthShell` page, using the **wide-form + sticky-action-bar** layout (prototype "Option B").
2. **Capture `profile_creation` consent inline on the form** — for a draft being created *or edited*, show a consent control, block submit until accepted, and on submit promote the draft to `live` (with full guardian-OTP handling for minors on guardian-gated domains).

Both live on the same #376 branch and ship together.

## Background — current state

- `/profile/new` and `/profile/:id/edit` both render one component, `ProfileFormPage` (`apps/ui/src/pages/profile-form-page.tsx`), wrapped in a **standalone `AuthShell`** with a dark header + "Back" link. No sidebar, no app bar.
- The home experience uses **`PageShell`** (`apps/ui/src/components/layout/page-shell.tsx`) = `SidebarProvider` + `AppSidebar` + `TopBar` + `<main>{children}</main>`.
- **`TopBar`** (`apps/ui/src/components/layout/top-bar.tsx`) renders: sidebar trigger, search input, `filtersSlot`, map/list view toggle, language switcher, theme toggle, notification bell, user menu.
- **Consent today** is create-only: `consentRequired = !isEdit && !!statement` (`profile-form-page.tsx:286`). On the create path, submitting with a consent block promotes the item to `live` immediately (server: `createItemInternal`, `consent_accepted=true`). On the **edit** path no consent is captured; a draft opened in edit mode can be re-saved but stays `draft`.
- **Server rule** (aggregator-dpg#464/#275): an item is `live` only when it is **required-complete AND has `profile_creation` consent**. Consent-less admin/bulk creates stay `draft` until `POST /consent/profile-accept` (`promoteItemOnProfileConsent`) promotes them.
- **`ProfileConsentGate`** on `home-page.tsx` already prompts for consent when a user selects an un-consented draft while on home; accepting it calls `acceptProfileConsent(...)` (adults/ungated) or runs the guardian-OTP flow (minors on guardian-gated domains) and promotes draft→live.

## Explicit non-goal — `ProfileConsentGate` is retained

The home-page consent popup stays **exactly as-is**. When a user has a `live` profile and a `draft` profile, lands on home (no #376 redirect, because a live profile exists), and then selects the draft, the **home popup still fires**. This spec touches only `top-bar.tsx`, `page-shell.tsx`, `profile-form-page.tsx`, i18n, and tests — **not** `home-page.tsx`'s gate.

The two consent entry points are complementary:

| Path | Consent captured by |
|---|---|
| On home, select an un-consented draft (e.g. live + draft user) | **Home `ProfileConsentGate`** (unchanged) |
| #376 redirect for a drafts-only user, or opening a draft via the edit pencil / Create Profile | **Inline on the form** (new) |

## Design

### 1. `TopBar` — `variant: 'browse' | 'form'`

Add an optional `variant` (default `'browse'`) plus `title`, `subtitle?`, and `onBack?` props. Make the browse-only props (`search`, `onSearchChange`, `viewMode`, `onViewModeChange`, `filtersSlot`) **optional**.

- `variant='browse'` (default): unchanged — search, filters, view toggle, account controls.
- `variant='form'`: render **Back (`onBack`) + `title` / `subtitle`** on the left; **omit** search, `filtersSlot`, and the map/list toggle; **keep** the sidebar trigger, language switcher, theme toggle, notification bell, and user menu (account-level controls).

### 2. `PageShell` — thread the variant through

Add optional `variant`, `title`, `subtitle`, `onBack`; make browse-only props optional; forward them to `TopBar`. When `variant='form'`, `PageShell` does not require `search`/`viewMode`. The sidebar (`AppSidebar`) renders identically in both variants and stays interactive.

### 3. `ProfileFormPage` — render inside `PageShell` (Option B)

Replace the `AuthShell` wrapper with `PageShell` in `variant='form'`. This applies to **all** states of the page — the role picker (create with multiple domains), the create form, and the edit form — so there is no remaining standalone layout.

**Sourcing the sidebar props.** `PageShell`/`AppSidebar` need `networks`, `selectedNetwork`, `domains`, `selectedDomain`, `myItems`, `activeProfileId`, `userSchemas`, and the domain/profile callbacks (the same the home page passes). `ProfileFormPage` already resolves the network config; it additionally fetches `myItems` (via `useMyItems(network)`) and derives `activeProfileId` (the same `active-profile-storage` key used on home) to feed the sidebar. Sidebar interactions keep their existing navigation behavior (selecting a profile / domain navigates as today).

**App bar:** `variant='form'`, `title` = "Create Profile" / "Edit Seeker Profile" / "Edit Provider Profile" (role-aware), `onBack` = the existing back navigation.

**Content layout (Option B):**
- A wide container (≈`max-w-[1040px]`, centered) with bottom padding to clear the sticky bar.
- The existing "why complete your profile" prompt (`profile_completion_prompt`, already built) pinned at the top **for drafts** (`showCompletionPrompt`).
- Form sections render as today inside the card.
- A **sticky bottom action bar** within the content area containing:
  - **Left:** required-fields status — `✓ {complete}` when `formValid`, else a "fill required fields" hint.
  - **Right:** the **consent control** (when `needsConsent`, see §4) + **Cancel** + the **primary button** ("Create Profile" / "Update" / "Save & publish" when a promotion will occur).
- Responsive: below the two-column breakpoint the form is single-column (unchanged); the action bar stays sticky at the bottom.

### 4. Inline consent (full parity)

**When to show consent on the form** — replace `consentRequired = !isEdit && !!statement` with a state that also covers editing a draft:

```
needsConsent =
  !!statement                                   // network configures a profile_creation statement
  && (!isEdit || editItem.data?.lifecycle_status === 'draft')  // creating, or editing a DRAFT
  && !alreadyConsented(existingItem?.item_id)    // not already recorded (edit path only)
```

For an **already-live** profile in edit mode, `needsConsent` is false — no consent control, primary button reads "Update", no promotion (unchanged behavior).

**Blocking submit:** when `needsConsent`, the primary button is disabled until the consent checkbox is ticked (mirrors the existing create-mode `consentChecked` gate, which already resets when the form becomes invalid).

**On submit:**
- **Create** (`!isEdit`): unchanged — `createItem` with the `consent` block → server promotes to `live`. Existing minor path (`minorGatedCreate` → `finalizeProfileConsent`) unchanged.
- **Edit of a draft with `needsConsent`:**
  1. `updateItem(id, { item_state, item_locations })` — persist field edits (existing edit logic).
  2. **Record consent + promote** using the **same mechanism as the home `ProfileConsentGate`**:
     - **Adult / ungated domain:** `acceptProfileConsent({ network, brand, item_domain, item_type, item_id, version })` → server records consent and `promoteItemOnProfileConsent` flips the (required-complete) draft to `live` in the same transaction.
     - **Minor on a guardian-gated domain** (`isGuardianConsentRequiredDomain`): run the guardian-OTP flow — `issueProfileConsentOtp(ref)` → `GuardianOtpDialog` (via a `guardianProfileRef`), with the `U18GuardianFlow` guardian-capture fallback on `409 GUARDIAN_REQUIRED`. Ward self-consent must **not** promote a minor.
  3. Cache updates mirroring home/create: `setQueryData(profileConsent, add id)`, invalidate `myItems` + `browse-items`, remove/invalidate the by-id caches; toast; navigate home.
- **Edit of a draft without `needsConsent`** (no statement configured, or already consented): unchanged — save fields only.

**Reuse strategy (for the plan):** the adult-accept + guardian-OTP + guardian-capture logic currently lives inline in `home-page.tsx`. Extract it into a reusable hook (e.g. `useProfileConsentAccept`) that returns `{ accept(profileRef), guardianOtpDialog, guardianSetupFlow, isPending }` and encapsulates the cache updates, and consume it from **both** `home-page.tsx` (behavior-preserving refactor) and `profile-form-page.tsx`. This avoids duplicating the sensitive consent/U18 path. If extraction proves too invasive in one pass, the fallback is a focused, self-contained implementation on the form page that calls the same `acceptProfileConsent` / `issueProfileConsentOtp` APIs — but the hook is preferred.

## Edge cases

- **Multiple drafts (Test4):** #376 opens the active/selected draft; the sidebar profile selector still switches between them; consent applies per-profile.
- **Live + drafts (Test6):** login lands home (no redirect); selecting a draft on home → home popup (unchanged). Opening a draft via the edit pencil → inline consent on the form.
- **Paused/retired only (Test7/Test8):** counts as "set up" — no redirect; editing is normal (no consent control, since not a draft).
- **Required fields incomplete:** the form's own validation disables the primary button before consent is even reachable, so "fill required fields AND accept consent" is enforced in order.
- **Guardian OTP unavailable / rate-limited / no guardian on file:** same toasts/fallbacks as the home path (`503`, `429`, `409 GUARDIAN_REQUIRED`).
- **Consent recorded but item still not required-complete:** server keeps it `draft` (promotion is conditional); the form's validation gate makes this unreachable via the UI, but the server remains authoritative.

## Testing

- **`top-bar.test.tsx`:** `variant='form'` hides search / filters / view toggle and shows Back + title; keeps language/theme/bell/user menu. `variant='browse'` unchanged.
- **`profile-form-page` tests:**
  - Renders inside `PageShell` (sidebar + form-mode app bar) for create, edit, and the role-picker state.
  - `needsConsent` truth table: create → shows consent; edit draft (un-consented) → shows consent, button blocked until ticked; edit live → no consent, button enabled; edit draft already-consented → no consent.
  - Edit-of-draft submit (adult): calls `updateItem` then `acceptProfileConsent`, updates caches, navigates home.
  - Edit-of-draft submit (minor, guardian-gated): routes through the guardian-OTP flow instead of self-accept.
- **`useProfileConsentAccept` (if extracted):** unit tests for adult accept, minor guardian-OTP hand-off, guardian-capture fallback, cache updates — plus a home-page regression check that the gate still behaves identically.
- Full UI suite green; `pnpm typecheck` clean.

## Out of scope / decisions locked

- `ProfileConsentGate` on home is **retained unchanged**.
- No change to the #376 redirect rules or the `profile_completion_prompt` copy (already shipped on this branch).
- No change to server consent/promotion endpoints — the form reuses existing `POST /consent/profile-accept` and `/item/create`.
- Layout is **Option B** (wide + sticky action bar), per prototype selection.
- Minor handling on the edit path is **full parity** with create/home (guardian-OTP), per prior decision.
