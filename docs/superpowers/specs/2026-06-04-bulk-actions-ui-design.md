# Bulk Actions UI + Map-Popup Redesign — Design

**Date:** 2026-06-04
**Branch:** `feature` (UI work; localization keys land on this branch)
**Status:** Approved design — ready for implementation plan

## Goal

Surface the two bulk action APIs (`/api/v1/action/perform`, `/api/v1/action/update-status`) in the UI, and redesign the map marker popup so it can initiate a Connect / See Match Score directly (today those CTAs exist only in the list/grid views).

Three user-facing capabilities:

1. **Bulk connect** from the Browse grid — select multiple listings, connect to all at once.
2. **Bulk accept / reject / cancel** from My Actions — select multiple incoming/outgoing requests, act on all at once.
3. **Map popup** gains a branded, theme-coloured card with **Connect** + **See Match Score** buttons.

The backend already accepts arrays on both endpoints and returns a `{ results, summary }` envelope (best-effort, per-item, HTTP 201/200 · 207 partial · 422 all-failed). This work is UI-only.

## Non-goals

- No changes to the bulk API contract or the backend.
- No bulk on the map (the map gains single-target Connect/Match-Score per popup only; multi-select stays list-only).
- No bulk for any create endpoint (descoped earlier by the client).
- Schema form-field localization stays deferred (see memory `ui-localization-scope`).

## Constraints (must not break)

- **Card fields are schema-driven and per-network.** The visible rows (e.g. Category, Services Offered, Service Cities for purple_dot; a different set for blue_dot) come from each network's item schema + `item.data`, and that resolution is already handled. The map-popup redesign and every card wrapper must keep rendering fields from `marker.data` / schema exactly as today — only the chrome (header, buttons, selection ring) changes, never the field-resolution logic.
- **Bulk + Select are gated on an active profile.** Connect already only appears for a signed-in user who has a profile in the current domain (`myItem` present). The **Select** toggle and all bulk actions follow the same gate: when `myItem` is null (guest, or signed-in without a profile here), no Select toggle renders and the grid behaves as today. My Actions is already a signed-in-only page, so the gate is implicitly satisfied there.

## Vocabulary

- **domain** — a role inside the network (e.g. `provider`, `seeker`). Each domain has its **own item schema** and its **own connect action** with its **own requirement form + consent text**.
- **single-domain tab** — Browse filtered to one domain; every card shares one schema.
- **All tab** — Browse showing every domain mixed together; cards span multiple schemas.

---

## Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Map popup style | Option B — branded gradient header |
| Popup colour | Dynamic per network (`--primary`), never hardcoded purple |
| Selected-card visual | Style 1 — brand ring + corner check (white background) |
| Entering select | Explicit **Select** toggle (off = cards behave normally) |
| Bulk connect flow | One shared requirements form + consent, applied to all selected |
| Bulk accept/reject flow | One confirm dialog; shared optional reason note for reject |
| Where Select appears | Browse (single-domain + All) → Connect; My Actions Received → Accept/Reject; My Actions Initiated → Cancel |
| All-tab cross-domain | **Lock to first-selected domain** — other-domain cards dim until Clear |

---

## Architecture

### Shared selection primitives (new, reusable)

These three units are deliberately small and decoupled so each list page composes them without the pages knowing about each other.

#### `hooks/use-card-selection.ts`
A Set-based selection hook. One instance per list page.

```
useCardSelection() → {
  selectMode: boolean
  enterSelect(): void          // turns mode on
  exitSelect(): void           // turns mode off AND clears
  selected: Set<string>        // selected item ids
  toggle(id: string): void
  clear(): void                // empties selection, stays in select mode
  lockKey: string | null       // the group key the batch is locked to (domain or status), or null
  setLockKey(key: string | null): void
}
```

- `toggle` is a no-op for an id whose group key ≠ current `lockKey` (when a lock is set). The page decides what `lockKey` means (domain on Browse-All, nothing on single-domain, status implied on My Actions).
- Exiting select mode always clears selection and lock.

**Responsibility:** owns *which ids are selected* and *what the batch is locked to*. Knows nothing about rendering or APIs.

#### `components/selection/selectable-card.tsx`
A thin wrapper around any existing card. Passthrough when not selecting.

```
<SelectableCard
  id={string}
  selectMode={boolean}
  selected={boolean}
  selectable={boolean}   // false → dimmed + non-interactive (locked-out group)
  onToggle={() => void}
>
  {children}            // the existing DomainCard / MatchScoreCard / ActionCard
</SelectableCard>
```

- `selectMode && selectable` → the whole card area is a click target (`onClick={onToggle}`, `role="button"`, keyboard Enter/Space), with a brand ring (`ring-2 ring-primary`) and a corner check badge when `selected`.
- `selectMode && !selectable` → `opacity-45 pointer-events-none` (dimmed, can't be picked).
- `!selectMode` → renders `children` unchanged, no wrapper behaviour.

**Responsibility:** the *visual + click affordance* of selection. Knows nothing about what's inside the card or what the action is.

#### `components/selection/bulk-action-bar.tsx`
Sticky bottom bar shown only while `selectMode && selected.size > 0`.

```
<BulkActionBar count={number} onClear={() => void}>
  {children}            // action buttons (Connect / Accept+Reject / Cancel)
</BulkActionBar>
```

**Responsibility:** layout + count + Clear. The page supplies the action buttons as children.

### Hiding per-card buttons in select mode

In select mode the inner cards must not show their own Connect/Accept/Reject buttons (avoids dead-looking buttons under the click overlay). Add an optional `selectionMode?: boolean` prop to the inner card components that, when true, suppresses the action footer:

- `components/cards/domain-card.tsx` — hide the action footer when `selectionMode`.
- `components/match-score/match-score-card.tsx` — forward `selectionMode` to `DomainCard`; also suppress the match-score CTA.
- `components/actions/action-card.tsx` — hide the accept/reject/cancel/complete/view-contact footer when `selectionMode`.

Default (`undefined`/`false`) preserves today's behaviour exactly.

---

### Bulk API client functions

Both endpoints are already array-aware on the backend. Today `action-api.ts` sends array-of-one and unwraps `results[0]`. Add two functions that send the **full** array and return the **whole envelope** (so the UI can render partial-success):

```
// lib/action-api.ts
performActionsBulk(
  payloads: PerformActionPayload[],
  sourceInstanceUrl?: string,
): Promise<BulkEnvelope<PerformActionResponse>>

updateActionStatusBulk(
  payloads: UpdateActionStatusPayload[],
): Promise<BulkEnvelope<UpdateActionStatusResponse>>
```

- `BulkEnvelope<T>` already exists in `lib/bulk.ts`.
- Existing single `performAction` / `updateActionStatus` stay unchanged (still array-of-one + unwrap), used by single-card flows and the map popup.

**Why one call works for each:**
- **Connect:** the source instance is always *your own profile's* instance (`sourceItemInstanceUrl` derives from `myItem` only, regardless of target). So all selected targets share one source instance → one array POST. The backend loops per-item over the peer endpoint.
- **Accept/Reject/Cancel:** every target action is self-owned and lives on your instance → one array POST.

---

### Browse — bulk connect (`pages/home-page.tsx`)

**Structural change:** today `ActionHandler` wraps only the list branch (`viewMode === 'list' ? <ActionHandler>…</ActionHandler> : <MapView/>`). Hoist `ActionHandler` so it wraps **both** branches — the map popup needs `triggerAction` too.

**Selection wiring:**
- One `useCardSelection()` instance.
- A **Select** toggle button rendered into `ContentHeader.actions` (the slot already exists, currently unused on this page) — **only when `myItem` is present** (same gate as the Connect CTA). Guests / profile-less users never see Select.
- Wrap each `DomainCard` / `MatchScoreCard` in `<SelectableCard>`. Pass `selectionMode` to the inner card.
- **Lock key = domain.** Single-domain tab: every card's domain equals `selectedDomain`, so the lock is a no-op. All tab: the first toggle sets `lockKey` to that card's domain; cards of other domains render with `selectable={false}` (dimmed).

**Connect-all flow:**
1. Bulk bar shows `Connect all (N)`.
2. Clicking it opens the existing `ActionModal` **once**, using the same connect action the single-card flow uses for the locked domain — the connect entry from `getActionsForDomain(lockDomain)` (the first/connect action, matching what `CardGrid`/`MatchScoreCard` pass to `triggerAction` today). The shared requirements form + consent are filled once.
3. On submit, build one `PerformActionPayload` per selected id (same `requirements_snapshot` + `consent` for all; per-target `target_item` resolved the same way the single flow does today), then call `performActionsBulk(payloads, sourceItemInstanceUrl)`.
4. Handle the envelope:
   - all succeeded → success toast (`Connected N`), exit select mode.
   - `summary.failed > 0` → partial toast (`Connected X of N`); keep the **failed** ids selected (map `results` errors back to ids by index) so the user can retry; show the first error message.

### My Actions — bulk accept / reject / cancel

Files: `pages/my-actions-page.tsx`, `components/actions/action-list.tsx`, `components/actions/action-card.tsx`, plus a new `components/actions/bulk-status-dialog.tsx`.

- One `useCardSelection()` instance (lives where the tab + list state lives).
- **Select** toggle near the filter chips in `ActionList`.
- Wrap each `ActionCard` in `<SelectableCard>`. `selectable` is computed from the card's actionable state:
  - **Received** tab: `selectable = status ∈ {created, pending}` → bulk Accept / Reject.
  - **Initiated** tab: `selectable = status ∈ {created, pending}` → bulk Cancel.
  - Non-actionable (accepted/rejected/completed/cancelled) → dimmed.
- Bulk bar buttons depend on tab: Received → `Reject` + `Accept`; Initiated → `Cancel`.
- Clicking a bulk button opens **`bulk-status-dialog.tsx`**: a single confirm (`Accept N requests?` / `Reject N requests?` / `Cancel N requests?`). Reject shows one optional reason `Textarea` applied to all.
- On confirm, build one `UpdateActionStatusPayload` per selected `action_id` (`action_status` = `accepted` / `rejected` / `cancelled`; shared `remarks` for reject; shared `consent` when the interaction requires receiver consent — resolved once from network config), then call `updateActionStatusBulk(payloads)`.
- Envelope handling mirrors connect: success toast, or partial toast keeping failed ids selected; refetch the action list on completion.

> **Consent on bulk accept:** if the action's interaction defines `consent_text_receiver`, the confirm dialog shows the shared consent acknowledgement once (like the single `ActionStatusUpdater`), and the same `consent` object is attached to every payload.

---

### Map popup redesign

#### Threading (provider-agnostic)
Add an optional render-prop to the provider contract so the page controls popup content while providers stay generic:

```
// engine/types.ts
interface MapProviderProps {
  …existing…
  renderPopup?: (marker: MapMarker) => React.ReactNode;
}
```

- Both providers (`leaflet-provider.tsx`, `google-maps-provider.tsx`) render `renderPopup ? renderPopup(marker) : <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />`. Their `<Popup>` / `<InfoWindow>` already render real React children, so button `onClick` handlers work.
- `MapView` (`map-container.tsx`) accepts `renderPopup?: (marker) => React.ReactNode` and forwards it to the active provider.

#### Page wiring (`home-page.tsx`)
`home-page` supplies `renderPopup` (inside the hoisted `ActionHandler`, so `triggerAction` is in scope). For each marker it resolves:
- `actions = getActionsForDomain(marker.domain)` → the Connect action.
- `networkItem` = full `Item` looked up by `marker.id` from `domainItems` (fallback synthesised item, same shape used by the All-tab `MatchScoreCard`).
- `localItem = myItem`.
- `onConnect = () => triggerAction(connectAction.action_type, connectAction, marker.id)`.

#### Redesigned `MarkerPopupCard` (presentational)
New props (all optional so the default render path still works):

```
interface MarkerPopupCardProps {
  marker: MapMarker;
  onViewDetails?: (id: string) => void;
  actions?: DotActionSchema[];
  onConnect?: () => void;
  localItem?: Item | null;
  networkItem?: Item | null;
}
```

Visual (Option B):
- **Branded header**: gradient from `var(--primary)` (theme-dynamic) → avatar initials + name + domain badge + precision sub-line, all on the coloured header.
- **Body**: schema-driven fields straight from `marker.data` with the same `HIDDEN_KEYS` filtering as today (per-network, already handled — do not change the field-resolution logic, only the surrounding chrome).
- **Footer buttons**: `See Match Score` (outline) + `Connect` (filled), shown only when the respective data/handlers are present.
- **See Match Score** embeds `useMatchScore({ localItem, networkItem })` + `MatchScoreModal`, exactly as `MatchScoreCard` does (calculate-on-demand, modal Proceed → `onConnect`). Gated on `localItem && networkItem`.
- **Connect** calls `onConnect`. When no `localItem` (not signed in / no profile) the buttons fall back to the existing `View details` link.

Colour must use the theme CSS var so it recolours per network (purple_dot, blue_dot, …) like the rest of the app.

---

## Localization

This is the localization branch — every new string goes through `t()` and gets keys added to `i18n` JSON (all enabled locales). New key groups (illustrative): `selection.*` (select, cancel, clear, n_selected), `actions.bulk_*` (accept/reject/cancel confirm titles, reason label), `home.bulk_connect_*` (connect all, connected n, connected x_of_n), `map.connect`, `map.see_match_score`.

## Error handling

- All bulk calls are best-effort server-side; the UI never assumes all-or-nothing.
- Partial (207): toast `<verb> X of N`, keep failed ids selected, surface first error message.
- All-failed (422) or network error: error toast, selection preserved, nothing exits.
- Single-target paths (map popup Connect, single-card Connect/Accept) keep using the existing unwrap-`results[0]` helpers — unchanged.

## Testing

- `use-card-selection` — toggle, lock (toggle ignored for off-lock key), clear vs exit, lock reset on exit.
- `SelectableCard` — renders children untouched when `!selectMode`; ring/check when selected; dim + non-interactive when `!selectable`.
- `performActionsBulk` / `updateActionStatusBulk` — send full array, return envelope; assert request body shape.
- Partial-result handling — given an envelope with one error, the failed id stays selected and the toast reads `X of N`.
- Map popup — renders Connect/See-Match-Score only when handlers/data present; falls back to View-details otherwise.
- Existing single-flow tests must stay green (no regression to single connect/accept).

## Files

**New**
- `apps/ui/src/hooks/use-card-selection.ts`
- `apps/ui/src/components/selection/selectable-card.tsx`
- `apps/ui/src/components/selection/bulk-action-bar.tsx`
- `apps/ui/src/components/actions/bulk-status-dialog.tsx`

**Modified**
- `apps/ui/src/lib/action-api.ts` — `performActionsBulk`, `updateActionStatusBulk`
- `apps/ui/src/engine/types.ts` — `renderPopup` on `MapProviderProps`
- `apps/ui/src/components/map/providers/leaflet-provider.tsx` — `renderPopup` fallback
- `apps/ui/src/components/map/providers/google-maps-provider.tsx` — `renderPopup` fallback
- `apps/ui/src/components/map/map-container.tsx` — accept + forward `renderPopup`
- `apps/ui/src/components/map/marker-popup-card.tsx` — redesign (branded header, buttons, match-score)
- `apps/ui/src/pages/home-page.tsx` — hoist `ActionHandler`; browse selection + bulk connect; Select toggle; `renderPopup`
- `apps/ui/src/pages/my-actions-page.tsx` — selection state plumbing
- `apps/ui/src/components/actions/action-list.tsx` — Select toggle; wrap cards
- `apps/ui/src/components/actions/action-card.tsx` — `selectionMode` prop
- `apps/ui/src/components/cards/domain-card.tsx` — `selectionMode` prop
- `apps/ui/src/components/match-score/match-score-card.tsx` — forward `selectionMode`
- `apps/ui/src/i18n/<locale>.json` — new keys
