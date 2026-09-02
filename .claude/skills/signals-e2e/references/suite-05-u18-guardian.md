---
suite: 5
name: U18 / guardian
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 5 — U18 / guardian — STUB

**Existing journey today:** Journey C (`journey-c-u18-guardian.spec.ts`) and
Journey S (`journey-s-u18-gating.spec.ts`) — both already lifted, both run
under the `u18`/`guardian` alias (grep `U18`). These are real, existing API
coverage of the fail-closed guardian-action gate; they are not new work from
this plan.

**What this design does not close:** the parked signup-guardian routes
(`POST /api/v1/consent/u18/signup/guardian[/verify]`), the parked precreate
pair (`.../precreate/issue|verify`), the publish-after-commit race specific to
a U18 profile's `draft → live` promotion (#464/#557 intersection), and the
whole UI-side guardian flow (batch OTP modal, minor bulk-action gating in the
browser rather than only at the API).

Follow-on: the second plan in this epic.
