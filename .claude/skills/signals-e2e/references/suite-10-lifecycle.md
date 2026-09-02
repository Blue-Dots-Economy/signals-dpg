---
suite: 10
name: Lifecycle
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 10 — Lifecycle — STUB

**Existing journey today:** Journey O (`journey-o-lifecycle.spec.ts`), run
under the `lifecycle`/`retire` alias (grep `Journey O`).

**The oracles this design built are directly relevant here, and are still
unwired to a spec:** `lib/search-indexer.mjs` (Task 7) makes the #557/#564
publish-after-commit race assertable — it already demonstrated the race live
during Task 7's own verification (pause the indexer, flip an item to `paused`,
show `items.paused` vs a stale `item_search.live` row) — and `notify.ts` +
`notify-sink.mjs` (Task 5) make the counterparty-notification fan-out on
retire assertable. Neither is called from `journey-o-lifecycle.spec.ts` yet.

**What this design does not close:** retire's fan-out row assertions (needs
`db` — cancelling every open connection on either side, scrubbing PII,
wiping `item_locations`), the counterparty mail itself, and asserting item
publication on *every* transition (not just retire) from within a spec rather
than from Task 7's own manual verification.

Follow-on: the second plan in this epic.
