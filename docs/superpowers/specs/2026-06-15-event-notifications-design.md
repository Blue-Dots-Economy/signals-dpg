# Standard Events & Notifications — Design

**Date:** 2026-06-15 (revised 2026-06-17)
**Status:** Draft for review
**Repos touched:** Signals-DPG (signalstack), notification-service, aggregator-dpg

---

## 1. Current implementation

### 1.1 notification-service (today)

A **contact-blind, queue-based sender.** It does not know users, has no DB lookup, and
holds no template catalog — the **caller renders the HTML and passes it in**.

- Endpoint: **`POST /notify`**
- Auth: **HMAC headers** (`X-NS-Key`, `X-NS-Timestamp`, `X-NS-Nonce`, `X-NS-Signature`);
  signature = `HMAC_SHA256(secret, "POST\n/notify\n<ts>\n<nonce>")`.
- Dedupe: `dedupe_id = ${channel}:${to}:${template_id}`.
- `GET /providers` lists channels + their variable schemas.

**Current request body (what Signals sends today):**
```jsonc
{
  "channel": "email",
  "template_id": "basic_email",
  "to": "user@example.com",
  "priority": "realtime",
  "variables": {
    "fromName": "Notification Service Demo",
    "fromEmail": "support@onest.network",
    "subject": "Welcome!",
    "html": "<h1>Hello</h1>"     // ← caller builds the full HTML
  }
}
```

### 1.2 Signals-DPG (today)

- `packages/auth/src/config.ts` already calls `nc.notify({ channel:'email', to: email, … })`
  for **OTP** and **welcome** — it has the user object, builds inline HTML, sends.
- Action lifecycle (no notifications today):
  - `routes/v1/action/perform_action.ts` — initiator creates request (**bulk**, `z.array`).
  - `routes/v1/network/action/perform_action.ts` — recipient instance receives (single);
    inserts action + `insertActionEvent` + mirrors to source.
  - `routes/v1/action/update_action_status.ts` — target owner responds (bulk); updates +
    `insertActionEvent` + `mirrorActionEventToSourceInstance`.
  - `utils/action_event_runtime.ts` — `insertActionEvent` is the **choke point** every
    instance hits when storing an event (`onConflictDoNothing`, returns `null` on duplicate).
- Interaction semantics from network config: `getActionInteraction(...)`; item display name
  via `display_name_field` / `card.title_field`.

---

## 2. Problem statement

We have defined copy for login/signup, profile/offer lifecycle, and the
connect/apply/shortlist lifecycle. Wiring it up exposes these gaps in the current setup:

1. **Copy lives in code.** Callers hand-build HTML per message (`html` in `variables`).
   No catalog, no reuse, every wording change is a code change.
2. **No templates** for the action lifecycle, the item (profile/offer) lifecycle, or
   data-export emails — only OTP/welcome exist, inline.
3. **No per-network / per-dot wording.** blue_dot, purple_dot, and region variants
   (KA/MH) need different words but there is no place to vary them.
4. **Not multi-channel ready.** Everything assumes email HTML; no path to reuse the same
   message for WhatsApp or voice.
5. **Aggregator** has only Keycloak OTP; the new data-export emails have no home.

Channel for this work: **email only.** The design is built channel-agnostic so the same
templates serve WhatsApp/voice later.

---

## 3. New design — flow

The same `POST /notify` API, but Signals sends **identifiers + live data** instead of
rendered HTML; notification-service owns templates + per-dot copy and renders.

```
[Signals-DPG]                                  [notification-service]
 action / item event
        │
        ▼
 buildNotifications(event)
   • find local owner → email (resolveOwnerEmail: created_by → better-auth user)
   • pick template_id + identifiers
     (interaction, direction, kind)
   • build dynamic vars
     (userName, serviceName, statusLabel, link)
   • network_id = ENV ?? item_network
        │
        ▼   POST /notify  { network_id, template_id, …ids…, to, variables, dedupe_key }
        └───────────────────────────────────────────►  resolve template   (shape, shared)
                                                        resolve dot config  (words, per-dot)
                                                        merge vars + words
                                                        render for channel  (email layout / WA / voice)
                                                        queue → deliver
```

- **Dispatch** is fire-and-forget after the event is stored / item saved / item failed —
  never blocks or fails the action route (`void dispatcher.dispatch(e).catch(log)`).
- **Each instance sends only for the owner it hosts** (matches the existing event-mirror
  model). Cross-instance: the other side's email is sent by the instance that hosts it.
- **Port/adapter:** Phase 1 `DirectDispatcher` (calls `nc.notify`); Phase 2
  `KafkaDispatcher` (produce to `action.events`, per-instance consumer) — `buildNotifications`
  is reused either way. Selected by `NOTIFICATION_TRANSPORT=direct|kafka`.

---

## 4. Solution — enhance the same `/notify` request body

Same endpoint, same auth, same dedupe mechanism. Two changes to the body: **stop sending
`html`**, and **add identifiers + `dedupe_key`** so notification-service can resolve the
template and per-dot copy itself.

**Before (today):** caller sends rendered `html`.
**After (new):** caller sends `template_id` + identifiers + dynamic variables.

```jsonc
{
  "network_id":  "blue_dot",          // NEW — selects per-dot config (ENV override ?? item_network)
  "template_id": "in_req",            // catalog template (shape)
  "interaction": "apply",             // NEW — picks copy in dot config
  "direction":   "sp",               // NEW — sp/ps/pp
  "kind":        "in_req",            // NEW — which of the 4 lifecycle messages
  "channel":     "email",
  "to":          "provider@example.com",
  "priority":    "realtime",
  "dedupe_key":  "aaaa-1111:0:in_req",// NEW — per-email key (action_id:update_count:kind)
  "variables": {                      // dynamic data only — NO html
    "userName":    "Ravi",
    "serviceName": "Asha",
    "link":        "https://app/requests/received/123"
  }
}
```

- **Backward compatible:** if `variables.html` is present and no catalog match, fall back
  to today's pass-through (existing OTP/welcome keep working through the transition).
- `dedupe_id = body.dedupe_key ?? ${channel}:${to}:${template_id}` — per-email key for
  action mails (unique per real email, identical per retry); coarse default for OTP/welcome.
- `NotifyRequest` (`packages/notification`) and the `/notify` Zod schema add the new
  optional fields together (shared contract).
- `link` is **instance-built** (each deployment prepends its own `FRONTEND_BASE_URL`).

---

## 5. Templates & per-dot config

Two pieces in notification-service, kept separate on purpose:

| piece | scope | who edits | when touched |
|---|---|---|---|
| **template** (shape) | **shared by ALL dots** | engineer | message-shape change (rare) |
| **layout** (HTML chrome) | shared, per channel | engineer | styling change |
| **per-dot config** (words) | **one file per dot** | content/non-tech | **every new dot** |
| template **override** | per-dot, optional | engineer | only if a dot needs a different body |

### 5.1 Template = free text with variables (channel-agnostic)

A template is **plain text + `{variables}` + a link token `{{cta}}`** — no HTML, no
dot-specific words. Because it's free text with variables, the **same template serves any
channel**: rendered to HTML for email, to text for WhatsApp, to a spoken script for voice.

```jsonc
// catalog/in_req  (shared by every dot)
{
  "template_id": "in_req",
  "subject": "{actorLabel} {actionPhrase}",
  "body":    "Hi {userName}!\n\n{actorLabel} {actionPhrase}.\n\n{{cta}}",
  "cta":     { "label": "View details", "route": "received_request" }
}
```

- `{userName}`, `{actorLabel}`, … = placeholders filled at render time.
- `{{cta}}` = the link, **abstracted** — it becomes an HTML button (email), a URL
  (WhatsApp), or "open the app" (voice). **Never** hardcode `<a href>` in the body — this
  is what lets one template serve all channels.
- The ~10 templates: `in_req`, `out_req`, `in_status`, `out_status`, `item_success`,
  `item_failed`, `otp`, `reg_confirmation`, `data_export_received`, `data_export_ready`.
- A **per-channel override** is allowed when a transform isn't enough (voice wording);
  otherwise all channels render from this one free-text body.

The **layout** wraps the rendered body once (header, styled button, footer, responsive),
so templates stay plain and styling lives in one place.

### 5.2 Per-dot config = the words + routes (one file per network)

This is the only file added for a new dot. Plain JSON; the strings are the editable
surface. It supplies the words the shared templates inject.

```jsonc
// notification-service: config/blue_dot.json
{
  "network_id": "blue_dot",
  "dotNetwork": "Blue Dot",                         // {dotNetwork} in every template

  // ---- where links point (path only; instance prepends FRONTEND_BASE_URL) ----
  "notification_routes": {
    "received_request": "/requests/received/{id}",  // in_req / out_status CTA
    "sent_request":     "/requests/sent/{id}",       // out_req / in_status CTA
    "login":            "/login",                    // otp / reg_confirmation CTA
    "profile":          "/profile",                  // seeker item_success CTA
    "offer":            "/offers/{id}"               // provider item_success CTA
  },

  // ---- per interaction × direction: words injected into the shared templates ----
  // key = "{interaction}.{direction}"  (sp=seeker→provider, ps=provider→seeker, pp=provider→provider)
  "interactions": {
    "apply.sp": {
      "actorLabel":   "A seeker",                         // in_req: who acted (told to provider)
      "actionPhrase": "has applied for your opportunity", // in_req verb
      "objectLabel":  "application"                       // out_req: "Your {objectLabel} has been sent"
    },
    "apply.ps": {
      "actorLabel":   "A service provider",
      "actionPhrase": "has shown interest in your profile",
      "objectLabel":  "request"
    },
    "connect.pp": {
      "actorLabel":   "A service provider",
      "actionPhrase": "wants to connect with you",
      "objectLabel":  "request"
    }
  },

  // ---- per domain: noun for profile/offer lifecycle templates ----
  "domains": {
    "seeker":   { "itemLabel": "profile", "itemRoute": "profile" },
    "provider": { "itemLabel": "offer",   "itemRoute": "offer" }
  }
}
```

### 5.3 Resolution & per-dot / per-region variation

- Resolution key: **`(network_id, template_id, channel, locale)`**.
- **Per-dot / per-region = composite `network_id`** (`blue_dot`, `blue_dot_ka`,
  `purple_dot_mh`) — not a separate field. The region suffix comes from the sending
  **instance's env** (`NOTIFICATION_NETWORK_ID`), since `item_network` is the same for
  KA/MH (one network, two instances).
- **`extends` inheritance** — a region/variant inherits a base and overrides only diffs:
  ```jsonc
  // config/blue_dot_ka.json
  { "extends": "blue_dot", "dotNetwork": "Blue Dot KA" }
  ```
- `statusLabel` (for `*_status`) is **derived** in Signals from `metric_categories` +
  `dashboard_buckets` and sent as a variable — not stored in the dot config.

### 5.4 How a single email is produced

```
1. Seeker applies   → Signals: { network_id:"blue_dot", interaction:"apply",
                       direction:"sp", kind:"in_req", template_id:"in_req",
                       to:"prov@x.com", variables:{ userName, serviceName, link } }
2. POST /notify     → notification-service
3. template         → catalog["in_req"]              (shape, shared)
4. config           → config["blue_dot"]["apply.sp"] (words) + dotNetwork
5. merge            → fill {userName}{actorLabel}{actionPhrase}{dotNetwork}{{cta}}
6. render           → email: body→HTML in shared layout; {{cta}}→button
7. send             → queued + delivered
```

**Signals = live data · dot config = words · template = shape · layout = styling.**

### 5.5 Adding a new dot

- **New network** (`yellow_dot`): add **one** `config/yellow_dot.json` (dotNetwork, routes,
  interaction words, domain itemLabels). Templates unchanged. Signals unchanged
  (`network_id` flows from data/env).
- **Region variant** (`blue_dot_ka`): a 2-line `extends` block + set
  `NOTIFICATION_NETWORK_ID=blue_dot_ka` on that instance.

---

## 6. Scope split

### Aggregator
| # | Template | Action |
|---|---|---|
| A1 | Registration OTP | Update wording in Keycloak `email-otp-code.ftl` + `messages_en.properties`. Stays in Keycloak. |
| A2 | Data export — received / ready | **New:** via notification-service catalog. Aggregator integrates the notification-service client. |

### Signalstack — template set
- **Action lifecycle:** `in_req`, `out_req`, `in_status`, `out_status` (connect/apply,
  sp/ps/pp folded into config words).
- **Item lifecycle:** `item_success` (profile/offer create/update), `item_failed`.
- **Auth:** `otp` (login/signup), `reg_confirmation`.

---

## 7. Recipient & direction mapping

| Path | Event kind | Recipient (inbound) | Confirmation (outbound) |
|---|---|---|---|
| `network/action/perform` (created) | `*_req` | target owner → `in_req` | source owner → `out_req` |
| `update_action_status` (response) | `*_status` | source owner (requester) → `in_status` | target owner (responder) → `out_status` |

Each instance sends only for the owner(s) it hosts locally.

### 7.1 Bulk actions — confirmation collapse

`action/perform_action.ts` is bulk; one request → N actions.
- **`in_*` alerts:** always sent per recipient (distinct people). Not collapsed.
- **`out_*` confirmations to the initiator:** when one bulk produces > 1 action, suppress
  per-action `out_req` and send one summary (`bulk_out_req`, e.g. "20 sent"). Bulk of 1
  keeps the normal single `out_req`. **Correlated at the route level** — `perform_action.ts`
  already holds the full `z.array` request in scope, so the dispatcher decides collapse from
  `array.length > 1` there. No `bulk_id` column / migration (there is none on `action_events`).

---

## 8. Triggers (where dispatch fires)

- **Action (local owner):** after `insertActionEvent` in the action paths
  (`action/perform_action.ts`, `network/action/perform_action.ts`, `update_action_status.ts`),
  gated on a non-null `created`, fire-and-forget — matching `mirrorActionEventToSourceInstance`.
- **Action (remote owner = the other side's confirmation):** **also** after `insertActionEvent`
  in `event/store_event.ts` (`store_event.ts:109`). This is the seam where a mirrored event
  lands on the **source** instance — the only place it can send `out_req` / `in_status` for
  the owner it hosts. Without this trigger, every cross-side confirmation silently never fires.
  Same non-null `created` gate + fire-and-forget. `network_id` resolves from this instance's
  own env, so the confirmation carries the source instance's base URL.
- **Item lifecycle:** after profile/offer create/update (`item_success`).
- **Item failure:** on the failure branch of the item update route (`item_failed`) — no
  event stored, so this is a separate trigger, not the `insertActionEvent` seam.
- **Auth:** OTP request path, `afterUserCreate` (replaces inline welcome).

---

## 9. Config additions (Signals-DPG)

`packages/config/src/secrets.ts` **and** `turbo.json` globalPassThroughEnv:
- `FRONTEND_BASE_URL` — base for `link`.
- `NOTIFICATION_NETWORK_ID` — optional per-instance override of the notify network id
  (e.g. `blue_dot_ka`); defaults to `item_network`.
- `NOTIFICATION_TRANSPORT` (`direct` default).

Per-dot copy/config lives in **notification-service**, not here.

---

## 10. Error handling

- Dispatch fire-and-forget; never blocks/fails the route.
- `nc.notify` failures logged; notification-service queue handles SMTP retry + dead-letter.
- **Owner→email resolution:** `resolveOwnerEmail(item.created_by)` — a new Signals helper that
  reads the better-auth user table (`email`/`phoneNumber`) by user-id. It does NOT exist today;
  `items.created_by` is only a user-id. Email is **not** carried on the wire and notification-service
  stays contact-blind (§1.1). Only the local instance resolves its own owners.
- Missing recipient email (phone-only, `user.email = NULL`) → **skip + log + counter**
  ("notification skipped: owner has no email") so the number going dark is visible.
- Missing template vars → notification-service render validation rejects; logged.
- **Two-layer dedupe:** (1) dispatch gated on non-null `created`; (2) notification-service
  `dedupe_id` from `dedupe_key`.

---

## 11. Testing

- Unit (Signals): `buildNotifications` — 4 action kinds × direction × interaction selection;
  `item_success`/`item_failed`; local-vs-remote owner skip; missing-email skip;
  `statusLabel` derivation; `network_id` env override; route-level bulk collapse
  (array.length > 1 → `bulk_out_req`; length 1 → single `out_req`); `resolveOwnerEmail`
  (created_by hit, phone-only NULL → skip+counter, unknown user-id).
- Trigger sites (Signals): `store_event.ts` dispatch fires the cross-side confirmation
  (`out_req` / `in_status`) on a non-null `created`, and is suppressed on duplicate (`null`).
- Unit (notification-service): resolution `(network_id,template_id,channel,locale)` +
  `extends` merge; free-text body → HTML render in layout; `{{cta}}` per channel;
  missing-var rejection; html pass-through fallback.
- Integration: perform → `*_req` pair; update-status → `*_status` pair; cross-instance
  (each instance sends only its local recipient with its own network_id/base URL).
- Aggregator: Keycloak OTP via MailHog; data-export via notification-service.

---

## 12. Implementation ordering (cross-repo)

1. **notification-service first** — ~10 templates (free-text body + `{{cta}}` + shared
   layout), per-dot config + `extends` resolver, renderer + missing-var validation,
   `dedupe_key` + new identifier fields in `/notify` Zod schema; deploy.
2. **Signals-DPG second** — new fields on `NotifyRequest`, dispatcher, `buildNotifications`,
   action + item/failure trigger sites, `NOTIFICATION_NETWORK_ID` env; flip basic templates
   to catalog `template_id`s.
3. **Aggregator** — integrate notification-service client for data-export; Keycloak OTP copy.

The html pass-through fallback keeps existing OTP/welcome working through the transition.

---

## 13. Out of scope / future

- Kafka event bus + per-instance consumer (`KafkaDispatcher`) — Phase 2; `action.events`
  also feeds a future metrics consumer. **Dedupe caveat:** notification-service dedupe is a
  Redis `SET NX EX 60s` window (`src/lib/dedupe.ts`), not durable idempotency. Phase 1
  fire-and-forget retries fall inside 60s, so this is safe now. Kafka reprocessing >60s later
  **will double-send** — before Phase 2, lengthen the TTL for action mails or add durable dedupe.
- WhatsApp + voice channels — model is already channel-agnostic (free-text body + `{{cta}}`
  + per-channel override + `(…,channel,…)` key); WhatsApp additionally needs a
  Meta-approved-template mapping.
- i18n of copy (`locale` key exists; only `en` authored now).
- Notification preferences / opt-out / unsubscribe — all current emails are transactional.
