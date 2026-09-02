---
suite: 16
name: Tourist (orange_dot)
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 16 — Tourist (`orange_dot`) — STUB

**Existing journey today:** none. Every lifted journey and every suite in
this catalogue that has real coverage was run and written against `blue_dot`.
`orange_dot` serves a single `tourist` domain — running the *same* journeys
against it is not automatic; each one assumes `blue_dot`'s two-domain,
U18-gated, dual-action shape to some degree.

`run.sh orange_dot tourist` will bring the stack up for `orange_dot` (phase 6
in SKILL.md's phase table — a restart, run as a second pass after the main
`blue_dot` run, never instead of it) but there is currently no spec whose
title matches the `Tourist` grep pattern, so that invocation reports zero
tests run against real assertions today.

Follow-on: the second plan in this epic.
