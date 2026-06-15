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

**Basic (4)** — fired from auth / profile flows:

| template_id | Subject | Trigger |
|---|---|---|
| `reg_otp` | Your OTP for registration | OTP request on **signup** |
| `login_otp` | Your OTP for login | OTP request on **login** |
| `reg_confirmation` | Registration successful – Complete your profile | after registration completes |
| `profile_created` | Your profile is ready – Start exploring | after profile item creation |

`reg_otp` and `login_otp` share the OTP body but differ in subject/copy. The
better-auth `sendEmailOtp` callback (`packages/auth/src/config.ts`) currently does
**not** receive a login-vs-signup discriminator — see §10.5; the path must distinguish
the two before the correct template can be chosen, else default to `login_otp` copy
(safe for returning users).

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
`dotNetwork`, `link`, plus `otp` for `reg_otp`/`login_otp` and **`statusLabel` for all
`*_status` templates**.

**`statusLabel` (required for `*_status`).** `apply` collapses apply / shortlist /
pre-shortlist / reject into the four `*_status` templates, so the body must name the
actual outcome. `statusLabel` is the human-readable status (e.g. "Shortlisted",
"Pre-shortlisted", "Rejected", "Accepted") derived from `action_status`. Without it
"has updated the status of your application" can't tell the user what changed.

**Variable → source map.** `userName` = recipient owner's `user.name`. `serviceName` =
the *other* party's item display name (resolved via `display_name_field`). `link` =
received-request route for `in_*`, sent-request route for `out_*`.

| template_id | userName (recipient) | serviceName (other item) | extra |
|---|---|---|---|
| `connect_sp_in_req` | seeker (target owner) | provider service | — |
| `connect_sp_out_req` | provider (source owner) | seeker profile | — |
| `connect_sp_in_status` | provider (source owner) | seeker profile | — |
| `connect_sp_out_status` | seeker (target owner) | provider service | — |
| `connect_ps_in_req` | provider (target owner) | seeker profile | — |
| `connect_ps_out_req` | seeker (source owner) | provider service | — |
| `connect_ps_in_status` | seeker (source owner) | provider service | — |
| `connect_ps_out_status` | provider (target owner) | seeker profile | — |
| `apply_sp_in_req` | provider (target owner) | seeker/applicant | — |
| `apply_sp_out_req` | seeker (source owner) | provider opportunity | — |
| `apply_sp_in_status` | seeker (source owner) | provider opportunity | `statusLabel` |
| `apply_sp_out_status` | provider (target owner) | seeker/applicant | `statusLabel` |
| `apply_ps_in_req` | provider (target owner) | seeker/applicant | — |
| `apply_ps_out_req` | seeker (source owner) | provider opportunity | — |
| `apply_ps_in_status` | seeker (source owner) | provider opportunity | `statusLabel` |
| `apply_ps_out_status` | provider (target owner) | seeker/applicant | `statusLabel` |

Recipient owner = whichever side is hosted locally (§4.2); `serviceName` is always the
counterparty item. The exact sp/ps role-key derivation is §10.1.

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
  - `apps/api/src/utils/action_event_runtime.ts` — shared runtime; `insertActionEvent` is the choke point every instance hits when storing an event. Each instance stores events for the owners it hosts. **Called from 4 sites:** `network/action/perform_action.ts`, `update_action_status.ts`, and `event/store_event.ts` (the mirror receiver, which already captures `created`). Uses `onConflictDoNothing` and returns `null` on duplicate — dispatch must gate on a non-null return.
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
   - Returns `NotifyIntent[]` = `{ to, channel, template_id, priority, variables, dedupe_key }` where `dedupe_key = ${action_id}:${update_count}:${kind}`. `channel` is not hardcoded in the selection logic — it defaults to `email` for this work but is carried as a field so the same intent shape and dispatch path serve other channels later (channel-agnostic by construction).
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
target_item_name (display names), network id, occurred_at, **bulk_id** (batch
correlation id for bulk `perform_action` requests; null for single/status events — see
§4.2a). **IDs + display names only — no email / PII** (PII stays off the future bus;
email resolved locally at dispatch/consume time).

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

### 4.2a Bulk actions — confirmation collapse (avoid storms)

`apps/api/src/routes/v1/action/perform_action.ts` is **bulk** (`z.array` body, one
network call per target). A single initiator request can create N actions → N events.
Naively that is N `in_req` alerts (one per distinct recipient — fine) **plus N
`out_req` confirmations to the same initiator** (e.g. a provider bulk-applying to 500
seekers gets 500 "your request has been sent" emails — spam).

Rule:
- **`in_*` alerts:** always sent per recipient (each goes to a different person). Not
  collapsed.
- **`out_*` confirmations to the initiator:** when a single bulk request produces more
  than one action, **suppress the per-action `out_req` and send one summary** instead
  (`bulk_out_req`, subject e.g. "473 requests sent") rather than N identical emails.
  A bulk of size 1 keeps the normal single `out_req`.

Mechanism: the dispatcher needs a `bulk_id` / batch correlation on the
`ActionDomainEvent` so the initiator's instance can recognize events belonging to one
bulk request and emit a single confirmation. `in_*` dispatch is unaffected. Threshold
is "> 1 action in the batch"; the summary email links to the sent-requests list.
`bulk_id` is IDs-only, safe for the future bus.

**Worked example — seeker applies to 20 providers** (one bulk request → 20 actions):

```
                       ┌─────────────────────────────────────────┐
1 bulk perform_action  │  OUT side → seeker (initiator)           │
  → 20 actions ────────┤    20 out_req in one batch → COLLAPSE    │
                       │    → 1 email: bulk_out_req "20 sent"     │  ✅ 1, not 20
                       └─────────────────────────────────────────┘
                       ┌─────────────────────────────────────────┐
                       │  IN side → each of 20 providers (targets)│
                       │    20 distinct recipients, 1 in_req each │
                       │    → 20 emails, one per provider         │  ✅ never collapsed
                       └─────────────────────────────────────────┘
TOTAL: 1 (seeker) + 20 (providers) = 21 emails.   Without collapse: 40.
```

The seeker never receives `in_req` for their own outgoing applications — `in_req` is
the inbound alert to the receiving side only. Distinct-recipient alerts are never
collapsed; only the initiator's own duplicate confirmations are.

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
- **Dedupe key (resolved).** `NotifyRequest` gains an optional `dedupe_key`.
  notification-service computes:
  ```
  dedupe_id = body.dedupe_key ?? `${channel}:${to}:${template_id}`
  ```
  Action emails pass `dedupe_key = ${action_id}:${update_count}:${kind}` — unique
  per real email, identical per retry/replay of that email. The old coarse
  `channel:to:template_id` default stays for OTP/welcome (which have no action_id).
  **Why required:** the coarse key collapses distinct action emails — e.g. two
  different providers sending `connect_sp_in_req` to the same seeker would share
  `email:connect_sp_in_req` and the second email would be silently dropped. The
  per-event key varies on `action_id` (different conversations), `update_count`
  (req vs each status revision), and `kind` (the two recipients per revision),
  while staying constant across retries of the same email.
  `packages/notification/notification.types.ts` `NotifyRequest` and the
  notification-service `/notify` Zod schema must add `dedupe_key?: string`
  together (shared contract).

Proposed notify call (Phase 1, from `buildActionNotifications` via `nc.notify`):
```json
{
  "channel": "email",
  "template_id": "connect_sp_in_req",
  "to": "seeker@example.com",
  "priority": "realtime",
  "dedupe_key": "aaaaaaaa-1111:0:in_req",
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
- `reg_confirmation` — **replaces** the existing `afterUserCreate` welcome email in
  `packages/auth/src/config.ts` (currently sends inline-html via `template_id:'basic_email'`); swap to catalog `reg_confirmation`.
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
- Missing recipient email (owner has no email) → skip, not an error. `user.email` is
  nullable: a user who registered with a mobile number only (phone OTP) has
  `email = NULL`, so `buildActionNotifications` returns no intent for that owner and
  no email is sent. **Accepted for the email-only phase.** Make the skip observable —
  emit a log line **and a counter/metric** ("notification skipped: owner has no email")
  so the number of users going dark is visible, not silent. No phone fallback now (no
  SMS templates in scope); a future channel keyed by the same `template_id` (§9)
  covers phone-only users later.
- Missing template vars → notification-service render validation rejects; logged.
- **Two-layer dedupe:** (1) dispatch is gated on `insertActionEvent` returning a
  non-null `created` — `onConflictDoNothing` returns null on replay/mirror/retry, so
  duplicate events never reach `nc.notify`; (2) notification-service `dedupe_id`
  (from caller `dedupe_key = action_id:update_count:kind`) catches HTTP-retry
  double-sends after a partial success. Distinct action emails get distinct keys;
  retries of the same email collapse.

## 8. Testing

- Unit: `buildActionNotifications` — each of the 16 specific mappings (interaction × direction × kind), local-vs-remote owner skip, missing-email skip (phone-only owner), var building including `serviceName`/`userName` source per the §2 map and `statusLabel` for `*_status`.
- Unit: bulk-confirmation collapse (§4.2a) — N-action batch emits N `in_*` but a single `bulk_out_req` summary; batch of 1 keeps the normal single `out_req`.
- Unit: notification-service renderer — placeholder substitution, missing-var rejection, html pass-through fallback.
- Integration: perform → `*_req` pair; update-status → `*_status` pair; cross-instance ownership (each instance sends only its local recipient).
- Aggregator: manual verify Keycloak OTP email copy via MailHog.

## 9. Out of scope / future

- Kafka event bus + per-instance consumer (`KafkaDispatcher`) — Phase 2; enabled by the dispatcher seam. `action.events` topic also feeds a future metrics/computation consumer (accept/reject counts), which is the strategic reason for the streaming-ready shape.
- Additional delivery channels for these templates. The transport is already
  channel-agnostic: `NotifyRequest.channel` is a generic string and templates are
  keyed by `template_id` in the notification-service catalog. Adding a new channel
  means adding a catalog entry for that `template_id` + channel in
  notification-service and passing the channel through — no change to the action
  trigger / dispatch logic in Signals. Channel for this work stays email only.
- i18n of template copy (currently en only).
- **Notification preferences / opt-out / unsubscribe.** No per-user notification
  settings and no unsubscribe link in this phase — all action/auth emails are
  transactional. Explicitly out of scope (noted so it is a decision, not an oversight);
  revisit if any of these become marketing-style or volume grows.

## 9a. Implementation ordering (cross-repo)

Templates live in **notification-service** (separate repo). Signals only references
`template_id`. Order:

1. **notification-service first** — add the catalog (19 entries) + renderer +
   missing-var validation + `dedupe_key` support in the `/notify` Zod schema; deploy.
2. **Signals-DPG second** — add `dedupe_key?` to `NotifyRequest`, the dispatcher,
   `buildActionNotifications`, and the trigger call sites; flip basic templates to
   catalog `template_id`s.

The html pass-through fallback (§4.3) keeps existing OTP/welcome working through the
transition. Renderer unit tests (§8) are authored/run in notification-service, not here.

## 10. Open items to resolve in implementation

1. Confirm seeker-vs-provider role key on items (drives `sp`/`ps`) — derive from `item_type` + interaction `from_items`/`to_items` in network config.
2. Exact frontend route paths for received-request / sent-request / login links.
3. Whether `reg_otp` should also replace the current aggregator-shared OTP template wording or stay signalstack-only (current decision: signalstack-only; aggregator OTP stays in Keycloak).
4. ~~Verify `owner_id → email` lookup path.~~ **Resolved.** `source_item_owner` /
   `target_item_owner` = `items.created_by` = better-auth `user.id`
   (`get_action_contact_details.ts:65`, `update_action_status.ts:287-288`).
   `buildActionNotifications` reads the owner's **account email** via
   `select user.email from user where id = ownerId` (`auth.ts:13`). Notes:
   - `user.email` is **plaintext** (`text('email').unique()`), not encrypted. The
     codebase's `item_private_state` encryption is for item PII, not account emails.
   - Use the account email, **not** the consent-gated item contact email
     (`get_action_contact_details` / `pii_reveal_audit`) — no decryption, no consent
     gate, no PII-reveal audit for own-account notifications.
   - `user.email` is nullable (phone-only users) — see §7 skip handling.
   - One-line lookup; add a small helper in `packages/database` (no existing one).

5. **Login-vs-signup OTP discriminator.** better-auth `sendEmailOtp`
   (`packages/auth/src/config.ts`) fires for both login and signup but the callback
   carries no type flag. Determine how to distinguish (better-auth option / separate
   hook / inspect whether the user already exists) so `reg_otp` vs `login_otp` is
   chosen correctly. Until resolved, default to `login_otp` copy (safe for returning
   users). Blocks correct OTP copy, not the action-notification work.

**Decided during review:**
- **Dispatch site:** fire at the call sites (after each `insertActionEvent`), gated on a non-null `created`, fire-and-forget (`void dispatcher.dispatch(...).catch(log)`), matching the existing `mirrorActionEventToSourceInstance` pattern. `insertActionEvent` stays a pure `(db, event)` DB util — dispatcher/logger/config are not injected into it.
- **Dedupe:** two-layer — `created` gate + caller `dedupe_key = action_id:update_count:kind` honored by notification-service (§4.3, §7).
- **Channel:** carried as a field, defaulted to email; transport channel-agnostic (§4.1, §9).
- **Cross-repo order:** notification-service catalog ships first (§9a).
