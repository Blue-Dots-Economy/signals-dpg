---
suite: 15
name: Cross-cutting UI
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 15 — Cross-cutting UI — STUB

**Existing journey today:** `journey-l-i18n-theme.ui.spec.ts` (`ui-i18n-theme`
in `coverage.md`) — some i18n/theme coverage already exists, though it is not
grep-mapped to a dedicated alias in this plan's table (it is swept into a full
run only).

**What this design does not close, despite most of it being exactly
assertable (spec §4.1, not a taste judgement):** per-network `data-network`/
`data-brand` attributes and every resolved `--brand-*` token against
`network-themes.ts`; the brand logo resolving and returning 200; favicon
regeneration from `--brand-cta`; per-brand document title; light/dark/system
toggling; WCAG AA contrast ratios (computable, not a human call); responsive
overflow structure; and an accessibility/console-error budget. The genuinely
human-only part stays narrow: whether a palette is *attractive*, and the first
approval of a new screenshot baseline (`coverage.md`'s human-only list).

Follow-on: the second plan in this epic.
