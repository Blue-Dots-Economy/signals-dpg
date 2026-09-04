---
suite: 8
name: Actions
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 8 — Actions — STUB

**Existing journey today:** Journey D, E, F, R (action→event, bulk, PII
reveal, action limits) — real, existing API coverage, run under the
`actions`/`connect`/`apply` alias (grep `Journey D|Journey E|Journey F|Journey R`).

**What this design does not close:** the UI side of both directions of an
action (send + respond), bulk selection in the browser, the contact-details
error-code family surfaced as user-facing copy rather than machine codes, and
per-profile scoping of "My Actions" (#439) as a UI assertion rather than only
a server-enforced filter.

Follow-on: the second plan in this epic.
