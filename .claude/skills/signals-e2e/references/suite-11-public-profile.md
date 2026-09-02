---
suite: 11
name: Public / shareable profile
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 11 — Public / shareable profile — STUB

**Existing journey today:** none. The shareable-link feature (#476) and its
downloadable QR (#567) shipped on `feature` after the lifted suite was
written; `check-coverage.mjs`'s route table has no entry for it because the
public page is a UI route, not (only) an API operation.

**What this design does not close:** the share button, the public `/p/`-style
page rendering without a session, and the QR download.

Follow-on: the second plan in this epic.
