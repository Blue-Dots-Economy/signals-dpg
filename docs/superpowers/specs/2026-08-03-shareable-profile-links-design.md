# Shareable Profile Links + Public Profile View — Design

**Issue:** [#476](https://github.com/Blue-Dots-Economy/signals-dpg/issues/476) — feat: shareable profile links + public profile view page
**Branch:** `feat/shareable-profile-links` (off `feature`)
**Status:** Draft for review
**Date:** 2026-08-03

---

## Summary / user story

Product wants users to be able to **share a profile**. A live profile card gains a **Share** button; clicking it copies a canonical link to the clipboard (with a confirmation toast). Whoever opens that link — even in a fresh, unauthenticated session — lands on Signals at a **public profile view page** that renders that one profile from its public, masked data.

## Goals

- A **Share** button on live profile cards (browse/listing cards **and** the user's own profile row) copies a working link and shows a confirmation toast.
- Opening the link in an unauthenticated session renders the correct **live** profile via the existing public, masked, jittered projection — no auth, no PII.
- Non-live / unknown / retired / errored links show a clean "profile unavailable" state (never a raw error, never PII).

## Non-goals (v1)

- OpenGraph / social link previews (needs SSR / meta injection) — deferred follow-up.
- Native share sheet (`navigator.share`) beyond copy-link.
- Share analytics / telemetry.
- Opaque share tokens with revocation/expiry, and any token store.
- Direct-to-owning-instance routing (federation optimization).

---

## Key decisions (locked)

1. **Reuse the existing public fetch — no new backend for v1.** The public, no-auth, masked, jittered, **live-only** single-item fetch already exists and already supports keying by `item_id`.
2. **Link = raw item key**, not a token: `/p/<network>/<domain>/<item_type>/<item_id>`. The profile id is already public via map/discover, so the raw key exposes nothing new, and it works with the existing endpoint with zero backend. An opaque token (hiding the id, enabling revoke/expiry) is a possible *future* enhancement only if revocation/expiry is ever required — it is not built in v1 (no token store).
3. **No owner opt-in** — any live profile is shareable by anyone. A live profile is already publicly discoverable via map/discover, so a share link exposes nothing new.
4. **No minor gating** — a live profile is already public; minors' live profiles are shared with the same masking as everyone else's. (Minor status is user-level anyway and absent from the public item — see Constraints.)
5. **Share button appears only on `lifecycle_status === 'live'` profiles**, at both call sites.
6. **Recipient side is binary:** live item returned → render; empty result or error → "unavailable". We do not (and cannot) distinguish paused vs retired vs never-existed.
7. **Approach: a new unauthenticated route in the existing portal SPA** (not the tourist app, not SSR).
8. **Federation: no multi-server link routing in v1.** Single-instance today. The reused `GET /network/item/fetch` already fans out across all instances serving the domain and merges, so links keep resolving even if the network is split across servers later. Direct-to-owning-instance routing (via the profile's `item_instance_url`) is a *future performance optimization only*, not a v1 requirement.
9. **Canonical host: build links from the current site's origin** (`window.location.origin`). The portal and the public-view page share one host today; a fixed canonical/branded domain is not needed for v1 (would be a config-sourced base URL if ever wanted).
10. **OpenGraph / social link previews: not in v1.** The rich WhatsApp/social preview needs SSR / meta injection; deferred to a follow-up. The core flow (copy link → recipient sees the profile) does not depend on it.

---

## Architecture

The feature is **UI-only for v1**. The backend already serves exactly what the public page needs.

```
Share (live card / own-profile row)
  └─ buildProfileShareUrl(item) → ${origin}/p/${network}/${domain}/${itemType}/${itemId}
     └─ navigator.clipboard.writeText(link)  → sonner toast ("Link copied")

Recipient opens link (fresh, unauthenticated)
  └─ static host: try_files $uri /index.html  → SPA boots
     └─ Route /p/:network/:domain/:itemType/:itemId  (NOT wrapped in RequireAuth)
        └─ PublicProfilePage
           ├─ useResolvedNetwork(network)   → schema + card config, theme
           └─ useItemDetail(network, {item_id, item_domain, item_type})
              └─ GET /api/v1/network/item/fetch?item_id=…&item_network=…&item_domain=…&item_type=…&limit=1
                 (public, no auth, masked projection, jittered locations, lifecycle_filter=live_only)
              → live item  → render <DomainCard variant="list">
              → empty/error → "profile unavailable" page
```

### Why the existing pieces already cover the backend

- `GET /api/v1/network/item/fetch` has **no `preHandler`** and no `acting_org` — genuinely public (`apps/api/src/routes/v1/network/item/fetch_item.ts`). Registered with no group-level auth hook (`network_routes.ts`).
- Its query schema accepts `item_id` (uuid) plus `item_network` / `item_domain` / `item_type` / `item_instance_url`; the handler forwards them into `fetchItemsAcrossInstances`, whose `buildWhereClause` adds `eq(items.item_id, …)` (`apps/api/src/utils/item_fetch_runtime.ts`).
- The public path **never** passes `includePrivateState`, so `fetchLocalItems` strips `item_private_state` and never calls `decryptItemPrivate` (`item_fetch_runtime.ts`, `item_decrypt.ts`). Locations are jittered at storage time (the true coordinate is never stored), so returned coordinates are inherently coarsened.
- The handler hard-codes `lifecycle_filter: 'live_only'` — a non-live profile returns **no row** (`items: []`), never a non-live status row.

So a "fetch one live profile by key, masked" call is `GET /network/item/fetch` with `item_id` + the key fields and `limit:1`. The UI already does exactly this via `useItemDetail`.

---

## Detailed design

### 1. Public route + page (net-new)

- Add to `apps/ui/src/app.tsx`, **outside `RequireAuth`** (auth is per-route today; `/`, `/privacy`, `/terms` are already unauthenticated, and the app is wrapped in `NetworkThemeProvider`, so a new public route is themed and does not redirect to login):
  ```tsx
  <Route path="/p/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
  ```
- **`PublicProfilePage`** (new, `apps/ui/src/pages/public-profile-page.tsx`):
  - Reads `network`, `domain`, `itemType`, `itemId` from route params.
  - Validates `itemId` is a UUID and `network`/`domain`/`itemType` are non-empty; a malformed key short-circuits to the unavailable state (no fetch).
  - `useResolvedNetwork(network)` → resolved network config (drives the item schema + the domain's `card` config, and theming).
  - `useItemDetail(network, { item_id: itemId, item_domain: domain, item_type: itemType })` → the existing hook that calls `GET /network/item/fetch` with `limit:1` and returns the single `Item` (masked) or nothing.
  - Renders the profile via the existing schema-driven **`DomainCard`** (`variant: 'list'`, "View more details" accordion) fed the item's `item_state`, the resolved schema, and the domain's card config — identical to how browse renders a card. No PII (masked `item_state` only).
  - Standalone page chrome (brand header/logo, themed), **not** the authed sidebar/topbar. Reuse the brand header primitives already used by the legal pages where possible.

**Reference template:** `MarkerDetailPopup` (`apps/ui/src/pages/home-page.tsx`) already fetches a single item with `useItemDetail`, handles loading + not-found, and renders a card. `PublicProfilePage` lifts that pattern into a standalone routed page.

### 2. Data flow & states

| Condition | Result |
|---|---|
| Live item returned | Render `<DomainCard variant="list">` |
| Empty result (`items: []`) — paused / retired / draft / deleted / never existed | "Profile unavailable" page |
| Malformed key (bad UUID / empty part) | "Profile unavailable" page (no fetch) |
| Unknown network in URL (config resolve fails) | "Profile unavailable" page (safe default theme) |
| Transient API/network error (5xx / offline) | "Something went wrong — try again" page |
| Loading | Skeleton / spinner |

Binary available/unavailable is intentional — the public endpoint returns only live items, so paused vs retired vs not-found are indistinguishable and collapse to "unavailable." The transient-error state is split only for nicer copy; both are PII-free, non-error-surfacing pages. i18n keys for all copy (en/hi/kn).

### 3. Share button + link generation

- **Call sites (both gated to `lifecycle_status === 'live'`):**
  1. The browse/listing card — `apps/ui/src/components/cards/item-card.tsx` / `domain-card.tsx` (everything shown there is already live; still gate defensively).
  2. The **My Profiles** row — the sidebar profile-row component (which lists draft/paused/live; button shows only for live rows).
- **Link builder** — a small shared helper `buildProfileShareUrl(item)`:
  ```ts
  `${window.location.origin}/p/${item.item_network}/${item.item_domain}/${item.item_type}/${item.item_id}`
  ```
  (Uses `window.location.origin` — the portal and public-view share one host today; see Key decisions #9.)
- **Copy + toast** — a shared `useShareProfile()` hook wrapping:
  - `navigator.clipboard.writeText(link)` → success `toast()` ("Link copied", via **sonner**, already mounted app-wide in `app.tsx`).
  - **Fallback** when the Clipboard API is unavailable / permission-denied: hidden `<textarea>` + `document.execCommand('copy')`; if that also fails, surface the link in a prompt/toast so the user can copy manually. Mirrors the existing clipboard pattern in `apps/ui/src/components/wallet/providers/digilocker-provider.tsx`.
- One implementation shared by both call sites (no duplicated clipboard/toast logic).

### 4. Theming

The target network comes from the **URL path**, not the env default. `PublicProfilePage` drives the theme to `params.network` — resolving the network theme (per-network base + per-brand override) for the URL's network rather than the deployment default, so a `/p/blue_dot/...` link renders in blue_dot's theme regardless of the visitor's stored/default network. Unknown network → unavailable state under a safe default theme.

### 5. Safety / PII / minors

- Reuses the masked (`item_private_state` never read/decrypted) + jittered-location + live-only projection — identical exposure to map/discover, which is already public and unauthenticated.
- No contact information on the public page. PII disclosure stays behind the existing authenticated **connect/apply → contact-details** flow.
- No minor gating: minor status is user-level (`user.age`, `is_minor`), not present on the item, and a live profile is already publicly discoverable. (If product later mandates excluding minors from public links, that gating data is net-new — it would require surfacing a signal onto the item or a user join on the public fetch — flagged, not built.)

### 6. Error handling

`PublicProfilePage` never renders a raw error or stack. All failure modes (bad key, unknown network, empty result, 5xx) resolve to the unavailable or transient-error page. No PII in any state.

---

## Constraints (from the codebase)

- **`lifecycle_status` on the public response:** present in the schema/projection, but the public fetch hard-codes `live_only`, so non-live profiles return `items: []` (no status row). → drives the binary available/unavailable UX.
- **Retire is destructive:** a retired profile is PII-scrubbed and de-indexed, so its link resolves to empty → unavailable. Correct by construction.
- **Minor is user-level:** `packages/schemas/src/u18_consent.ts` (`is_minor` derives from `user.age`); no per-item minor flag; the public item carries no minor signal and the public fetch has no user join.
- **Static SPA fallback already exists:** `apps/ui/Dockerfile` (`location / { try_files $uri /index.html; }`) — deep links serve `index.html`, so `/p/...` cold-loads with no new rewrite/deploy config.
- **Caching:** the shared card is live-fetched, but the client `useItemDetail` staleTime (~5 min) + server cache TTLs mean an owner's edit may take a few minutes to appear. It is live data, never a snapshot from share time.

---

## Testing

- **UI unit:**
  - `buildProfileShareUrl` — correct URL from an item key.
  - Share button — renders only when `lifecycle_status === 'live'`; success path shows the toast; fallback path fires when Clipboard API is absent.
  - `PublicProfilePage` — loading, live-render, empty→unavailable, malformed-key→unavailable, transient-error states; route requires no auth.
- **API:** no new endpoint. Add/confirm a test asserting a keyed `item_id` fetch returns the **masked, live-only** projection (regression guard against ever exposing `item_private_state` on the keyed path).
- **Manual / e2e:** a cold link in a fresh incognito session renders the live profile with masked data; a paused/retired profile's link shows unavailable; theming matches the link's network.

---

## Out of scope / follow-ups

- OpenGraph / social link previews.
- Native share sheet (`navigator.share`).
- Share analytics / telemetry.
- Opaque token store + revocation/expiry.
- Direct-to-owning-instance federation routing.

---

## References

- Issue: [#476](https://github.com/Blue-Dots-Economy/signals-dpg/issues/476)
- API (reused): `apps/api/src/routes/v1/network/item/fetch_item.ts`, `apps/api/src/utils/item_fetch_runtime.ts`, `apps/api/src/utils/inter_instance_fetch.ts`, `apps/api/src/utils/item_decrypt.ts`, `apps/api/src/routes/v1/network/network_routes.ts`.
- UI (reused): `apps/ui/src/app.tsx`, `apps/ui/src/hooks/use-item-detail.ts`, `apps/ui/src/components/cards/{domain-card,item-card,resolve-card-fields}.ts(x)`, `apps/ui/src/lib/{network-api,item-api}.ts`, `apps/ui/src/hooks/use-network-config.ts`, `apps/ui/src/theme/*`, `apps/ui/src/pages/home-page.tsx` (`MarkerDetailPopup` template), `apps/ui/src/components/wallet/providers/digilocker-provider.tsx` (clipboard pattern), `apps/ui/Dockerfile` (SPA fallback).
- Related prior work: PR #398 (map server-side), PR #419 (list discover) — established the public masked-fetch model this builds on.

---

## Addendum (2026-08-04) — V2: public page inside the app shell, auth-aware + Apply/Connect

After the initial standalone page shipped, product asked for the public profile view to look like the rest of Signals and to be actionable for signed-in users. The `/public/...` route (renamed from `/p/...`) stays **public (no `RequireAuth`)** but the component now renders **auth-aware** in three modes. Data is **always the masked public projection** in every mode; contact is still revealed only through the existing connect-acceptance flow (no new PII), and Apply/Connect goes through the authenticated action API (interaction-matrix + source-ownership enforced server-side).

### Three modes (same route, same masked data)

| Mode | Detection | Shell | Extra |
|---|---|---|---|
| **Anonymous** | no session | Signals shell **stripped** to the relevant chrome: logo (left) + **Theme toggle · "Explore more" (→ home `/?network=`) · "Sign in" (→ `/auth/login`)** (right); sidebar = branding only (no My Profiles / actions) | Copy link; no apply |
| **Logged-in, own profile** | session + viewed `item_id` ∈ the user's own items | **full** shell (their sidebar incl. active-profile selection, app bar, logo) | banner: *"This is the public view others see when you share your profile — contact details stay hidden until someone connects."*; Copy link; no apply (it's theirs) |
| **Logged-in, other profile** | session + not own | full shell | **Apply/Connect** using the user's **active profile** (`activeProfileId`) as the source — shown only when the active profile can act on the viewed profile (interaction matrix); hidden with a "switch to a compatible profile" hint otherwise. Copy link. **No Match Score** (it needs an unambiguous source pick). |

### Layout
- Content area (where the map/list normally sits) renders the schema-driven profile details (hero + table grid from `resolveCardFields`) — unchanged from V1, just placed inside the shell's main slot.
- Uses the **same Blue Dots logo** as the rest of the UI (not a text initial).
- The stripped top bar for the anonymous mode omits: search, Filters, map/list toggle, notifications, user menu, language switcher (per product — kept: theme, Explore more, Sign in).

### Decisions locked
- Rename route prefix `/p/` → **`/public/`**; the "Open in Blue Dots" CTA → **"Explore more"** (→ public home).
- Own-profile view is intentionally **masked** (the point is to preview the shared view) + the explanatory banner.
- Apply/Connect source = the app's **active profile**; the logged-in view exposes the normal sidebar so the user can switch it; incompatible active profile → action hidden.
- Match Score is out of scope on this page.
- Still no owner opt-in, no minor gating, still public route, no backend change (Apply/Connect reuses the existing authenticated action flow).
