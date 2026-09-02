---
suite: 7
name: Map
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 7 — Map — STUB

**Existing journey today:** none. `/markers` has no journey at all yet — it is
in `check-coverage.mjs`'s `parked` list (`POST /api/v1/network/item/markers`).

**What this design does not close:** viewport queries, marker clustering,
precision labels, and the count-pill. Note the SKILL.md gotcha table entry —
*map count below list total is expected*, not a bug, once this suite exists:
un-geocoded migrated rows plus the map's own viewport scope both shrink the
map's count relative to the full list. That assertion (`@known`, section 3)
should ship with the first real suite-7 spec, not be discovered again later.

`search-indexer.mjs` (Task 7) already maintains `item_search.geo`, so the data
side of a marker query is real once this suite is written — the item_search
maintenance requirement is not itself a gap.

Follow-on: the second plan in this epic.
