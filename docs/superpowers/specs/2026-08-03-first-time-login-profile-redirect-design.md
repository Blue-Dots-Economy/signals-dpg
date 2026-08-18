# First-time login → profile completion redirect (#376) — Design

**Status:** Draft for review (no implementation yet)
**Branch:** `feat/first-time-login-flow` (off `feature`)
**Issue:** Blue-Dots-Economy/signals-dpg#376 — "First time login flow"

## Goal

When a user finishes logging in, if they don't yet have a usable (live) profile,
send them **straight to the profile create/edit page** (pre-filled with what's
known, blanks for the rest) with a clear, motivating reason to complete it —
instead of dropping them on the home page where they wouldn't know what to do.
A user who already has a completed profile is unaffected.

## The rule

Evaluated **once, on login success (OTP verify)** — it is a one-time redirect,
NOT a persistent gate, so there is no loop and the user can browse freely
afterward. The check runs again on each subsequent login.

Let the user's profiles (across all served domains) be `P`.

- **"Has a completed profile"** = any `p ∈ P` with `lifecycle_status ∈ {live, paused, retired}`.
  → **Do NOT redirect.** Land normally (`redirectTo` or `/`).
- **"No completed profile"** = `P` is empty, OR every `p ∈ P` is `draft`.
  → **Redirect:**
  - `P` empty → **`/profile/new`** (create).
  - `P` has draft(s) → **`/profile/:id/edit`** for the **active/selected** profile
    (stored active id if it is one of the user's drafts, else the first draft in
    `myItems`).

Rationale for `paused`/`retired` counting as "completed": the user already went
through profile creation once (per product decision in #376 clarification), so we
don't nag them.

## Why this trigger (login success, not `/` landing)

Tying the check to the **OTP-verify success** (the single login-success point,
`otp-page.tsx`) means:
- No session flag / escape-hatch needed, and **no redirect loop** — after the
  one-time redirect they navigate home and browse freely.
- A user with a still-valid persistent session who merely reopens the app is
  **not** redirected (they weren't just told to complete it); the nudge returns
  on their **next actual login**.

## Current behavior (what exists today)

- **Auth:** `login-page` → `otp-page` → `verifyOtp` → on success
  `navigate(state.redirectTo ?? '/', { replace: true })` (`otp-page.tsx:66`).
- **Home landing for a no-profile user:** `home-page` shows an empty-state
  "Create your profile" card + button (`home.empty_create_*`), and for a
  consent-pending draft it shows the `ProfileConsentModal` popup.
- **Profiles:** `useMyItems(network)` fetches the user's items per served domain
  (`created_by_me`), each with `lifecycle_status`. Active profile = stored id
  (`getStoredActiveProfileId`) else `myItems[0]`.
- **Profile form (`profile-form-page.tsx`)** already:
  - pre-fills `name` + `phone` from the account (`user?.name`, `user?.phoneNumber`),
  - **gates submit**: the create button is disabled until the consent checkbox is
    ticked (and required fields filled) — so **a partial draft can't be submitted
    from this form**; it always aims for `live`. Backing out saves nothing.
  - handles the U18 guardian gate at the consent tick.
- **Routes:** `/profile/new`, `/profile/:id/edit` → `ProfileFormPage`.

So: the form is already "complete-or-back"; we mainly need the **redirect
decision** + the **purpose statement**, plus leaving the consent modal for the
has-live case.

## Design

### 1. Post-login redirect (the core change)

Add a pure helper (unit-testable, no React):

```ts
// apps/ui/src/lib/post-login-route.ts
type ProfileLite = { item_id: string; item_domain: string; lifecycle_status: string };

/** Where to send the user right after login. Returns null → land normally. */
export function resolvePostLoginRedirect(
  profiles: ProfileLite[],
  storedActiveId: string | null,
): { path: string } | null {
  const hasCompleted = profiles.some(
    (p) => p.lifecycle_status === 'live' || p.lifecycle_status === 'paused' || p.lifecycle_status === 'retired',
  );
  if (hasCompleted) return null;                 // completed profile → no redirect
  if (profiles.length === 0) return { path: '/profile/new' };
  const drafts = profiles.filter((p) => p.lifecycle_status === 'draft');
  const active = drafts.find((p) => p.item_id === storedActiveId) ?? drafts[0];
  return { path: `/profile/${active.item_id}/edit` };
}
```

Wire it into `otp-page.tsx` at the success exit (line ~66): after `verifyOtp`
resolves and the consent/U18/domain-gate flow has settled, **fetch the user's
profiles** for the served network(s) (reuse the `useMyItems` query fn /
`fetchItems(..., created_by_me)`), read the stored active id, call
`resolvePostLoginRedirect`, and:
- redirect result → `navigate(result.path, { replace: true })` (**takes
  precedence over `redirectTo`** — a user with no live profile can't act on a
  deep-linked action anyway).
- `null` → existing `navigate(state.redirectTo ?? '/')`.

Notes:
- The profile fetch is a one-time call at login; failure is **fail-open** (on
  error, fall through to normal landing — never block login).
- Multiple served domains: `fetchItems` already runs per domain; empty → create.

### 2. Purpose statement (per-domain, from `network.json`)

Add an **optional per-domain** field to `network.json`:

```jsonc
// domains[].profile_completion_prompt
{ "heading": "…", "body": "…" }
```

Displayed prominently on `ProfileFormPage` (create + editing-a-draft), resolved
from the selected domain. Absent → a generic i18n fallback
(`profile.completion_prompt_default_*`). The engine schema type
(`DotNetworkDomain`) gains the optional field; it's not part of item validation
(purely presentational).

**Proposed copy (editable):**
- **seeker:** heading *"Complete your profile to get discovered"* · body
  *"Employers can find and connect with you only once your profile is live. Fill in the details below to start getting opportunities."*
- **provider:** heading *"Complete your profile to start hiring"* · body
  *"Seekers can see and apply to you only once your profile is live. Add the details below to reach candidates."*

### 3. Consent modal — retained (no change to its trigger)

`ProfileConsentModal` stays exactly as-is: it still appears when a user **who has
a live profile** switches to / opens a **consent-pending draft**. It does not
fire for the redirect case (those users are on the edit page, which captures
consent via its own checkbox). Because the redirect only runs at login for
no-completed-profile users, the two never overlap.

## Edge cases / decisions

- **`redirectTo` deep link:** overridden by the profile redirect when no completed
  profile (they need a profile first).
- **Back from the profile page:** normal navigation to `/`; no re-redirect (the
  check is login-only), so no loop. The form's existing back/cancel affordance is
  sufficient.
- **Partial draft:** not submittable from the form (consent-gated) — unchanged.
- **Signed-out users:** unchanged (guest browse).
- **Persistent session reopen:** not redirected (no fresh login); nudge returns on
  next login.

## Files to touch

- `apps/ui/src/lib/post-login-route.ts` (new) + test.
- `apps/ui/src/pages/auth/otp-page.tsx` — call the helper at the success exit;
  fetch profiles.
- `apps/ui/src/pages/profile-form-page.tsx` — render the per-domain prompt.
- `apps/ui/src/engine/types.ts` — add optional `profile_completion_prompt` to
  `DotNetworkDomain`.
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — default prompt fallback copy.
- `examples/schemas/blue_dot/network.json` — add `profile_completion_prompt` to
  seeker + provider (sample content).
- (Docs) `docs/operations/*` if a network-config field needs documenting.

## Testing

- Unit (`post-login-route.test.ts`): no profiles → `/profile/new`; all draft →
  edit active (stored) draft; stored id not a draft → first draft; ≥1
  live/paused/retired → `null`; mixed live+draft → `null`.
- otp-page: verify redirect fires on login for no-completed-profile, and normal
  navigation otherwise; fail-open on fetch error.
- Manual: fresh user (no profile) → create page w/ prompt; user w/ only a draft →
  edit page; user w/ a live profile + drafts → lands normally, and opening a
  draft still shows the consent modal.

## Out of scope

- Changing the profile form's submit/consent gating (already complete-or-back).
- The `ProfileConsentModal` behavior for has-live users (retained as-is).
- Any server/API change (this is a UI routing + config-display change).
