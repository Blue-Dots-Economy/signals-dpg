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
        └───────────────────────────────────────────►  load config[network_id]  (one self-contained file)
                                                        pick .templates[template_id] (shape + copy)
                                                        + .interactions[..] (words) + .layout (html)
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
  "network_id":  "blue_dot",          // NEW — selects the network config file (ENV override ?? item_network)
  "template_id": "in_req",            // key into network file's .templates
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

- **Backward compatible:** if `variables.html` is present and no template match in the
  network file, fall back to today's pass-through (existing OTP/welcome keep working).
- `dedupe_id = body.dedupe_key ?? ${channel}:${to}:${template_id}` — per-email key, **unique
  per real email, identical per retry**. The key's uniqueness is what makes the short 60s TTL
  safe — not retry timing. Per message family:
  - **action mails:** `action_id:update_count:kind`. A reject-then-reapply within 60s is a new
    `action_id`, so it is correctly *not* suppressed.
  - **item lifecycle:** `item_id:version:kind` (no `action_id` exists for `item_success`/`item_failed`).
  - **OTP:** must **opt out** of fine dedupe — use a per-send unique key (include the OTP nonce)
    or disable dedupe. The coarse `channel:to:template_id` default would drop a legitimate
    second OTP to the same address inside 60s. Welcome can keep the coarse default (one-shot).
- `NotifyRequest` (`packages/notification`) and the `/notify` Zod schema add the new
  optional fields together (shared contract).
- `link` is **instance-built** (each deployment prepends its own `FRONTEND_BASE_URL`).

---

## 5. Per-network config (self-contained, one file per network)

**One JSON file per network**, fully self-contained: it holds that network's templates,
its HTML layout, its words, and its routes. Nothing is shared across networks. A change to
one network's template or HTML **cannot affect any other network** — that isolation is the
whole point. The notification-service code stays generic: it loads `config[network_id]` and
renders entirely from that one file.

```
config/
├── blue_dot.json      ← templates + layout(html) + words + routes  (complete)
├── purple_dot.json    ← its own full copy of all of the above
├── yellow_dot.json    ← its own full copy
└── blue_dot_ka.json   ← its own full copy (region variant; see 5.5)
```

| piece (all inside the network file) | who edits | when touched |
|---|---|---|
| **templates** (subject + body + cta, all ~10) | engineer / content | message-shape or copy change |
| **layout** (HTML chrome, per channel) | engineer | styling change for that network |
| **words** (interaction × direction phrasing) | content/non-tech | wording change |
| **routes** (where CTAs point) | engineer | route change |

**Tradeoff (accepted):** templates and HTML are **duplicated** across network files. The
same `in_req` body lives in blue_dot.json and purple_dot.json. Editing shared copy means
editing every file. We take that cost in exchange for **blast-radius isolation** — a network
can diverge its templates/HTML freely with zero risk to the others, and notification-service
needs no cross-file resolver / inheritance.

### 5.1 What one network file looks like

```jsonc
// notification-service: config/blue_dot.json   (complete, self-contained)
{
  "network_id": "blue_dot",
  "dotNetwork": "Blue Dot",                         // {dotNetwork} usable in any template/layout

  // ---- HTML layout (per network — each dot styles its own email chrome) ----
  // {{body}} = rendered template body injected here; {{ctaUrl}}/{{ctaLabel}} = the CTA button.
  "layout": {
    "email": {
      "html": "<html><body><header>{dotNetwork}</header><main>{{body}}</main><footer>© {dotNetwork}</footer></body></html>",
      "button": "<a href=\"{{ctaUrl}}\" class=\"btn\">{{ctaLabel}}</a>"
    }
    // future: "whatsapp": {...}, "voice": {...}  (same network file)
  },

  // ---- where CTA links point (path only; instance prepends FRONTEND_BASE_URL) ----
  "notification_routes": {
    "received_request": "/requests/received/{id}",  // in_req / out_status CTA
    "sent_request":     "/requests/sent/{id}",       // out_req / in_status CTA
    "login":            "/login",                    // otp / reg_confirmation CTA
    "profile":          "/profile",                  // seeker item_success CTA
    "offer":            "/offers/{id}"               // provider item_success CTA
  },

  // ---- templates (full copy, lives in THIS network file) ----
  // body = plain text + {variables} + {{cta}} token; rendered into layout.email at send time.
  "templates": {
    "in_req": {
      "subject": "{actorLabel} {actionPhrase}",
      "body":    "Hi {userName}!\n\n{actorLabel} {actionPhrase}.\n\n{{cta}}",
      "cta":     { "label": "View details", "route": "received_request" }
    },
    "out_req":   { "subject": "…", "body": "Your {objectLabel} has been sent.\n\n{{cta}}", "cta": { "label": "View", "route": "sent_request" } },
    "in_status": { "subject": "…", "body": "…", "cta": { "label": "View", "route": "sent_request" } },
    "out_status":{ "subject": "…", "body": "…", "cta": { "label": "View", "route": "received_request" } },
    "item_success": { "subject": "…", "body": "…", "cta": { "label": "View", "route": "profile" } },
    "item_failed":  { "subject": "…", "body": "…", "cta": { "label": "Retry", "route": "profile" } },
    "otp":          { "subject": "…", "body": "…", "cta": { "label": "Login", "route": "login" } },
    "reg_confirmation": { "subject": "…", "body": "…", "cta": { "label": "Login", "route": "login" } },
    "data_export_received": { "subject": "…", "body": "…", "cta": null },
    "data_export_ready":    { "subject": "…", "body": "…", "cta": { "label": "Download", "route": "profile" } }
  },

  // ---- words injected into templates, per interaction × direction ----
  // key = "{interaction}.{direction}"  (sp=seeker→provider, ps=provider→seeker, pp=provider→provider)
  "interactions": {
    "apply.sp":   { "actorLabel": "A seeker",           "actionPhrase": "has applied for your opportunity", "objectLabel": "application" },
    "apply.ps":   { "actorLabel": "A service provider", "actionPhrase": "has shown interest in your profile", "objectLabel": "request" },
    "connect.pp": { "actorLabel": "A service provider", "actionPhrase": "wants to connect with you",          "objectLabel": "request" }
  },

  // ---- per domain: noun for profile/offer lifecycle templates ----
  "domains": {
    "seeker":   { "itemLabel": "profile", "itemRoute": "profile" },
    "provider": { "itemLabel": "offer",   "itemRoute": "offer" }
  }
}
```

- `{userName}`, `{actorLabel}`, … = placeholders filled at render time.
- `{{cta}}` = the link token, **abstracted** — at render it becomes the `layout.email.button`
  (email), a raw URL (WhatsApp), or "open the app" (voice). Keep `{{cta}}` in the `body`
  (don't hardcode `<a href>` there) so the same body can serve other channels later; the
  channel-specific HTML lives in `layout`, which is also per-network.
- The ~10 templates: `in_req`, `out_req`, `in_status`, `out_status`, `item_success`,
  `item_failed`, `otp`, `reg_confirmation`, `data_export_received`, `data_export_ready`.

### 5.4 How a single email is produced

```
1. Seeker applies   → Signals: { network_id:"blue_dot", interaction:"apply",
                       direction:"sp", kind:"in_req", template_id:"in_req",
                       to:"prov@x.com", variables:{ userName, serviceName, link } }
2. POST /notify     → notification-service
3. load file        → config["blue_dot"]                       (the one self-contained file)
4. template         → config["blue_dot"].templates["in_req"]   (shape + copy)
5. words            → config["blue_dot"].interactions["apply.sp"] + dotNetwork
6. merge            → fill {userName}{actorLabel}{actionPhrase}{dotNetwork} into subject+body
7. render           → body→HTML, {{cta}}→layout.email.button, wrap in layout.email.html
8. send             → queued + delivered
```

**Signals = live data · network file = everything else (templates · html · words · routes).**

### 5.5 Adding a new network

- **New network** (`yellow_dot`): add **one** `config/yellow_dot.json` — copy an existing
  network file and edit templates/layout/words/routes. notification-service unchanged,
  Signals unchanged (`network_id` flows from data/env). Other networks untouched.
- **Region variant** (`blue_dot_ka`): also its **own full file** (no inheritance — isolation
  by design), plus set `NOTIFICATION_NETWORK_ID=blue_dot_ka` on that instance. It duplicates
  blue_dot's content; that's the accepted cost for letting KA diverge safely.

---

## 6. Scope split

### Aggregator
| # | Template | Action |
|---|---|---|
| A1 | Registration OTP | Update wording in Keycloak `email-otp-code.ftl` + `messages_en.properties`. Stays in Keycloak. |
| A2 | Data export — received / ready | **New:** via the aggregator's network config file in notification-service. Aggregator integrates the notification-service client. |

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

**Both** `action/perform_action.ts:29` and `update_action_status.ts:28` are bulk
(`z.array(z.unknown())`); one request → N actions/responses.
- **`in_*` alerts:** always sent per recipient (distinct people). Not collapsed.
- **`out_*` confirmations to the actor:** when one bulk produces > 1 action, suppress the
  per-action confirmation and send one summary. Applies to **both** paths:
  - perform → `bulk_out_req` (e.g. "20 sent") instead of N × `out_req`.
  - update-status → `bulk_out_status` (e.g. "20 responses recorded") instead of N × `out_status`.
  Bulk of 1 keeps the normal single confirmation. **Correlated at the route level** — each
  route already holds the full `z.array` in scope, so the dispatcher decides collapse from
  `array.length > 1` there. No `bulk_id` column / migration (there is none on `action_events`).

---

## 8. Triggers (where dispatch fires)

**The rule:** at each seam, after `insertActionEvent` returns a non-null `created`, dispatch
for **every side of the event whose `item_instance_url == self`** — the `in_*` alert for a
locally-hosted target owner, the `out_*` confirmation for a locally-hosted source owner, or
**both** when both are local. Locality is computed exactly as the mirror computes it
(`normalizeInstanceUrl(side.item_instance_url) === normalizeInstanceUrl(getCurrentApiBaseUrl())`).

This must hold at **two seams**, because the mirror has a self-skip:

```
                         single-instance (source & target both local)
                         ─────────────────────────────────────────────
 action route ──insertActionEvent→ created ──► dispatch BOTH (in_req + out_req)
                         │
                         └─ mirror? source_item.item_instance_url == self ⇒ SKIP
                                    (action_event_runtime.ts:287-292)
                            store_event.ts NEVER runs — but that's fine, both already sent

                         multi-instance (KA seeker → MH provider)
                         ─────────────────────────────────────────────
 [MH] action route ─insertActionEvent→ created ─► dispatch target-local only (in_req)
                         │ source is remote ⇒ mirror fires
                         ▼  POST /event/store
 [KA] store_event.ts ─insertActionEvent→ created ─► dispatch source-local only (out_req)
```

- **🔴 Single-instance is the common case for this branch family** (host-routed,
  single-instance, multi-domain). If dispatch only fired in `store_event.ts`, every
  `out_req` / `in_status` confirmation would be silently dropped — the mirror self-skip
  (`action_event_runtime.ts:287-292`) means `store_event.ts` is never reached when source
  is local. The fix is the per-side locality check **in the action route**, not a second
  trigger only on the mirror path.
- **Dedupe interaction (do NOT re-insert):** in single-instance you send both emails off the
  **one** `created` event. Do not call `insertActionEvent` again to "trigger" the source side —
  the second call hits `onConflictDoNothing`, returns `null`, and the gate would suppress it.
  One insert → fan out to all local owners.
- **Action seams:** `action/perform_action.ts`, `network/action/perform_action.ts`,
  `update_action_status.ts` (action route) **and** `event/store_event.ts:109` (mirror receiver).
  `network_id` always resolves from the **hosting** instance's env, so each email carries its
  own base URL.
- **Item lifecycle:** after profile/offer create/update (`item_success`).
- **Item failure:** on the failure branch of the item update route (`item_failed`) — no
  event stored, so this is a separate trigger, not the `insertActionEvent` seam.
- **Auth:** OTP request path, `afterUserCreate` (replaces inline welcome). Scope: only the
  **email** OTP + welcome flip to the network-file template; SMS already uses
  `template_id:'login_otp'` + `variables.message` (no html) — leave that path untouched.

---

## 9. Config additions (Signals-DPG)

`packages/config/src/secrets.ts` **and** `turbo.json` globalPassThroughEnv:
- `FRONTEND_BASE_URL` — base for `link`.
- `NOTIFICATION_NETWORK_ID` — the notify network id. **Single resolution rule (canonical):**
  `network_id = NOTIFICATION_NETWORK_ID ?? item_network`. (§3's `ENV ?? item_network` shorthand
  means the same thing.) If the resolved id has **no config file** in notification-service, the
  render fails → **log + skip + counter** (same fire-and-forget posture as a missing email);
  it never crashes the route. Deploy-time check: every `SERVED_DOMAINS` network must have a
  matching notification-service config file.
- `NOTIFICATION_TRANSPORT` (`direct` default).

Per-dot copy/config lives in **notification-service**, not here.

---

## 10. Error handling

- Dispatch fire-and-forget; never blocks/fails the route.
- `nc.notify` failures logged; notification-service queue handles SMTP retry + dead-letter.
- **Owner→email resolution:** `resolveOwnerEmail(item.created_by)` — a new Signals helper that
  reads the better-auth user table (`email`/`phoneNumber`) by user-id. It does NOT exist today;
  `items.created_by` is only a user-id. Email is **not** carried on the wire and notification-service
  stays contact-blind (§1.1). Only the local instance resolves its own owners. This holds on
  the `store_event` (mirror) path too: that seam runs on the **source** instance, where the
  source item was created — so `source_item.created_by`'s better-auth user row is local there.
  Integration coverage must assert resolution on the mirrored path, not just the local one.
- Missing recipient email (phone-only, `user.email = NULL`) → **skip + log + counter**
  ("notification skipped: owner has no email") so the number going dark is visible.
- Missing template vars → notification-service render validation rejects; logged.
- **Two-layer dedupe:** (1) dispatch gated on non-null `created`; (2) notification-service
  `dedupe_id` from `dedupe_key`.

---

## 12. Implementation ordering (cross-repo)

1. **notification-service first** — per-network config files (each self-contained: ~10
   templates with body + `{{cta}}`, `layout.email.html`, words, routes), loader that reads
   `config[network_id]`, renderer + missing-var validation, `dedupe_key` + new identifier
   fields in `/notify` Zod schema; deploy.
2. **Signals-DPG second** — new fields on `NotifyRequest`, dispatcher, `buildNotifications`,
   action + item/failure trigger sites, `NOTIFICATION_NETWORK_ID` env; flip basic templates
   to network-file `template_id`s.
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
