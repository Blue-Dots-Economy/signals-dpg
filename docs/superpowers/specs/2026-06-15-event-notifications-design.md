# Event Notifications — Phase 1 Design (Signals interaction emails)

**Date:** 2026-06-15 (revised 2026-06-18 — re-scoped into phases)
**Status:** Draft for review
**Repos touched:** Signals-DPG only (notification-service unchanged in Phase 1)
**History:** This file previously held the full-vision design; that draft is preserved in git history. Phase 2 of that vision is tracked in #188.

---

## 0. What changed in the 2026-06-18 revision, and why

The prior version of this file designed the **full long-term vision**: notification-service owning
per-network template/config files, a render engine, a new `/notify` contract, multi-channel
layouts, cross-instance + Kafka transport, and the item-lifecycle / OTP / data-export /
aggregator flows. That is a good Phase-2 target, but it is a cross-repo build (NS changes +
deploy, weeks of work) and is **not** what we need now.

This revision re-scopes to the **near-term shippable fix**. The locked decisions:

| # | Decision | Consequence |
|---|---|---|
| 1 | **Near-term = action emails only** | Item lifecycle, OTP/welcome migration, reg-confirmation, data export, aggregator integration → Phase 2 (#188) |
| 2 | **Signals builds the HTML; NS delivers via existing `basic_email`** | **notification-service is NOT modified.** No new `/notify` fields, no NS config files, no render engine |
| 3 | **Action copy = in-code config map in Signals**; brand/URLs from network config | No external JSON/registry; type-checked, unit-testable |
| 4 | **CTA = generic login/home link** | `FRONTEND_BASE_URL` + `/login`; no per-resource deep links yet |
| 5 | **Single-instance (blue_dot) topology** | Recipient email always resolved locally; cross-instance → Phase 2 |

**The seam is preserved.** Phase 1 isolates all notification logic behind a single
`buildNotifications(event)` + `DirectDispatcher` boundary. When the Phase-2 NS-owned registry
lands (#188), that boundary is the swap point — Phase-1 work is not throwaway.

---

## 1. Current implementation (relevant facts)

### notification-service (unchanged in Phase 1)
- `POST /notify`, HMAC auth (`X-NS-Key/-Timestamp/-Nonce/-Signature`).
- **Contact-blind**: no user DB, no template catalog. Caller passes `variables.html`.
- `basic_email` template accepts `{ fromName, fromEmail, subject, html, replyTo? }`.
- Dedupe: Redis `SET NX EX 60s`, key = `dedupe_id` (defaults to `${channel}:${to}:${template_id}`).
- Channels live: email (SES/Gmail SMTP), SMS (MSG91), WhatsApp (Twilio). Phase 1 uses **email only**.

### Signals-DPG (today)
- `packages/auth/src/config.ts` already calls `nc.notify({ channel:'email', template_id:'basic_email', … })`
  for OTP and welcome — **Signals builds inline HTML and sends it.** Phase 1 follows this exact pattern.
- Action lifecycle (no notifications today):
  - `routes/v1/action/perform_action.ts` — initiator creates request (**bulk**, `z.array`).
  - `routes/v1/network/action/perform_action.ts` — recipient instance persists; inserts action +
    `insertActionEvent` (~:238) + mirrors to source.
  - `routes/v1/action/update_action_status.ts` — target owner responds (**bulk**, `z.array`);
    updates + `insertActionEvent` (~:295) + `mirrorActionEventToSourceInstance`.
  - `utils/action_event_runtime.ts` — `insertActionEvent` is the **choke point** (`onConflictDoNothing`,
    returns `null` on duplicate). Mirror **self-skips** when source is local (~:287-292).
- Action record carries `source_item_owner`, `target_item_owner`, `source_item_domain`,
  `target_item_domain`, `*_item_network`, `action_type`, `action_status`, `update_count`.

> Line numbers are indicative (from exploration on 2026-06-18); confirm against the branch at implementation time.

---

## 2. Scope

**In:** Email notifications for the action interaction matrix — `connect`, `apply`,
`shortlist`, `pre_shortlist` — both inbound (to the recipient) and outbound (confirmation to
the actor), on action creation and on status response. Single-instance. Channel = email.

**Out (→ §11 Phase 2, #188):** notification-service template ownership / config files / renderer;
new `/notify` contract; item lifecycle (profile/offer success/failed); OTP & welcome migration;
registration confirmation; data export; aggregator integration; WhatsApp/SMS for interactions;
cross-instance & Kafka transport; deep-link CTAs; i18n; opt-out/unsubscribe.

---

## 3. Architecture

Reuse the OTP path exactly: **Signals builds branded HTML and POSTs it to NS `basic_email`**
via the existing `notificationClient`. New code is confined to Signals and sits behind one seam.

```
[Signals action route]
   action created / status changed
        │  (after insertActionEvent → non-null `created`)
        ▼
   void dispatcher.dispatch(event).catch(log)        ← fire-and-forget, never blocks the route
        │
        ▼
   buildNotifications(event)                          ← pure-ish: derive recipients + shapes
        │  for each LOCAL owner side:
        │    • shape = INBOUND_REQUEST | OUTBOUND_REQUEST | INBOUND_STATUS | OUTBOUND_STATUS
        │    • resolveOwnerEmail(owner_user_id) → email   (skip+log+counter if none)
        │    • renderActionEmail(actionType, shape, status, roles, brand, ctaUrl) → {subject, html}
        │    • dedupe_id = action_id:update_count:shape
        ▼
   nc.notify({ channel:'email', template_id:'basic_email', to, priority:'other',
               dedupe_id, variables:{ fromName, fromEmail, replyTo, subject, html } })
        ▼
   [notification-service]  queue → worker → SES/SMTP → retry/DLQ      (unchanged)
```

---

## 4. The 4 generic shapes (full matrix, any action type)

Derived from **lifecycle event × direction**. One create → 2 emails; one status change → 2 emails.

| Shape | Fires when | Recipient | Gist |
|---|---|---|---|
| `INBOUND_REQUEST`  | action created | target owner | "{actorLabel} {inboundPhrase} → view & respond" |
| `OUTBOUND_REQUEST` | action created | source owner | "Your {objectNoun} has been sent to {counterpartyLabel}" |
| `INBOUND_STATUS`   | status changed | source owner (requester) | "{actorLabel} has responded to your {objectNoun}" |
| `OUTBOUND_STATUS`  | status changed | target owner (responder) | "Your response to {counterpartyLabel} has been sent" |

## 5. The action-copy config map (the only per-action-type knowledge)

A static, typed `const` in Signals — pure data, no I/O, the seam for the Phase-2 registry.

```ts
// apps/api/src/notifications/action_copy.ts
interface ActionCopy {
  objectNoun: string;     // "connection request", "application", "shortlisting action"
  inboundPhrase: string;  // "wants to connect with you", "applied for your opportunity", …
}

const ACTION_COPY: Record<string, ActionCopy> = {
  connect:       { objectNoun: 'connection request', inboundPhrase: 'wants to connect with you' },
  apply:         { objectNoun: 'application',         inboundPhrase: 'applied for your opportunity' },
  shortlist:     { objectNoun: 'shortlisting action', inboundPhrase: 'shown interest in your profile' },
  pre_shortlist: { objectNoun: 'shortlisting action', inboundPhrase: 'shown interest in your profile' },
};
const FALLBACK: ActionCopy = { objectNoun: 'interaction', inboundPhrase: 'taken an action on your profile' };
// resolve = ACTION_COPY[action_type] ?? FALLBACK   (unknown types degrade gracefully)
```

**Role labels** (`actorLabel` / `counterpartyLabel`, e.g. "A seeker" / "A service provider")
derive from the counterparty's **domain** on the action record (`source_item_domain` /
`target_item_domain`), via a small `DOMAIN_LABEL: Record<domain,string>` map. Phase 1 default:
**role-generic labels only** — counterparty *name* is included only where the existing
PII-reveal rules (`getInteractionPiiRevealStatuses`) already permit; otherwise generic.

**Brand / URLs are NOT in this map** — `dotNetwork` display name, `from`/`replyTo`, and the
`ctaUrl` (`FRONTEND_BASE_URL + /login`) resolve from network config + env, same source OTP reads.

## 6. Components (all new, all in Signals `apps/api/src/notifications/`)

1. **`action_copy.ts`** — the `ACTION_COPY` map + `DOMAIN_LABEL` (above). Pure data.
2. **`render_action_email.ts`** — *pure function*
   `(actionType, shape, status, recipientRole, counterpartyRole, counterpartyName?, brand, ctaUrl) → { subject, html }`.
   No I/O. Builds the 4 shapes, wraps in the existing branded shell (reuse `otp_email.ts` chrome).
   Fully unit-testable (snapshot subject+body per `action_type × shape`).
3. **`build_notifications.ts`** — `buildNotifications(event)` derives, for each **local** owner
   side, the `{ recipientUserId, shape, actionType, status, roles }` tuples. Pure given the event.
4. **`dispatcher.ts`** — `DirectDispatcher.dispatch(event)`: resolve emails, render, call
   `nc.notify`. Wrapped fire-and-forget. (Interface kept so Phase-2 transport can swap in.)
5. **`resolve_owner_email.ts`** — `resolveOwnerEmail(userId)` reads the better-auth `user` table
   (`email`) by id. New helper; `*_item_owner` is only a user-id today. Email is **not** put on
   the wire — NS stays contact-blind.
6. **Brand/URL resolver** — `dotNetwork`, `from`/`replyTo`, `ctaUrl` from network config + env.
7. **Trigger calls** — `void dispatcher.dispatch(...)` at the seams in §7.

## 7. Trigger seams & the single-instance dispatch rule

> **The most important correctness point in this design — and it bites *because* we chose single-instance.**

Dispatch fires **in the action route**, after `insertActionEvent` returns a **non-null**
`created`, for **every owner side hosted locally** — both `in_*` (local target) and `out_*`
(local source) off the **one** `created` event.

Do **NOT** rely on the mirror / `event/store_event.ts` path to send the source-side email:
the mirror **self-skips when source is local** (`action_event_runtime.ts:~287-292`), so
`store_event.ts` never runs single-instance and every `out_req` / `in_status` confirmation
would be silently dropped. Conversely, do **NOT** call `insertActionEvent` a second time to
"trigger" the other side — the duplicate hits `onConflictDoNothing`, returns `null`, and is
suppressed. **One insert → fan out to all local owners.**

| Seam | Event | `in_*` (recipient) | `out_*` (actor confirmation) |
|---|---|---|---|
| `network/action/perform_action.ts` (created) | request | target owner → `INBOUND_REQUEST` | source owner → `OUTBOUND_REQUEST` |
| `update_action_status.ts` (response) | status | source owner → `INBOUND_STATUS` | target owner → `OUTBOUND_STATUS` |

In single-instance both owners are local, so both seams dispatch both sides. (The multi-instance
`store_event.ts` path is Phase 2 — but writing the dispatch as a **per-side locality check**
now means Phase 2 adds the second trigger site without reworking Phase 1.)

## 8. Bulk handling (kept from the prior draft — real and necessary)

Both `action/perform_action.ts` and `update_action_status.ts` are **bulk** (`z.array`); one
request → N actions/responses. Correlate at the **route level** (the route holds the full array):

- **`in_*` alerts** → always per-recipient (distinct people). Never collapsed.
- **`out_*` confirmations to the actor** → when the bulk produced **> 1** action, send **one
  summary** ("20 requests sent" / "20 responses recorded") instead of N emails. Bulk of 1 →
  normal single confirmation. No schema/migration needed (decided from `array.length`).

## 9. Recipient resolution, dedupe, reliability

- **Recipient email:** `resolveOwnerEmail(owner_user_id)` → local `user.email`.
  Missing email (phone-only / `NULL`) → **skip + log + increment a counter**
  ("notification skipped: owner has no email") so dark recipients are visible.
- **Dedupe:** pass `dedupe_id = ${action_id}:${update_count}:${shape}` — unique per real email,
  identical across action retries. (NS's 60s TTL is safe because the *key* is unique, not because
  of timing.) **Do not touch the OTP path's dedupe** — it stays as-is.
- **Priority:** `other` (interactions aren't time-critical like OTP). Configurable constant.
- **Fire-and-forget:** all dispatch is `void … .catch(log)`; a notification failure can never
  fail or slow connect/accept/reject. NS queue owns SMTP retry + DLQ.

## 10. Config additions (Signals-DPG)

`packages/config/src/secrets.ts` (and `turbo.json` `globalPassThroughEnv` — both must change together):
- `FRONTEND_BASE_URL` — base for the generic `/login` CTA.
- `NOTIFICATION_NETWORK_ID` *(optional)* — for the `dotNetwork` brand label; falls back to
  `item_network` from the action record.
- Notification client env already exists: `NOTIFICATION_SERVICE_ENDPOINT`,
  `NOTIFICATION_SERVICE_KEY_ID`, `NOTIFICATION_SERVICE_SECRET`.

No NS env / config changes (NS is untouched).

## 11. Testing

- **Unit (pure):** `render_action_email` — assert subject + body per `(action_type × 4 shapes)`
  incl. the FALLBACK type and the `status` variants. Role-label derivation from domain.
- **Unit:** `buildNotifications` — single-instance create yields exactly `INBOUND_REQUEST`(target)
  + `OUTBOUND_REQUEST`(source); status change yields `INBOUND_STATUS`(source) + `OUTBOUND_STATUS`(target).
- **Unit:** bulk collapse — `N>1` → one `out_*` summary; `N==1` → single; `in_*` always per-recipient.
- **Unit:** `resolveOwnerEmail` missing email → skip path (counter incremented, no throw).
- **Integration:** seams invoke `dispatch` with a mocked `nc`; **the action still succeeds when
  `nc.notify` throws.** Assert no second `insertActionEvent`. Dedupe_id format asserted.

## 12. Implementation ordering

All in Signals-DPG (NS untouched):
1. `action_copy.ts` + `render_action_email.ts` (pure, TDD first).
2. `resolve_owner_email.ts` + brand/URL resolver + config env.
3. `build_notifications.ts` + `dispatcher.ts` (seam).
4. Wire trigger calls at the two seams; bulk collapse at route level.
5. Tests per §11.

## 13. Phase 2 / future → tracked in #188

The prior full-vision draft (in git history) is retained as the Phase-2 target, in order:
1. **Migrate aggregator-dpg off its own `MailerAdapter`** onto notification-service.
2. **NS-owned templates** — per-network self-contained config files (templates + layout +
   words + routes), a renderer, and the enhanced `/notify` contract (`network_id`,
   `template_id`, `interaction`, `direction`, `kind`, `dedupe_key`; drop `html`). Backward-compat
   `html` pass-through during transition. This is where the Phase-1 `render_action_email` seam
   is replaced by an NS fetch — same call sites.
3. **Item lifecycle** (`item_success`/`item_failed`), **reg-confirmation**, **data export**,
   **OTP/welcome** flip to the registry.
4. **Cross-instance & Kafka transport** (`store_event.ts` source-side dispatch, `KafkaDispatcher`;
   note the NS 60s-TTL dedupe caveat for >60s reprocessing).
5. **WhatsApp / SMS** for interactions (channel-agnostic body + per-channel layout; WhatsApp needs
   Meta-approved template mapping).
6. **Intelligence-layer triggers** — profile-completion nudges, inactivity re-engagement, etc.,
   driven by aggregator or an automated service calling the same notification path.
7. **Deep-link CTAs**, **i18n**, **opt-out/unsubscribe**, **U18 minor-consent** (parent OTP, #143).
