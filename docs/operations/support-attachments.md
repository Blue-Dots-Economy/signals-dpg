# Support-form attachments — operational notes

The contact-support form (`POST /api/v1/support`) accepts image, video and audio
attachments (#551). This is what an operator needs to know that isn't obvious
from the config.

## The support mailbox must scan attachments

**The API does not verify file contents.** `contentType` is declared by the
client and checked against an allowlist; the bytes are never inspected. Renaming
`payload.exe` to `evidence.png` and declaring `image/png` passes validation and
arrives in the support inbox as an openable attachment.

That is a deliberate scope decision — the allowlist is there to stop honest
mistakes (a PDF, a zip, a 40 MB video) reaching the team, not to make the
mailbox safe. The safety control lives on the receiving side:

- The mailbox behind `SUPPORT_EMAIL` **must** have malware/attachment scanning
  enabled (Google Workspace and Microsoft 365 both do this by default; a
  self-hosted relay may not).
- Agents should be told that attachments come from authenticated but otherwise
  unvetted users, and treated the same as any inbound public attachment.

If a deployment cannot rely on mailbox scanning, the options are to disable the
feature (`SUPPORT_ATTACHMENT_MAX_FILES=0` is **not** valid — the var must be a
positive integer; unset `SUPPORT_EMAIL` to disable the whole form) or to add
content sniffing in `apps/api/src/support/attachments.ts`, which is where a
magic-byte check would go.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` | `5242880` (5 MB) | Total decoded bytes across all files on one submission. |
| `SUPPORT_ATTACHMENT_MAX_FILES` | `3` | How many files one submission may carry. |

Both are served to the UI by `GET /api/v1/support/config`, so raising them takes
effect without a UI rebuild. The route's HTTP body limit is **derived** from the
byte budget (`ceil(max × 4/3) + 256 KB`, covering base64 inflation and the rest
of the form), so there is no second limit to keep in step; every other route
keeps Fastify's 1 MB default.

## Ceilings above the configured cap

Raising `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` alone is not enough:

1. **notification-service enforces its own caps.** `NOTIFY_ATTACHMENT_MAX_FILES`
   and `NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES` must be raised alongside, or the relay
   rejects the submission with a 400 after this API has accepted it.
2. **SES caps a message at 10 MB after base64 inflation**, so roughly 7 MB of
   original file is the practical maximum on that transport regardless of
   configuration.
3. **Ingress/proxy body limits** in front of the API must allow the inflated
   body (~7 MB for a 5 MB budget).

## Queue cost

An attachment-bearing email is JSON-serialised into the notification-service
Redis queue like any other job, so a 5 MB attachment occupies roughly 6.7 MB of
Redis (base64) from enqueue until delivery — and stays there in the retry ZSET or
DLQ if delivery keeps failing. Size Redis accordingly if heavy attachment traffic
is expected.

## Abuse controls

Submissions are capped per user (5 per hour), counted **before** the body is
validated so that repeatedly posting invalid multi-MB payloads still consumes the
quota. The counter fails **open**: if Redis is unreachable the submission is
allowed, on the grounds that a rate-limit outage must not silence a complaint.
