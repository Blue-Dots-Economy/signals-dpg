# Support / contact form — email to configured recipient — design

**Date:** 2026-07-09
**Issue:** [Blue-Dots-Economy/signals-dpg#120](https://github.com/Blue-Dots-Economy/signals-dpg/issues/120) — *Grievance redressal: intake form → email network facilitator + audit/metrics*
**Labels:** area:api, area:ui

## Summary

Add a **Contact support** action to the authenticated user menu. Clicking it opens a network-themed dialog with an optional subject and a required message. Submitting POSTs to a new authenticated endpoint that emails the configured recipient (`SUPPORT_EMAIL`) via the existing notification service, including the submitter's details. The recipient can reply directly to the user.

**Scope for this PR:** email-only. The **audit (who/when/what)** and **metrics (volume/resolution)** parts of issue #120 are deferred — they will ride on the telemetry work when that is picked up (called out in the PR description).

## Design decisions (agreed)

| Decision | Choice |
|---|---|
| Scope | Email-only now; audit + metrics deferred to telemetry |
| Recipient config | Instance env var `SUPPORT_EMAIL` |
| Form fields | Optional `subject` + required `message` |
| User details in email | Full context: name, email, phone, user id, network, timestamp |
| Menu label | "Contact support" with a life-buoy icon |
| Reply-To | The submitter's email (falls back to `NOTIFICATION_FROM_EMAIL`) |
| Delivery | Endpoint **awaits** the send and confirms success (not fire-and-forget) |
| Button visibility | **Always shown** for logged-in users; the endpoint returns 503 when unconfigured and the UI toasts (no extra config endpoint) |
| Dialog styling | Follows the per-network theme, like the login page / consent modal |

### Why `SUPPORT_EMAIL` is schema-optional
`SUPPORT_EMAIL` is `.optional()` in the Zod env schema so the API still boots on instances that don't use the support feature (a hard-required var would fail startup everywhere it isn't set — breaking existing deployments). The feature is instead **gated on its presence**: the button is hidden and the endpoint returns `503` when it's unset, so a submission can never be attempted without a configured recipient. This mirrors the existing `NOTIFICATION_*` handling.

## Configuration (env)

Added to `NotificationSecretsSchema` in `packages/config/src/secrets.ts`:
- **`SUPPORT_EMAIL`** — `z.string().optional()`. The recipient address for support submissions.

Reused (already present):
- **`NOTIFICATION_FROM_EMAIL`** — the From address (same as action emails).
- The notification-service client (`NOTIFICATION_SERVICE_ENDPOINT` / `_KEY_ID` / `_SECRET`) via `getNotificationClient()`.

`SUPPORT_EMAIL` is added to `turbo.json` `globalPassThroughEnv`. `apps/api/src/config.ts` exposes it (e.g. `supportConfig.recipient`) and a derived `support_enabled = Boolean(SUPPORT_EMAIL && NOTIFICATION_FROM_EMAIL && notification client configured)`, used by the POST handler's 503 check.

## API

### `POST /api/v1/support` (session-authenticated)
- `preHandler: auth_middleware_if_enabled`; requires `request.user`.
- Body (Zod, PascalCase schema): `{ subject?: string (≤ 200), message: string (1–5000, required) }`.
- Handler:
  1. If `support_enabled` is false (missing `SUPPORT_EMAIL`, `NOTIFICATION_FROM_EMAIL`, or NS client) → `reply.code(503).send({ error: 'SUPPORT_NOT_CONFIGURED', message })`.
  2. Resolve the submitter from `request.user.id`: load the `user` row for `name`, `email`, `phone_number`. Resolve `network` from `apiConfig.served_domains` (the instance's served network(s), de-duplicated).
  3. Build the email via `buildSupportEmail(...)` (pure helper) → `{ subject, html }`:
     - subject: `[Support] {subject || 'New support request'} — {name}`
     - html: the user's message, then a details block (Name, Email, Phone, User ID, Network, Submitted at). **All user-supplied values (subject, message, name) are HTML-escaped.**
  4. `nc.notify({ channel: 'email', template_id: 'basic_email', to: SUPPORT_EMAIL, priority: 'other', variables: { fromName: `${instance.INSTANCE_NAME ?? 'DPG'} Support`, fromEmail: NOTIFICATION_FROM_EMAIL, replyTo: user.email ?? NOTIFICATION_FROM_EMAIL, subject, html } })`.
  5. **Await** the send. Success → `reply.code(201).send({ ok: true })`. On NS error → `reply.code(502).send({ error: 'SUPPORT_SEND_FAILED', message })` (logged via `request.log.error`).
- Registered in `v1_routes.ts` at prefix `/support` (route-level auth preHandler on the POST).

### Files (API)
- `apps/api/src/routes/v1/support/submit_support.ts` — the `POST /support` route.
- `apps/api/src/support/build_support_email.ts` — pure `buildSupportEmail(input): { subject, html }` with HTML-escaping (unit-tested).
- `apps/api/src/routes/v1/v1_routes.ts` — register the route.
- `packages/config/src/secrets.ts`, `apps/api/src/config.ts`, `turbo.json` — config wiring.

## UI

- `apps/ui/src/lib/support-api.ts`:
  - `submitSupport(input: { subject?: string; message: string }): Promise<void>` → `POST /api/v1/support`.
- `apps/ui/src/components/support/support-dialog.tsx` — a dialog built on the existing `dialog` / `input` / `textarea` / `label` primitives:
  - Optional subject input, required message textarea, Submit button styled with `bg-brand-cta` (per-network theme, matching login/consent).
  - Client validation: message required (non-empty, ≤ 5000).
  - On submit: `submitSupport(...)`; success → success toast, close + clear; `503` → "Support is unavailable right now."; other errors → generic error toast.
- `apps/ui/src/components/auth/user-menu.tsx` — render a **Contact support** item (life-buoy icon) above the Sign-out section that opens the dialog (always shown for logged-in users). If support is unconfigured, submission returns 503 and the dialog toasts "Support is unavailable right now."
- i18n keys added to `en.json` / `hi.json` / `kn.json`: menu item, dialog title, subject/message labels + placeholders, submit label, required-field validation, and success/unavailable/error toasts.

## Error handling

Machine-readable codes: `SUPPORT_NOT_CONFIGURED` (503), `SUPPORT_SEND_FAILED` (502), body validation (400). The endpoint awaits the send so the user gets a real success/failure (not fire-and-forget). Routes never throw past the boundary; failures logged with `request.log.error`.

## Testing

- **Unit — `buildSupportEmail`:** subject format; html contains the message and every detail field (name, email, phone, user id, network, timestamp); HTML-escaping of subject/message/name; graceful rendering when email/phone are absent (phone-only or email-only users).
- **API integration:**
  - Authenticated `POST /support` with a mocked `notify` → asserts `to === SUPPORT_EMAIL`, `replyTo === user.email`, and subject/html contain the message + details; returns 201.
  - Unconfigured (`SUPPORT_EMAIL` unset) → 503 `SUPPORT_NOT_CONFIGURED`.
  - Empty/missing message → 400.
- **UI:**
  - `support-api` unit (`submitSupport`).
  - `support-dialog`: renders, blocks empty message, calls `submitSupport`, shows success and error (incl. 503 "unavailable") states.
  - `user-menu`: renders the Contact-support item and opens the dialog on click.

## Out of scope (deferred)

- **Audit record** (persisting who/when/what) and **metrics** (volume, resolution) from issue #120 — deferred; will ride on the telemetry work when it is picked up.
- Attachments / file uploads.
- Threading, ticket status, or in-app history of submissions.
