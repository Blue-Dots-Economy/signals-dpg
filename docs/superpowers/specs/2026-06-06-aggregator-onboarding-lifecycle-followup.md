# Aggregator-DPG — Consume Signals Onboarding Lifecycle

> **Status:** Spec (follow-up to signals-dpg `2026-06-03-participant-onboarding-lifecycle-design.md`)
> **Scope:** `aggregator-dpg` only. Voice/chat outbound is a separate spec (§9).
> **Depends on:** signals-dpg branch `spec/participant-onboarding-lifecycle` (12 commits) — must be merged + deployed before this work starts.

---

## 1. Context recap (signals-dpg side, now landed)

Signals now exposes:

- `items.lifecycle_status` ∈ `{draft, live, paused}` and `items.completion_pct` (int 0–100), classified synchronously on every item write.
- `POST /api/v1/admin/participant` accepts an optional `item_state`:
  - absent → `account_only` (user row only, no item).
  - present → user + item; classifier sets `draft` or `live`.
- `POST /api/v1/item/lifecycle` body `{ item_id, action: 'pause'|'unpause' }` for owner / `network_service`.
- Response field `owned_elsewhere: boolean` for cross-aggregator probes (no disclosure of owning org).
- Aggregator-typed acting orgs gain scoped writes on their own users (`onboardedByOrgId == acting_org.id`).
- `409 PROFILE_NOT_LIVE` on action perform / update-status when either endpoint is not `live`.
- `/api/v1/network/item/fetch` returns `live`-only.
- PII reveal (`GET /action/:id/contact-details`) requires accepted **AND** both endpoints `live` at read time.

The aggregator must adapt to all of the above. The shape of every change is **additive** — old request bodies still work; new fields are optional/opt-in.

## 2. Problem

`aggregator-dpg` currently treats `/admin/participant` as an all-or-nothing call (user + item in one shot) and assumes any successful signals create implies a discoverable, action-ready profile. With the signals lifecycle split, that assumption is wrong:

- Partial-data registrations now succeed but stay `draft` until completed.
- Outbound (voice / chat / link) is the completion path — aggregator must dispatch it.
- The aggregator dashboard needs to surface "in progress" vs "ready" vs "paused" vs "account_only" without hand-rolling derived state.
- Cross-aggregator probes must respect the `owned_elsewhere` signal instead of inferring from an empty items list.

## 3. Goals

- Accept partial registrations without failing.
- Trigger completion campaigns (sms / voice / chat) when the resulting signals row is `draft`.
- Render lifecycle + completion% on the participant list / dashboard tiles.
- Cleanly handle the four signals response shapes: created-new (full or draft), account-only, own-existing (now write-through), `owned_elsewhere`.
- Stop relying on "empty items array" as a foreign-owned signal — read `owned_elsewhere: true` instead.

## 4. Non-goals (deferred to separate specs)

- Voice / chat IVR / chat-bot completion flows. Aggregator just **dispatches** the campaign; the outbound channels are a follow-up.
- Notification of counterparties when signals auto-cancels their pending action because an endpoint left `live` (counterpart-side UX is a separate signals follow-up).
- Aggregator-internal `participants` table denormalization of `lifecycle_status` (read-time fetch is good enough for v1; reconciliation is a Plan B item).

## 5. Database changes (aggregator-dpg)

Minimal, all additive. One new migration script in `aggregator-dpg/packages/database/src/utils/sql_scripts/`.

### 5.1 `registration_links` — `completion_actions` JSON column

```sql
ALTER TABLE registration_links
  ADD COLUMN IF NOT EXISTS completion_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
```

`completion_actions` is an ordered list of dispatch directives that fire **iff** the resulting signals item lands in `lifecycle_status = 'draft'`. Each element:

```jsonc
{
  "channel": "sms" | "voice" | "chat",
  "template_id": "string",      // outbound vendor template ref
  "delay_seconds": 0,           // queue offset; 0 = immediate
  "max_retries": 3
}
```

No new tables. The dispatcher (§7) reads this column when the signals response comes back as `draft`.

### 5.2 No `participants.lifecycle_status` mirror

We do **not** add a column for the lifecycle status on `aggregator-dpg/participants`. Dashboard / list endpoints fetch it from signals at read time (cached via the existing inter-instance Redis layer signals already maintains). Avoids two-write reconciliation. If profiling later proves this too slow, a cached mirror is a follow-up — out of scope here.

## 6. Identity lookup endpoint — `GET /v1/lookup`

New aggregator endpoint that **does not** depend on the participant route. Consumed by the public registration link UI before submitting, so a user already onboarded by another aggregator sees an "already registered elsewhere" message instead of a generic "create" form.

```
GET /v1/lookup?email=...&phone_number=...
Auth: aggregator's apikey + x-acting-org-id (its own org)

200 OK
{
  "user_exists": true,
  "owned_elsewhere": true,                  // mirrors signals' field
  "lifecycle_summary": null                 // null when owned_elsewhere
}

or, for an own / new user:

{
  "user_exists": true,
  "owned_elsewhere": false,
  "lifecycle_summary": {
    "primary_item": {
      "item_id": "...",
      "lifecycle_status": "draft",
      "completion_pct": 40
    }
  }
}
```

Implementation: the handler calls signals' `POST /api/v1/admin/participant` with `{ email, phone_number, name: "lookup", ...consent }` and **no `item_state`** → signals returns the account-only response. Aggregator reshapes that into the lookup payload. **Idempotent** — the route never creates a profile item itself (because no `item_state` is forwarded).

For the empty-item edge (signals returns `items: []` with `owned_elsewhere: false`): the user exists but has no profile yet → `lifecycle_summary: null`, surface as "complete your profile" in the UI.

## 7. Outbound completion dispatcher

A worker / queue consumer that:

1. After every `/admin/participant` POST that returns a `draft`-status item (signals response's `items[i].lifecycle_status === 'draft'`), enqueue one job per `completion_actions[]` element.
2. Each job: render the template, fire the outbound channel, write a row to `outbound_dispatch_log` (already exists), backoff/retry on transient failures.
3. **Idempotency:** the dispatcher keys jobs on `(participant_id, item_id, channel, template_id)`. Re-running an enqueue is a no-op (`ON CONFLICT DO NOTHING`).
4. **Lifecycle re-check:** before sending, refetch the signals item — if it's now `live` or `paused` (someone already completed via a different channel), drop the send and log it. Avoids paging a user who already finished.

Implementation lives in `aggregator-dpg/apps/api/src/services/onboarding/dispatch_completion.ts` (new) + the existing job runner.

## 8. Dashboard tiles + participant list

### 8.1 New tiles

| Tile | Source |
|------|--------|
| **Account only** | `participants` LEFT JOIN signals' `items` where no row → "user exists, no profile yet" (computed at fetch time, not stored) |
| **Draft profiles** | signals items count where `lifecycle_status = 'draft'` for this aggregator's onboarded users |
| **Live profiles** | same, `lifecycle_status = 'live'` |
| **Paused profiles** | same, `lifecycle_status = 'paused'` |

The aggregator already has a participants-list service that hits signals' `/network/item/fetch` per network. Extend it to surface `lifecycle_status` + `completion_pct` (now in the response shape — see signals' `ItemResponseSchema` add). No new signals API needed.

### 8.2 Participant detail page

Add two badges to the existing participant card:

- Lifecycle pill: `Draft` (amber), `Live` (green), `Paused` (gray).
- Completion bar (0–100%).

Both read from `lifecycle_status` / `completion_pct` on the items array signals returns.

### 8.3 Filter / sort

Add `?lifecycle=draft|live|paused|account_only` query param on the participants list endpoint. The `account_only` value triggers the user-no-items branch; the others pass straight through to signals as a state filter (signals' fetch_local already supports `lifecycle_filter` — extend it to accept specific states beyond just `live_only`, or filter client-side at the aggregator if signals stays live-only-public).

> **Note for signals follow-up:** the current `lifecycle_filter` is binary (`'live_only' | 'all'`). For the aggregator dashboard to filter on `paused` / `draft` it needs admin-scope reads with state passed through — already available via the owner / admin all-states path. Aggregator scoped admin reads pass `lifecycle_filter: 'all'` and filter at the aggregator side.

## 9. UI changes (aggregator-dpg/apps/web)

### 9.1 Registration link form

- Pre-submit, call `GET /v1/lookup` with the entered phone/email.
- If `owned_elsewhere: true` → show "this number is already registered" + stop. **Do not** disclose the owning org.
- If `user_exists: true, owned_elsewhere: false, lifecycle_summary !== null` → show "resume profile" CTA pointing to the completion URL.
- Else → proceed with the standard registration form.

### 9.2 Partial-submit UX

Allow the registration form to submit with only the required identity fields (phone OR email + name + consent). Profile fields become "complete later". Server-side, the aggregator just forwards what it has — signals classifies as `draft` and the dispatcher (§7) takes over.

### 9.3 Pause / resume from aggregator dashboard

Aggregator's UI does **not** offer a pause button to operators — that's owner / network_service only on signals. The aggregator UI only **displays** the paused state. If an operator needs to pause an account (e.g. dispute), that's a manual signals admin action, out of scope here.

## 10. Endpoint changes summary

| Aggregator endpoint | Change |
|---|---|
| `POST /v1/registrations` (existing) | Forwards optional `item_state`. On signals' draft response, enqueue completion_actions. |
| `GET /v1/lookup` (new, §6) | Identity probe; signals' `account_only` shape underneath. |
| `GET /v1/dashboard/tiles` (existing) | Add the four lifecycle tiles (§8.1). |
| `GET /v1/participants` (existing) | Surfaces `lifecycle_status` + `completion_pct`; supports `?lifecycle=...` filter. |

## 11. Migration & rollout

- Run the SQL migration (§5.1) — additive `DEFAULT '[]'` keeps existing rows valid.
- Deploy aggregator behind the existing rollout. Signals lifecycle has to be live first; until then the aggregator gets `lifecycle_status: undefined` from signals responses — treat absent as `live` for back-compat.
- Backfill: no aggregator-side backfill needed. Signals owns the lifecycle; aggregator reads it.

## 12. Testing strategy

- **Unit:** `dispatch_completion` planner — given a signals response + a registration_link with N `completion_actions`, enqueues N jobs only when item is `draft`. Drops jobs for `live` / `paused` re-checks.
- **Integration (against signals dev):**
  - registration with full data → live, no jobs queued.
  - registration with partial data → draft, completion_actions queued.
  - registration on existing user owned-elsewhere → no item written, dispatcher does not fire.
  - `/v1/lookup` for foreign user → owned_elsewhere true, no lifecycle.
- **E2E:** existing purple_dot runbook gains a "partial registration → dispatcher fires → outbound stub records the send" path.

## 13. Open questions for product

1. Should the dispatcher's `lifecycle re-check before send` window be configurable per channel? (Default: re-check immediately before send.)
2. What's the retry policy for outbound vendor failures — per channel or unified? Existing `outbound_dispatch_log` schema supports per-row retry counters; just need a policy doc.
3. UI copy for the four lifecycle pills (Draft / Live / Paused / Account-only) — needs design sign-off.

## 14. Estimated work

- DB migration + `completion_actions` schema: 0.5d
- `/v1/lookup` endpoint: 1d
- Dispatcher + idempotency keys: 2d
- Dashboard tiles + participant list lifecycle surfacing: 2d
- UI: registration form lookup + partial submit + lifecycle badges: 2d
- Tests + E2E gap closure: 1.5d

**Total: ~9 person-days.** Sequence: DB → lookup → dispatcher → dashboard → UI → tests.

## 15. Dependencies on signals follow-ups

None of the items below block aggregator work, but track them:

- Counterparty notification when signals auto-cancels a pending action (spec §7 deferred).
- Cross-instance lifecycle re-check for `update_action_status` / `contact-details` remote source side (signals §10/§12 residual gap).
- Signals `lifecycle_filter` widening from binary to per-state for admin-scope reads (only needed if aggregator dashboard pushes the filter to signals instead of filtering client-side).
