---
suite: 4
name: Profile creation (schema-driven)
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 4 — Profile creation (schema-driven) — STUB

**Existing journey today:** Journey A, P (`e2e/tests/api/journey-a-signup-profile.spec.ts`,
`journey-p-item-update.spec.ts`) cover profile creation and update as plain
API calls. The `profile`/`form`/`schema` alias's grep (`Journey A|Journey P`)
runs those.

**What this design does not close** (per `coverage.md`'s gap column — "the
whole UI half"): `x-uri` link rendering, `x-error-message` copy resolution,
`x-reference-source` autocomplete, `x-show-if` conditional fields, completion
percentage, and the DigiLocker/Dhiway wallet import. None of these have a UI
spec yet — Task 10 builds the machine (stubs, indexer, report) and gets the
*existing* journeys green; it does not add new UI specs for suites 4–11 and
14–16 (see the plan's self-review, "Deliberately deferred").

Follow-on: the second plan in this epic, scoped explicitly to the audit's §3
UI backlog (`docs/testing/e2e-drift-audit-2026-09-02.md`).
