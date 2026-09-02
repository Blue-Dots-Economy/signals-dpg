---
suite: 6
name: Browse / list
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 6 — Browse / list — STUB

**Existing journey today:** Journey H (`journey-h-discovery.spec.ts`) covers
the `*_local` instance-scoped fetch routes (owner-scoping, no cross-user
leakage) — it does not touch `POST /api/v1/network/item/discover`.

**The oracle exists; nothing calls it yet.** `lib/search-stub.mjs` +
`e2e/src/search.ts` (Task 6) fully implement the ranked-feed contract —
`translateClause`, the three `POST /_e2e/mode` fault-injection states
(`down`/`slow`/`anchor-not-found`), and the envelope recorder that caught the
`contains_any`-vs-`in` trap live. **No Playwright spec builds a `SearchStub`
or points `discover` at it.** So `faultInjection`'s discover-specific paths
(native fallback with `meta.source = native_fallback`, the anchor-retry on
`ANCHOR_NOT_FOUND`) and the facet-envelope shape assertions are all still
open, despite the machinery to close them already existing.

Follow-on: the second plan in this epic — wiring `SearchStub` into new
`discover`-focused specs is most of that plan's suite-6 work.
