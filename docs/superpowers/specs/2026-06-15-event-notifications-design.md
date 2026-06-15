# Standard Events & Notifications — Design

**Date:** 2026-06-15
**Status:** Draft for review
**Repos touched:** Signals-DPG (signalstack), notification-service, aggregator-dpg (Keycloak only)

## 1. Problem

We have a defined set of message templates for login/signup and for the
connect / apply / shortlist interaction lifecycle. They need to be wired up as
real email notifications across two products:

- **Aggregator** — only signup / OTP emails. These already live in Keycloak.
- **Signalstack** — everything else (registration/profile basics + all
  connect/apply/shortlist events), delivered through **notification-service**.

Channel for this work: **email only.** SMS/WhatsApp left as-is.

## 2. Scope split

### Aggregator — Keycloak only (no notification-service)
| # | Template | Action |
|---|---|---|
| A1 | Registration OTP | Update wording in existing `infra/keycloak/themes/otp/email/html/email-otp-code.ftl` + `text/email-otp-code.ftl` + `email/messages/messages_en.properties` (`emailOtpSubject`, `emailOtpBody`, `emailOtpBodyHtml`). |

No other aggregator change. SMTP config unchanged.

### Signalstack — notification-service catalog + Signals-DPG triggers

**Basic (3)** — fired from auth / profile flows:

| template_id | Subject | Trigger |
|---|---|---|
| `reg_otp` | Your OTP for registration | OTP request on signup |
| `reg_confirmation` | Registration successful – Complete your profile | after registration completes |
| `profile_created` | Your profile is ready – Start exploring | after profile item creation |

**Specific (16)** — connect / apply / shortlist lifecycle:

Naming: `{interaction}_{direction}_{kind}`
- interaction: `connect` | `apply` (apply covers apply/shortlist/pre-shortlist)
- direction: `sp` (seeker→provider) | `ps` (provider→seeker)
- kind: `in_req` | `out_req` | `in_status` | `out_status`

| template_id | Subject |
|---|---|
| `connect_sp_in_req` | A service provider wants to connect with you |
| `connect_sp_out_req` | Your connection request has been sent |
| `connect_sp_in_status` | <Service Name> has responded to your request |
| `connect_sp_out_status` | Your response has been sent to <Service Name> |
| `connect_ps_in_req` | A seeker wants to avail your service |
| `connect_ps_out_req` | Your request has been sent to the seeker |
| `connect_ps_in_status` | The seeker has responded to your request |
| `connect_ps_out_status` | Your response has been sent to the seeker |
| `apply_sp_in_req` | <Service Name> has shown interest in your profile |
| `apply_sp_out_req` | Your application has been sent to <Service Name> |
| `apply_sp_in_status` | <Service Name> has updated the status of your application |
| `apply_sp_out_status` | Your response has been sent to <Service Name> |
| `apply_ps_in_req` | A seeker has applied for your opportunity |
| `apply_ps_out_req` | Your shortlisting action has been sent to the seeker |
| `apply_ps_in_status` | The seeker has responded to your shortlisting action |
| `apply_ps_out_status` | Your response has been sent to the seeker |

Bodies follow the supplied copy. Common variables: `userName`, `serviceName`,
`dotNetwork`, `link`, plus `otp` for `reg_otp`.

## 3. Current state (verified)

- **notification-service is a contact-blind, queue-based sender.** `POST /notify`
  takes `{ channel, template_id, to, priority, variables }` where `to` is the
  recipient identifier supplied by the caller (`to: z.string()`). No DB, no user
  lookup. It already dedupes on `dedupe_id = ${channel}:${to}:${template_id}`.
  Today the caller passes the rendered `html` in `variables`.
- **Callers resolve the recipient.** `packages/auth/src/config.ts` already calls
  `nc.notify({ channel:'email', to: email, ... })` for OTP + welcome — it has the
  user object in hand.
- **Action lifecycle** lives in Signals-DPG:
  - `apps/api/src/routes/v1/action/perform_action.ts` — initiator creates request (bulk).
  - `apps/api/src/routes/v1/network/action/perform_action.ts` — recipient instance receives (single); inserts action + `insertActionEvent` + mirrors to source.
  - `apps/api/src/routes/v1/action/update_action_status.ts` — target owner responds (bulk); updates + `insertActionEvent` + `mirrorActionEventToSourceInstance`.
  - `apps/api/src/utils/action_event_runtime.ts` — shared runtime; `insertActionEvent` is the choke point every instance hits when storing an event. Each instance stores events for the owners it hosts.
- **Interaction semantics** come from network config: `getActionInteraction(networkConfig, {...})` (`packages/schemas/src/network_workflow.ts`) returns `requirement_schema`, `event_schema`, `reveals_pii_on_status`, consent text. Item display name is resolved via the schema's `display_name_field`.
- **Action API request/response contracts are NOT changed by this design.**

## 4. Approach

### 4.1 Transport: API now, streaming-ready (port/adapter)

Phase 1 sends via direct `nc.notify`. The code is structured so switching to a
Kafka event bus later is a config swap, not a rewrite.

```
action_event_runtime.ts  (after insertActionEvent / action create)
  └─ void dispatcher.dispatch(domainEvent).catch(log)   // fire-and-forget
                          │
              ┌───────────┴────────────┐
        Phase 1 (now)            Phase 2 (later)
     DirectDispatcher          KafkaDispatcher
        │                         │ produce → topic "action.events"
        ▼                         ▼ (separate per-instance consumer)
   buildActionNotifications(event)  ───── SAME function reused ─────┐
        │                                                           │
        ▼                                                           ▼
   nc.notify(intent) per intent                  buildActionNotifications → nc.notify
```

**Three components, transport-agnostic logic isolated:**

1. **`buildActionNotifications(event, ctx): Promise<NotifyIntent[]>`** — pure-ish.
   - Determines which owner(s) are hosted on this instance (resolves `owner_id` → user row → email against the local DB).
   - Selects `template_id` from interaction (connect vs apply), direction (sp/ps from item types), and kind (created → `*_req`; status update → `*_status`; inbound vs outbound from which owner is the recipient).
   - Builds variables: `userName`, `serviceName` (item display name), `dotNetwork` (network → display name), `link` (frontend base URL + route).
   - Returns `NotifyIntent[]` = `{ to, channel:'email', template_id, priority, variables, dedupe_key }` where `dedupe_key = ${action_id}:${update_count}:${kind}`.
   - Skips any recipient not hosted locally (returns no intent for them).

2. **`NotificationDispatcher` port** — `dispatch(event: ActionDomainEvent): Promise<void>`.
   - **Phase 1 `DirectDispatcher`:** `buildActionNotifications(event)` then `nc.notify` for each intent (`Promise.allSettled`, errors logged, never thrown).
   - **Phase 2 `KafkaDispatcher`:** `producer.send({ topic: 'action.events', messages: [domainEvent] })`. A separate per-instance consumer runs `buildActionNotifications` + `nc.notify`.
   - Selected by config (e.g. `NOTIFICATION_TRANSPORT=direct|kafka`).

3. **Call site** — one line after `insertActionEvent` in the three action paths
   (or centralized in `insertActionEvent` itself), fire-and-forget like the
   existing `void mirrorActionEventToSourceInstance(...)`. A notify hiccup must
   never block or fail the action response.

**`ActionDomainEvent` shape (defined now, serialized in Phase 2):** action_id,
action_type, action_status, update_count, source_item {network,domain,type,id,instance_url},
target_item {...}, source_item_owner, target_item_owner, source_item_name,
target_item_name (display names), network id, occurred_at. **IDs + display names
only — no email / PII** (PII stays off the future bus; email resolved locally at
dispatch/consume time).

### 4.2 Recipient & direction mapping

| Path | Event kind | Recipient (inbound) | Confirmation (outbound) |
|---|---|---|---|
| `network/action/perform` (created) | `*_req` | target owner = recipient → `*_in_req` | source owner → `*_out_req` |
| `update_action_status` (response) | `*_status` | source owner = original requester → `*_in_status` | target owner = responder → `*_out_status` |

Each instance only sends for the owner(s) it hosts locally — matching the
existing event-mirror model (events already land on both source and target
instances). `out_req`/`out_status` (confirmations) and `in_req`/`in_status`
(alerts) each go to whichever side is local; cross-instance counterparts are
sent by the instance that hosts them.

### 4.3 notification-service: named-template catalog

Add a server-side template catalog + renderer so callers stop passing `html`.

- New catalog entry shape:
  ```json
  {
    "template_id": "connect_sp_in_req",
    "channel": "email",
    "subject": "A service provider wants to connect with you",
    "body_html": "<p>Hi {userName}!</p><p>{serviceName} wants to offer the service you are looking for. <a href=\"{link}\">View details</a>.</p><p>Thanks Team {dotNetwork}</p>",
    "required_vars": ["userName", "serviceName", "dotNetwork", "link"]
  }
  ```
- Renderer: `{placeholder}` substitution + missing-required-var validation.
- **Backward compatible:** if `variables.html` is present and no catalog entry
  matches the `template_id`, fall back to the current pass-through behavior
  (existing OTP/welcome callers keep working).
- notification-service remains contact-blind — `to` still supplied by caller.

Proposed notify call (Phase 1, from `buildActionNotifications` via `nc.notify`):
```json
{
  "channel": "email",
  "template_id": "connect_sp_in_req",
  "to": "seeker@example.com",
  "priority": "realtime",
  "variables": {
    "userName": "Asha",
    "serviceName": "Mobility World India",
    "dotNetwork": "Yellow Dot",
    "link": "https://app.example.com/requests/received/aaaaaaaa-1111"
  }
}
```

### 4.4 Basic (registration/profile) triggers

- `reg_otp` — in the OTP request path (`packages/auth`); replaces/augments the
  current inline OTP email template with the catalog template `reg_otp`.
- `reg_confirmation` — after registration completes.
- `profile_created` — after profile item creation (`apps/api/src/lib/profile_item.ts`).

These call `nc.notify` directly with `to: user.email` — same pattern as today,
just catalog template_ids instead of inline html.

## 5. Config additions (Signals-DPG)

Add to `packages/config/src/secrets.ts` **and** `turbo.json` globalPassThroughEnv:

- `FRONTEND_BASE_URL` — base for `link`.
- Frontend route paths for received-request / sent-request / login (constants or config).
- Network → display-name map (`dotNetwork`); may derive from `NetworkConfig.display_name`.
- `NOTIFICATION_TRANSPORT` (`direct` default).

## 6. Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `build_action_notifications.ts` | event → NotifyIntent[]; owner resolution, template selection, var building | local user DB, network config, `getActionInteraction`, display_name resolution |
| `notification_dispatcher.ts` | port + DirectDispatcher (Phase 1) | `buildActionNotifications`, `nc.notify` |
| call site in `action_event_runtime.ts` | fire dispatch after event stored | dispatcher |
| notification-service template catalog + renderer | render subject/html from template_id + vars | — (no DB) |
| Keycloak `email-otp-code.ftl` + messages | aggregator OTP copy | — |

## 7. Error handling

- Dispatch is fire-and-forget: `void dispatcher.dispatch(e).catch((err) => log.error(...))`. Never blocks/fails the action route.
- `nc.notify` failures logged; notification-service queue handles SMTP retry + dead-letter (existing).
- Missing recipient email (owner has no email) → skip with a log line, not an error.
- Missing template vars → notification-service render validation rejects; logged.
- Dedupe via `dedupe_key` + notification-service `dedupe_id` guards against double-send.

## 8. Testing

- Unit: `buildActionNotifications` — each of the 16 specific mappings (interaction × direction × kind), local-vs-remote owner skip, missing-email skip, var building.
- Unit: notification-service renderer — placeholder substitution, missing-var rejection, html pass-through fallback.
- Integration: perform → `*_req` pair; update-status → `*_status` pair; cross-instance ownership (each instance sends only its local recipient).
- Aggregator: manual verify Keycloak OTP email copy via MailHog.

## 9. Out of scope / future

- Kafka event bus + per-instance consumer (`KafkaDispatcher`) — Phase 2; enabled by the dispatcher seam. `action.events` topic also feeds a future metrics/computation consumer (accept/reject counts), which is the strategic reason for the streaming-ready shape.
- SMS / WhatsApp variants of these templates.
- i18n of template copy (currently en only).

## 10. Open items to resolve in implementation

1. Confirm seeker-vs-provider role key on items (drives `sp`/`ps`) — derive from `item_type` + interaction `from_items`/`to_items` in network config.
2. Exact frontend route paths for received-request / sent-request / login links.
3. Whether `reg_otp` should also replace the current aggregator-shared OTP template wording or stay signalstack-only (current decision: signalstack-only; aggregator OTP stays in Keycloak).
