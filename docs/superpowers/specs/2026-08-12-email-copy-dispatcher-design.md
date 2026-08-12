# Email copy externalization + single email dispatcher (#529)

**Date:** 2026-08-12
**Issue:** [#529 — Externalize email copy (overridable messages file) + single notification dispatcher](https://github.com/Blue-Dots-Economy/signals-dpg/issues/529)
**Branch:** `feat/529-email-copy-dispatcher` (off `feature`)

## Problem

All email copy (subjects, bodies, CTA labels) is hardcoded in TypeScript across four
places, so changing one sentence requires a code change and a full deploy:

- `apps/api/src/notifications/action_copy.ts` — 16 action variants × (subject, body,
  ctaLabel) plus the retire-cancel copy (~51 strings)
- `apps/api/src/services/guardian_otp_email.ts` — guardian OTP bodies for 4 scenarios
- `apps/api/src/support/build_support_email.ts` — support email subject/body
- `packages/auth/src/config.ts` + `templates/otp_email.ts` — login OTP email and the
  inline welcome email

Sending is equally scattered: ~6 call sites each call the notification client's
`notify()` directly, each hand-rolling `template_id: 'basic_email'`, the
`fromName/fromEmail/replyTo/subject/html` variables, and their own error handling.

## Goals

1. All email **copy** lives in one overridable properties file; ops can change any
   sentence at deploy time via a Kubernetes ConfigMap mount, without a code change.
2. All email **sends** go through one dispatcher that owns copy lookup, variable
   substitution, escaping, the HTML shell, and the error policy.
3. Runtime variables are HTML-escaped on substitution (XSS-safe); inline HTML in the
   trusted copy file is preserved.
4. The existing critical-vs-best-effort behaviour is preserved: OTP failures surface
   to the user; action/retire/welcome emails never block their triggering action.

## Non-goals (out of scope)

- SMS bodies (DLT-approved templates owned by the notification service) and the
  welcome WhatsApp message (contentSid-based) — unchanged, still sent via the raw
  notification client.
- Localization — single locale now; the file/key structure is locale-ready
  (`messages_<locale>.properties` later), but no locale plumbing is built.
- Notification-service changes. Its email provider registers exactly one template
  (`basic_email`) and rejects unknown ids (`notification-service/src/routes/notify.ts`,
  `mailer.ts`), so the wire `template_id` stays `basic_email`. The issue's "stable
  template_ids per case (registry)" is satisfied by an **internal** case registry in
  Signals (see below).
- Hot-reload of copy. The file is loaded once at boot; copy changes apply on the next
  deploy/restart, matching the issue's "override at deploy" framing.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Scope of `packages/auth` emails | **Full scope** — login-OTP + welcome copy move to the file, sends route through the dispatcher via an injected callback |
| Fallback granularity | **Per-key** — a valid override key wins; each missing/invalid key falls back to that key's bundled default (warning log); unparseable file → all defaults |
| Load timing | **Once at boot**, in-memory singleton (same pattern as `network_configs.ts`) |
| Placeholders | **Optional, best-effort** — documented as comments in the file; unrecognised `{{tokens}}` are left in the output as raw text, never an error |
| Support email criticality | **Critical** (deliberate deviation from the issue's wording — see Error policy) |
| Architecture | **Approach A** — loader/registry/dispatcher live in `apps/api`; `packages/auth` gets a send-callback injected through `AuthRuntimeConfig` |

## Design

### 1. The messages file

Java-properties-style, UTF-8: `key=value` per line, `#` comments, blank lines
ignored, values run to end of line (no line-continuation in v1 — bodies are single
paragraphs with light inline HTML: `<p>`, `<b>`, `<a>`, `<ol>/<li>`).

- **Bundled default:** `apps/api/src/notifications/email/messages.default.properties`,
  shipped in the image. This file is also the reference ops copy into a ConfigMap.
- **Override:** `EMAIL_MESSAGES_PATH` (new env var, optional) points at the mounted
  override file. Unset → bundled defaults only (local dev needs nothing).

Key layout — `<case>.<field>`:

```properties
# action emails: action.<group>.<role>.<shape>.{subject|body|cta}
#   group: connect | apply    role: seeker | provider
#   shape: inbound_request | outbound_request | inbound_status | outbound_status
action.connect.seeker.inbound_request.subject=A service provider wants to connect with you
action.connect.seeker.inbound_request.body=<p>{{name}} has expressed interest in connecting with you. ...</p>
action.connect.seeker.inbound_request.cta=View the details and respond
# ... 15 more variants × 3 keys

retire.cancel.{subject|body|cta}                    # retire → counterparty (#418)
guardian.account.{subject|body}                     # guardian OTP: ward account signup
guardian.profile.{subject|body}                     # guardian OTP: ward profile creation
guardian.action.{subject|body}                      # guardian OTP: single action
guardian.action_bulk.{subject|body}                 # guardian OTP: bulk action (#393)
otp.generic.{subject|body}                          # scenario-less guardian OTP fallback
login.otp.{subject|body}                            # better-auth login OTP email
welcome.{subject|body}                              # post-signup welcome email
support.request.{subject|body}                      # support form → support inbox
```

(`x.{a|b}` above is shorthand for this spec only; the real file has one full
`key=value` line per field.)

**Placeholder documentation lives in the file.** Each section is preceded by a
comment block listing the placeholders available to those templates and stating the
rule, e.g.:

```properties
# Placeholders available in guardian.* templates:
#   {{otp}}     the one-time password code
#   {{domain}}  the website/network name the ward is joining
#   {{org}}     the organisation the ward wants to connect to
#   {{orgList}} (action_bulk only) formatted list of all organisations
# Placeholders are optional — use the ones you need. Anything not recognised
# is left in the email as-is, exactly as you typed it.
```

**No conditionals in the file.** Copy that previously branched in code
(`domain ? " on <b>domain</b>" : ""`) is rewritten to always include the token, and
code always supplies a value with a sensible fallback (the existing
`FALLBACK_SERVICE_NAME` pattern; e.g. `{{domain}}` falls back to the app name,
`{{org}}` to "the organisation").

### 2. Loader — `apps/api/src/notifications/email/messages.ts`

Module-level singleton, loaded once at boot:

1. Parse the bundled defaults. **Every key the case registry requires must be
   present — otherwise fail startup.** A hole in the defaults is a build defect, not
   an ops condition.
2. If `EMAIL_MESSAGES_PATH` is set: parse the override. Unreadable/unparseable file →
   error log, defaults used wholesale. Email never silently breaks.
3. **Per-key merge:** valid override keys win; every other required key falls back to
   its bundled default. One warning log lists (a) required keys that fell back and
   (b) override keys that match no known key (typo catcher).
4. Placeholder lint (warn-only): a value referencing a token not declared for its
   case logs a warning (`"guardian.account.body references unknown placeholder
   {{otpp}}"`). The value is still used as written — unrecognised tokens render as
   literal text (see Substitution).

Locale-readiness: the parser/merger takes a file path, so `messages_kn.properties`
later is a second path + locale parameter — no format or code-structure change.

### 3. Case registry — `apps/api/src/notifications/email/email_cases.ts`

One entry per email case (this is the issue's "template_id registry", internal to
Signals). Per case:

- **copy keys** — which `subject`/`body`(/`cta`) keys it reads
- **declared tokens** with a type: `text` (default; always HTML-escaped on
  substitution) or `html` (inserted raw; **only** code-built values assembled from
  already-escaped parts). Exactly two `html` tokens exist: `{{orgList}}`
  (guardian bulk `<ol>`) and `{{detailsTable}}` (support field table).
- **shell** — `cta` (branded shell: greeting, body, CTA button + fallback link,
  sign-off; today's `renderEmailShell`) or `plain` (body paragraphs + sign-off; for
  OTP/support-style mail)
- **criticality** — `critical` | `best_effort`
- **priority** — the notification-service priority (`realtime` for OTPs, `other`
  for the rest), matching current behaviour

Case classification:

| Case | Criticality | Shell | Priority |
|---|---|---|---|
| `action.*` (16) | best_effort | cta | other |
| `retire.cancel` | best_effort | cta | other |
| `guardian.*`, `otp.generic` | critical | plain | realtime |
| `login.otp` | critical | plain | realtime |
| `welcome` | best_effort | plain | realtime |
| `support.request` | critical | plain | other |

### 4. Dispatcher — `apps/api/src/notifications/email/dispatch_email.ts`

```ts
dispatchEmail({
  caseId,            // key into the registry, e.g. 'guardian.account'
  to,                // recipient email
  variables,         // Record<string, string> for text tokens (+ html tokens)
  dedupeId?,         // caller-supplied (action: `${actionId}:${updateCount}:${shape}`, support: reference)
  replyTo?, cc?,     // support email overrides replyTo to the submitter, adds cc
}): Promise<{ ok: boolean }>
```

Flow: registry lookup → copy lookup → substitute → shell → send via the notification
client with `template_id: 'basic_email'` and centrally resolved
`fromName`/`fromEmail`/`replyTo` (from instance/support config — this removes the
hardcoded `hello@bluedotseconomy.org` in `packages/auth`).

**Substitution rules (the security boundary):**

- File copy is trusted (in git / reviewed ConfigMap) → inserted raw, so inline HTML
  works. Never escape the whole string.
- `text` tokens are user data → **HTML-escaped on substitution**, always.
- `html` tokens are inserted raw but may only be produced in code from
  already-escaped parts; the registry allowlists them per case.
- Substitution is best-effort: recognised tokens with provided values are replaced;
  any other `{{...}}` sequence is left in the output verbatim.
- Subjects are plain text: tokens substituted **unescaped** (no HTML context), any
  markup in subject copy is not interpreted.

**CTA URL:** unchanged — resolved in code from `FRONTEND_BASE_URL`
(`notify_actions.ts` → `buildCtaUrl`), shared by all `cta`-shell emails. The file
carries only the button **label** (`.cta` keys); URL and per-network button colour
(`resolveBrandColor`) stay code/config-resolved.

**Error policy:**

- `critical` → `dispatchEmail` throws on send failure; the caller surfaces it
  (guardian/login OTP → existing fail-loud 502 path; support → existing
  `SUPPORT_SEND_FAILED` 502).
- `best_effort` → never throws; failures are caught, logged with case + context, and
  returned as `{ ok: false }`. An action/retire/welcome email failure can never
  block or roll back the triggering operation.
- Deliberate deviation from the issue's wording ("action/support emails are
  best-effort"): **support stays critical.** Sending the support email *is* the
  user's action — swallowing a failure would return `ok: true, reference` for a
  message nobody received. Current 502 behaviour is preserved.

### 5. Call-site migration (6 sites)

| Site | Change |
|---|---|
| `notifications/dispatcher.ts` (action emails) | Keeps its plan/recipient-resolution logic. `renderActionEmail` is absorbed: group×role×shape (via the retained `resolveCopyGroup`/`resolveRecipientRole`) resolves to a `caseId`; body/subject/cta come from the file; the COPY table in `action_copy.ts` is deleted. |
| `notifications/notify_retire.ts` | → `dispatchEmail('retire.cancel', ...)`; `RETIRE_CANCEL_COPY` moves to the file. |
| `routes/v1/support/submit_support.ts` | Builds the escaped `{{detailsTable}}` html token (the table builder in `build_support_email.ts` survives as the token builder); → `dispatchEmail('support.request', ..., { replyTo: submitter, cc, dedupeId: reference })`. |
| `services/guardian_otp.ts` (email branch) | → `dispatchEmail('guardian.<kind>')` / `dispatchEmail('otp.generic')`; `guardian_otp_email.ts` is absorbed. SMS branch unchanged. |
| `packages/auth/src/config.ts` — `sendEmailOtp` | Calls injected `sendEmail({ caseId: 'login.otp', to, variables })`; failure still rethrown (critical) so OTP delivery failure returns 502 (#1.14 preserved). `templates/otp_email.ts` deleted. |
| `packages/auth/src/config.ts` — welcome email in `afterUserCreate` | Calls injected `sendEmail({ caseId: 'welcome', ... })`; best-effort (never blocks signup). Inline welcome HTML deleted. |

**Auth injection:** `AuthRuntimeConfig` gains
`sendEmail?: (args: { caseId, to, variables }) => Promise<void>`; `apps/api` wires it
to `dispatchEmail` where it builds the rest of the auth config. When absent (tests /
no notification client), the existing console-log fallback behaviour is kept.
Phone-OTP SMS and welcome WhatsApp keep using the raw injected notification client.

Naming note: the existing `notifications/dispatcher.ts` is the action-notification
*planner*, not the new send layer. The new module is `dispatch_email.ts` /
`dispatchEmail()`; if confusion persists during implementation, the planner file may
be renamed (`action_notification_planner.ts`) in a follow-up — not required here.

### 6. Config & env

- `EMAIL_MESSAGES_PATH` (optional string) added in **both**
  `packages/config/src/secrets.ts` and `turbo.json` (the two-places rule in
  `.claude/rules/env-vars.md`).
- No other new env vars. From/replyTo resolution reuses existing
  `supportConfig`/instance config.

### 7. Kubernetes override (ops)

- ConfigMap holds the full properties file (start from the bundled default; the
  placeholder comments travel with it).
- Mounted at a path, `EMAIL_MESSAGES_PATH` points at it. Bad/missing mount →
  bundled defaults, loud logs, email keeps working.
- A short how-to is added under `docs/operations/` (mount example + fallback
  semantics + placeholder rules).

## Testing

- **Parser/loader:** comments, blank lines, `=` inside values, UTF-8; per-key merge
  and fallback; unparseable override → defaults; unknown-key and
  unknown-placeholder warnings; startup failure when the bundled defaults are
  missing a registry key.
- **XSS acceptance test:** a `text` token containing `<script>alert(1)</script>` is
  escaped in the output; inline `<p>/<b>/<a>` in copy is preserved; `html` tokens are
  inserted raw only when allowlisted for that case; unrecognised `{{tokens}}` pass
  through as literal text.
- **Registry completeness:** every case's required keys exist in
  `messages.default.properties` ("forgot to add copy" is a red test, not a runtime
  surprise).
- **Dispatcher:** critical throws / best-effort swallows and logs; from/replyTo/cc/
  dedupe wiring; priority per case.
- **Call-site behaviour preserved:** existing tests (`action_copy.test`,
  `render_action_email.test`, `notify_retire.test`, `build_support_email.test`,
  `misc_handlers_group.test`, auth `otp_delivery.test`) are migrated to the new
  lookup. Copy strings move **verbatim**, so expected subject/body texts stay
  identical — any diff in those tests is a migration mistake.

## Acceptance (mapped to #529)

- [ ] All hardcoded email copy lives in `messages.default.properties`; none inline
      in TS (verified by deletion of the copy constants + registry-completeness test).
- [ ] ConfigMap override works end-to-end; invalid/missing file falls back per-key /
      wholesale to bundled defaults with warnings.
- [ ] Variables escaped on substitution; inline HTML in copy preserved (XSS test).
- [ ] All email sends go through `dispatchEmail`; the 6 old direct `notify()` email
      call sites are removed.
- [ ] OTP (guardian + login) failures surface to the user; action/retire/welcome
      failures are logged and never block the triggering action. Support failure
      still returns 502 (documented deviation).
