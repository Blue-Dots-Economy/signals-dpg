---
suite: 14
name: Inter-instance / peer
status: stub — parked for the follow-on coverage plan
requires: n/a — no dedicated new coverage lands in Plan 1
---

# Suite 14 — Inter-instance / peer — STUB

**Existing journey today:** none reachable from a single-instance run. The
`*_local` routes exercised by Journey H (suite 6's reference) are the
same-instance half of this surface; the peer half needs
`config.peer.apiBaseUrl` (capability `peer`), which requires a **second**
already-running signals-dpg instance — `stack-up.sh` brings up exactly one.

**Known live bug this suite would need to guard against** (memory:
`signals-peer-fetch-hmac-bug`): inter-instance item fetch can 401 because
`lifecycle_filter` is stripped by Zod before the HMAC re-check is done. Listed
in SKILL.md's gotcha table. A true fix verification needs two instances, which
is exactly what this suite is missing.

Per spec §4: "full test needs a 2nd instance → SKIP" — this is the one suite
in the catalogue that is a structural SKIP on a single-instance run, not a
"not yet written" gap the same way the others are.

Follow-on: the second plan in this epic, if/when a two-instance local
topology is worth the setup cost.
