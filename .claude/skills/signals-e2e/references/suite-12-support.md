---
suite: 12
name: Contact support
requires:
  fixtures: `provisioningMethod(cfg, caps) !== null` + `caps.testOtp` for both
    the API and UI specs.
  capabilities: testOtp. `faultInjection` is available (notify-sink.mjs's
    `POST /_e2e/fail-next`) but nothing calls it yet — see gaps below.
  grep: `Journey L`
---

# Suite 12 — Contact support

## Cases

**API (`journey-l-support.spec.ts`):**
- support config requires auth and, when reachable, describes the limits
- an authenticated caller gets the server's own attachment limits back

**UI (`journey-l-support.ui.spec.ts`):**
- a signed-in user can open and submit the support dialog

## Known gaps (parked for the follow-on plan)

- **Attachments** — no spec actually uploads a file through the support
  dialog and asserts it's carried through; today's UI case only submits the
  text fields.
- **Rate limiting** — the server's own rate-limit counters (mentioned in
  `CLEANUP_TABLES`' scope) are never driven to their limit and asserted.
- **502/503 via `fail-next`** — `notify-sink.mjs`'s forced-failure endpoint
  exists specifically to reach `502 SUPPORT_SEND_FAILED` and prove the
  best-effort send path never turns a recorded consent/support request into a
  500, but no spec calls `POST /_e2e/fail-next` yet.
