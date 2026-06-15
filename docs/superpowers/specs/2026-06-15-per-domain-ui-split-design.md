# Per-domain Signals UI split — Design

**Date:** 2026-06-15
**Branch:** `feat/per-domain-ui-split` (from `feature`)
**Status:** Approved design pending user review → implementation plan

## Goal

Let the **same** signals UI build be deployed as multiple instances, each scoped
to a single `network/domain` (e.g. `purple_dot/provider` and
`purple_dot/seeker`), selected purely by a **runtime config value** — no second
Vite entry, no second `dist`, no separate image. Same backend API for all
instances. When the config value is absent, the UI behaves exactly as it does
today (multi-domain, backward-compatible).

This is explicitly **not** the tourist approach (`VITE_APP=tourist` →
`index.tourist.html` → `dist/tourist`), which produces a different build for a
structurally different app. Here every instance is the same app; only *which
domain you act as* and *what you browse* differ, and those already derive from
one value (`currentDomain`).

## Mental model (confirmed)

A per-domain UI is named by **who you act as**, and it shows **your interaction
targets** (the domains your domain can initiate toward, from the network.json
`actions[].interactions[]` edges):

- **provider UI** → you act as a provider → you browse **seekers** (and
  providers, via the `provider → provider` edge).
- **seeker UI** → you act as a seeker → you browse **providers** (`seeker →
  provider`).

This falls straight out of the existing connect logic
(`getActionsForTarget`: `from_domain === currentDomain`); the binding simply
fixes `currentDomain` for the whole instance instead of deriving it from the
logged-in user's profile.

## Decisions (locked)

1. **Config knob = a `network/domain` pair**, runtime-only:
   `VITE_SERVED_BINDING=purple_dot/provider`. It pins both the network and the
   acting domain and hides the network selector. One self-contained value.
2. **Cross-domain login is blocked at login.** After identity is verified, if
   the user already holds a profile in a **different** domain of the bound
   network, login is refused with a message naming their domain (e.g. "This
   email/phone already has a profile in the **seeker** domain — please use the
   seeker portal"). No profile anywhere, or a profile in the **bound** domain →
   login proceeds. (Message is **name-only** for now; a clickable portal link is
   a future enhancement, not in scope.)
3. **No domain-picker page for profile creation.** In a bound UI, choosing
   "create profile" goes **directly** to the form for the bound domain — the
   domain/role selection step is not rendered at all.
4. **Unset key = today's behavior**, byte-for-byte. The split is additive and
   opt-in per deployment.

## Architecture

One runtime key flows through the existing `config.js` → `getRuntimeEnv`
mechanism (`apps/ui/src/lib/runtime-env.ts`), is parsed once into a small
module, and is consulted at each domain-resolution point. Nothing build-time
changes; the deploy chart writes a different `config.js` per instance, exactly
as it already does for `VITE_API_URL` etc.

### Component 1 — `served-binding` module (new)

`apps/ui/src/lib/served-binding.ts`:

```ts
export interface ServedBinding { network: string; domain: string; }

/** Parses VITE_SERVED_BINDING ("network/domain") from runtime/build config.
 *  Returns null when unset or malformed (→ legacy multi-domain behavior). */
export function getServedBinding(): ServedBinding | null;
```

- Reads `getRuntimeEnv('VITE_SERVED_BINDING')`, trims, splits on the first `/`,
  requires both halves non-empty; otherwise returns `null`.
- Add `VITE_SERVED_BINDING?: string` to `ImportMetaEnv` in
  `apps/ui/src/vite-env.d.ts` so `getRuntimeEnv` stays typed.
- Pure and synchronous; unit-tested in isolation.

### Component 2 — domain & browse scoping (`home-page.tsx`)

When `getServedBinding()` is non-null (`binding`):

- `selectedNetworkId` initializes to `binding.network` (instead of the
  `VITE_NETWORK_ID`/URL/first-available resolution).
- The acting domain (`currentDomain` / `viewerDomain`) is `binding.domain`,
  overriding the `myItem`-derived value. The `?as=` query override remains
  available for local testing (it sits above the binding in precedence).
- Browseable domains are scoped to the bound domain's targets via a new pure
  helper:

  ```ts
  // apps/ui/src/lib/visible-domains.ts
  export function computeVisibleDomains(
    network: DotNetworkSchema,
    viewerDomain: string | null,   // null → all to_domains (today's behavior)
  ): DotNetworkDomain[];
  ```

  `visibleDomains = computeVisibleDomains(network, binding ? binding.domain : null)`.
  With a viewer domain it returns the distinct `to_domain`s of interactions
  whose `from_domain === viewerDomain` (guarding `from_network` to the current
  network); with `null` it returns all `to_domain`s network-wide (unchanged).

- Connect actions (`getActionsForTarget`) already filter on `currentDomain`, so
  they need no change.

When `binding` is null, all of the above resolves to today's exact values.

### Component 3 — profile creation, no picker (`profile-form-page.tsx`)

When `binding` is set:

- The page renders the **form for `binding.domain` directly** — the
  domain/role picker UI is not shown. Network is fixed to `binding.network`.
- `selectedDomain` is initialized to `binding.domain`; the existing
  `lockedDomain`/`selectableDomains` machinery is bypassed in favor of the
  binding (the server `DOMAIN_LOCKED` guard in `create_item.ts` remains the
  authoritative backstop).
- Edit mode is unchanged (domain comes from the existing item).

When `binding` is null, the current picker/lock behavior is unchanged.

### Component 4 — login domain gate (new, client-side only)

No backend change. After OTP verification establishes a session, and only when
`binding` is set:

1. Fetch the user's `created_by_me` items across the bound network's domains
   (the same `fetchItems({ created_by_me: true, item_domain })` pattern the
   profile-lock lookup already uses), and collect the distinct held domains.
2. A pure helper decides the outcome:

   ```ts
   // apps/ui/src/lib/domain-gate.ts
   export type DomainGate =
     | { allow: true }
     | { allow: false; heldDomain: string };

   export function evaluateDomainGate(
     heldDomains: string[],
     boundDomain: string,
   ): DomainGate;
   ```

   - No held domains → `{ allow: true }` (new user; will create in the bound
     domain).
   - Held domains all equal `boundDomain` → `{ allow: true }`.
   - Any held domain other than `boundDomain` → `{ allow: false, heldDomain }`
     (the first mismatching domain, for the message).

3. On `allow: false`: sign the session out and show the name-only message on the
   login page, e.g. "This account already has a profile in the **{heldDomain}**
   domain. Please sign in through the {heldDomain} portal." On `allow: true`:
   proceed to the app.

**Decision — the block is post-OTP, by design.** Blocking *before* OTP (right
after the phone/email entry) was considered for better UX, but rejected: the
pre-OTP `check-user` endpoint only returns `{ userExists }`, so finding the held
domain there would require a backend change AND would expose domain membership
to **unauthenticated** callers — for purple_dot that means revealing that a
phone/email is a registered seeker (a PwD beneficiary) to anyone who types it,
and in a 2-domain network even a coarse "wrong portal" flag reveals it by
elimination. Running the gate after `verifyOtp` means only the **verified
owner** ever learns their own domain, needs no backend change, and uses only
existing endpoints. The brief authenticated window before sign-out is the
accepted cost (a misrouted user spends one OTP before being redirected).

### Component 5 — chrome, network pinning, theme

When `binding` is set:

- **Network selector hidden.** Thread a "hide network selector" flag from
  `home-page.tsx` through `page-shell.tsx` into `sidebar.tsx` (when bound, pass
  no networks / suppress the selector). The domain-tab "All" already auto-hides
  for a single browseable domain.
- **Theme / first paint.** The pre-React script in `apps/ui/index.html` gains
  `VITE_SERVED_BINDING` (split on `/` → network) as its **highest-priority**
  network source for `data-network`, so the bound network themes correctly on
  first paint with the single key (no separate `VITE_NETWORK_NAME` to keep in
  sync). `theme-provider.tsx` likewise prefers the binding's network. Theme
  remains network-scoped (both domain UIs of a network share brand) — no
  per-domain theming.

### Component 6 — backward compatibility

Every behavior in Components 2–5 is gated on `getServedBinding() !== null`.
With the key unset, the UI is the current multi-domain app with no observable
change. No existing deployment is affected until it opts in by setting
`VITE_SERVED_BINDING`.

## Deployment

- **One image** (`UI_VARIANT=signals`, the existing build). Two (or N)
  Kubernetes Deployments of it.
- Each Deployment's `config.js` sets `VITE_SERVED_BINDING` (e.g.
  `purple_dot/provider` vs `purple_dot/seeker`) and the same `VITE_API_URL`;
  two ingress hostnames (e.g. `provider.…` / `seeker.…`).
- No change to `vite.config.ts`, the `Dockerfile`, the entry, or the build
  pipeline.

## Testing

- **Unit — `served-binding.ts`:** `network/domain` → `{network,domain}`; unset
  → null; malformed (`""`, `"x"`, `"a/"`, `"/b"`, `"a/b/c"` handling) → null or
  documented behavior.
- **Unit — `visible-domains.ts` (`computeVisibleDomains`):** seeker viewer →
  `[provider]`; provider viewer → `[provider, seeker]` (order per the helper);
  `null` viewer → all to_domains; cross-network `from_network` ignored;
  receiver-only domain → `[]`.
- **Unit — `domain-gate.ts` (`evaluateDomainGate`):** no profiles → allow;
  same-domain → allow; other-domain → block with that domain; multi-domain
  anomaly (held includes another domain) → block.
- **Manual (purple_dot):** deploy/run with `config.js` `VITE_SERVED_BINDING`
  set to `purple_dot/provider` then `purple_dot/seeker`; verify: correct browse
  targets, no network selector, create-profile goes straight to the bound
  domain's form, and a seeker logging into the provider portal is blocked with
  the name-only message. With the key unset, the app is unchanged.

## Out of scope

- The `location: primary|secondary` feature (separate branch / PR #158).
- Any backend/API change (the gate and scoping are client-side; the server
  `DOMAIN_LOCKED` guard is reused as-is).
- Per-domain theming (theme stays network-scoped).
- A clickable "go to the other portal" link in the block message (future; a
  `VITE_DOMAIN_PORTALS` map could be added then).
- Multi-network selection on a bound deployment (a bound instance is one
  network + one domain).

## Open items

None. All four design questions are resolved (see Decisions).
