# Support form attachments — design

**Issue:** [signals-dpg#551](https://github.com/Blue-Dots-Economy/signals-dpg/issues/551) (requirements thread: [#283](https://github.com/Blue-Dots-Economy/signals-dpg/issues/283), specifically [this comment](https://github.com/Blue-Dots-Economy/signals-dpg/issues/283#issuecomment-5263161514))
**Date:** 2026-08-13
**Repos touched:** `signals-dpg`, `aggregator-dpg`, `notification-service`
**Branch (all three):** `feat/551-support-attachments`, cut from `origin/develop`

## Problem

The grievance/support form spec in #283 lists six required fields. Five shipped in v1;
field 5 — *"Attach image or video or audio", size allowed up to 5 MB* — was deferred.
This design covers that field.

The form exists in two products, and one of them mails through a shared relay, so
three repos change:

| | signals-dpg | aggregator-dpg |
|---|---|---|
| UI | `apps/ui/src/components/support/support-dialog.tsx` | `apps/web/src/components/support/SupportDialog.tsx` + Next BFF `app/api/support/route.ts` |
| API | `apps/api/src/routes/v1/support/submit_support.ts` | `apps/api/src/routes/support.ts` |
| Mail path | `dispatchEmail()` → **notification-service** → Redis queue → nodemailer | its own `@aggregator-dpg/mailer` (SMTP or SES), no relay |
| Object storage | none | S3/MinIO (bulk uploads, QR) |

## Decisions

Each of these was a real fork in the road; the rejected option is recorded so a
future reader doesn't relitigate it.

**1. Base64 attachment on the email, not an object-storage link.**
The file rides the request as base64 and lands as a real MIME attachment, so the
support person opens it from the mail and nothing expires. The alternative —
upload to S3, email a pre-signed link — was rejected because Signals has no
object storage today: it would make an S3 bucket (plus credentials, endpoint
config, and a retention policy) a hard dependency of every Signals deployment,
to serve one form field. Aggregator does have S3, but splitting the transport
per product would make the two support flows behave differently and the email
copy diverge.

Accepted costs: HTTP body limits must rise in three services, and a queued
attachment job occupies ~6.7 MB of notification-service Redis until it drains.

**2. Up to 3 files, 5 MB total (decoded), both limits env-configurable.**
Per-file-5 MB with 3 files was rejected: 15 MB of base64 is ~20 MB on the wire
and exceeds SES's per-message limit outright.

**3. Every attachment cap in the system defaults to 5 MB — including the relay's.**
A deliberately-higher relay cap would absorb a caller raising its own limit
without a matching relay change, but at the cost of two different "max size"
numbers. One number, and a config mismatch surfaces as an explicit error.

**4. HTTP body limits are derived from the configured cap, never hardcoded.**
`bodyLimit = ceil(maxTotalBytes × 4/3) + 256 KB`. Base64 inflates the payload by
4/3 and the JSON envelope carries the html body and the other form fields, so the
limit must exceed the cap. Deriving it means raising the cap can never turn into a
silent 413.

**5. MIME allowlist enforced on both sides; the list stays a code constant.**
An operator-editable type list is a short path to "the support inbox now accepts
`.exe`". Adding a type is a one-line change in one shared list.

**6. Per-user rate limit on support submission, both APIs.**
The endpoint becomes a multi-MB authenticated upload whose payload sits in Redis
until delivered. Neither API rate-limits it today.

**7. Attachment names/sizes are listed in the email body via the existing
`detailsTable` html token.** No new copy tokens, so the #529 overridable
email-copy files and `email_cases.ts` are untouched.

## The wire contract

Identical in both products:

```ts
attachments?: Array<{
  filename: string;      // sanitised server-side
  contentType: string;   // must be in the allowlist
  data: string;          // base64, no data: prefix
}>
```

Validated in both APIs and again in notification-service:

- **count** ≤ `SUPPORT_ATTACHMENT_MAX_FILES` (default 3)
- **total decoded size** ≤ `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` (default 5242880).
  Computed from base64 length (`floor(len × 3/4)` minus padding) so an oversized
  payload is rejected without decoding it.
- **contentType** in the allowlist below
- **filename** sanitised: path separators and control characters stripped, length
  capped. It ends up in a MIME header and a human's inbox.

Allowlist — the phone-produced formats are deliberate, not incidental:

```
image/jpeg, image/png, image/webp, image/gif, image/heic, image/heif
video/mp4, video/quicktime, video/webm, video/3gpp
audio/mpeg, audio/mp4, audio/aac, audio/wav, audio/x-wav, audio/ogg, audio/webm, audio/3gpp, audio/amr
```

`image/heic` covers iPhone photos; `video/3gpp` and `audio/amr`/`audio/3gpp`
cover Android camera and voice-recorder output. Omitting them would reject the
most likely real-world submissions.

Distinct error codes per rejection reason, not one generic 400:
`ATTACHMENT_COUNT_EXCEEDED`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TYPE_NOT_ALLOWED`
(Signals' `{error, message}` shape; aggregator's `httpError` catalogue).

## Configuration

| Repo | Var | Default |
|---|---|---|
| signals-dpg | `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` | `5242880` |
| signals-dpg | `SUPPORT_ATTACHMENT_MAX_FILES` | `3` |
| aggregator-dpg | `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` | `5242880` |
| aggregator-dpg | `SUPPORT_ATTACHMENT_MAX_FILES` | `3` |
| notification-service | `NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES` | `5242880` |
| notification-service | `NOTIFY_BODY_LIMIT_BYTES` | derived (≈7.2 MB); override only |

Signals' vars go in `packages/config/src/secrets.ts` (`NotificationSecretsSchema`,
beside `SUPPORT_EMAIL`) **and** `turbo.json`'s `globalPassThroughEnv` — both, per
`.claude/rules/env-vars.md` — plus `.env.example`, surfacing on `supportConfig`
in `apps/api/src/config.ts`. Aggregator's go in `apps/api/src/config.ts`'s zod
schema, `.env.example`, and `docker-compose.yml`.

**Ordering constraint, to be documented in ops docs:** caller cap ≤ relay cap ≤
transport limit. SES caps a message at 10 MB *after* base64 inflation, so ~7 MB
of original file is the hard practical ceiling regardless of configuration.
Raising a caller's cap above the relay's produces an explicit relay-side
rejection, not a silent drop.

## The UI learns limits from the server

New `GET /api/v1/support/config` in Signals, returning:

```ts
{ enabled: boolean; maxTotalBytes: number; maxFiles: number; allowedTypes: string[] }
```

Aggregator's existing `GET /v1/support/config` (today `{ enabled }`) gains the
same three fields; its Next BFF proxy already forwards verbatim.

Both dialogs render "up to N MB" from the response and pre-validate against it.
Rejected alternative: a `VITE_`/runtime-env var in each UI — two numbers to keep
in sync with the API, and drift shows up as a confusing server-side rejection of
a file the UI accepted. Signals also gains the `enabled` gate its UI currently
lacks: today it submits blind and surfaces a 503 as a toast.

The Signals hook is config-tier React Query (5 min staleTime), per
`apps/ui/CLAUDE.md`'s caching tiers.

## Per-repo changes

### signals-dpg

1. **New** `apps/api/src/support/attachments.ts` — pure validator: count, total
   size from base64 length, allowlist membership, filename sanitiser. Unit-tested
   in isolation.
2. `apps/api/src/routes/v1/support/submit_support.ts` — `attachments` on
   `SubmitSupportBody`; **route-level** `bodyLimit` derived from the configured
   cap (Fastify's global default is 1 MB and stays 1 MB for every other route);
   rate-limit check; attachments passed to `dispatchEmail`.
3. **New** `apps/api/src/routes/v1/support/support_config.ts` — the `GET /config`
   route above, registered under the existing `/support` prefix in
   `v1_routes.ts`. Note that group has **no group-level auth hook**, so this
   route sets `preHandler: auth_middleware_if_enabled` itself
   (`apps/api/CLAUDE.md`, "Route auth wiring").
4. `apps/api/src/support/build_support_email.ts` — attachment rows (name + human
   size) appended to `buildSupportDetailsTable`'s output.
5. `apps/api/src/notifications/email/dispatch_email.ts` — `attachments?:
   EmailAttachment[]` on `DispatchEmailArgs`, forwarded inside
   `EmailNotifyRequest.variables` (that is the field the relay validates against
   the provider schema and hands to the mailer, so the notify envelope itself
   doesn't change).
6. **New** `apps/api/src/utils/rate_window.ts` — the fixed-window Redis counter
   currently private to `services/guardian_otp.ts` (`incrWithinWindow`),
   extracted so both callers share it. Support: 5 submissions per user per hour →
   `429 SUPPORT_RATE_LIMITED` with retry-after.
7. `apps/ui/src/components/support/support-dialog.tsx` — file picker
   (`accept` built from `allowedTypes`), client-side count/size/type validation
   against the config response, chosen-file list with size and remove, `FileReader`
   base64 encoding, submit disabled while encoding.
8. `apps/ui/src/lib/support-api.ts` — `attachments` on `SupportSubmission`, plus
   the config fetch.
9. New i18n keys in `apps/ui/src/i18n/locales/{en,hi,kn}.json`.
10. Docs: the support paragraph in `apps/api/CLAUDE.md`, `.env.example`, and the
    SES ceiling note in ops docs.

### notification-service

1. `src/lib/providers/email/index.ts` — `attachments` in the email provider zod
   schema, with count and total-size refinements.
2. `src/lib/providers/email/sendMailCore.ts` — accept `attachments` (currently the
   function destructures a fixed field list, which is exactly why extra
   `variables` keys are silently dropped today) and map to nodemailer
   `attachments: [{ filename, content: Buffer.from(data, 'base64'), contentType }]`.
   The SES path here goes *through* nodemailer, so raw MIME is handled for free.
   `MAIL_LOG` logs filenames and sizes only — never base64 content.
3. `src/app.ts` — `bodyLimit` on the Fastify instance, derived from the attachment
   cap with `NOTIFY_BODY_LIMIT_BYTES` as an override. Default today is Fastify's
   1 MB, which would reject every attachment submission.
4. `example.env` + README: the two new vars, and an ops note that an attachment
   job holds ~6.7 MB in the Redis list (and in the retry ZSET / DLQ if delivery
   fails) until it drains.

### aggregator-dpg

1. `packages/mailer/src/interface.ts` — `attachments?: Array<{ filename;
   contentType; content: Buffer }>` on `SendInput`.
2. `packages/mailer/src/smtp.ts` — pass straight through to nodemailer.
3. `packages/mailer/src/ses.ts` — **raw-MIME path.** `Content.Simple` cannot carry
   attachments. When attachments are present, build the message with nodemailer's
   `MailComposer` (nodemailer is already a dependency of this package) and send
   `Content.Raw`, setting the To/Cc/Reply-To headers in the MIME *and* keeping
   `Destination` so envelope recipients stay correct. The existing `Simple` path
   is untouched when there are no attachments.
4. `apps/api/src/routes/support.ts` — extend the `.strict()` body schema, share the
   validator, rate-limit via the existing `services/rate-limiter`'s `consume()`
   under a new `support-submit` namespace (config following the
   `PUBLIC_SUBMIT_RATE_*` precedent), and pass attachments to the mailer.
5. `apps/api/src/routes/support.ts` config route — the three new fields.
6. `apps/api/src/errors/codes.ts` + openapi response wiring — the three attachment
   error codes and 429.
7. `apps/api/src/app.ts` — Fastify `bodyLimit`, derived as above.
8. `apps/web/src/components/support/SupportDialog.tsx` + i18n — same UX as Signals.
9. The Next BFF forwards verbatim and needs no logic change, but ~7 MB POSTs make
   ingress/proxy body limits an ops concern worth a doc line.

## Testing

**Unit.** The validator, one test per rejection path (count, size, type,
filename sanitisation). Details-table attachment rows. `dispatchEmail` forwarding
attachments into `variables`. Relay provider schema accept/reject, and the
`sendMailCore` → nodemailer mapping. **SES raw-MIME**: assert `Content.Raw`
contains the filename and the encoded payload, and that the no-attachment path
still uses `Content.Simple`. SMTP passthrough. Both rate limiters, including the
allow-path and the 429 path.

**Route.** 201 with attachments; 400 with the specific code per rejection reason;
413 when the body exceeds the derived limit; 429 when the window is exhausted;
`GET /config` shape in both products.

**UI.** Client-side validation messages, remove-file behaviour, and the exact
submitted payload shape.

**Manual.** Aggregator against MailHog; Signals with `MAIL_LOG=true` on the
relay. Confirm a real file arrives openable in the inbox, that the body lists
the attachment names, and that a 6 MB file is refused with a readable message
rather than a generic failure.

## Out of scope

DB persistence of submissions → real sequential ticket numbers → audit and
metrics. That is the other item deferred from #283 (originally #120) and needs
its own issue.
