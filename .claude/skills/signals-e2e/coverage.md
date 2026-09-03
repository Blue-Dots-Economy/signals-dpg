# Signals E2E — coverage catalogue

This file is the coverage **contract**, not a status report. Two mechanisms
enforce it (spec §9): `e2e/scripts/check-coverage.mjs` diffs the suite against
this file and fails on anything unmapped, and `report.mjs`'s signoff parses
the `## human-only` block below into section 4 of every run's report — so
that section can never drift into flattery by omission.

## Suites

Sixteen numbered suites (0–16). The exhaustive per-case list for each lives in
`.claude/skills/signals-e2e/references/suite-NN-*.md` (Task 10); this table is
the index and the gap assignment.

| # | Suite | Existing journey | Gap this design closes |
|---|---|---|---|
| 0 | Preflight & stack-up | — (suite assumes a live target) | all of it |
| 1 | Config, schema, served domains | preflight, A | `support/config` (the gate's live failure), refetch_schemas, served-domain subsetting |
| 2 | Auth & account | A, B, ui-auth | wrong-portal toast, session expiry, channel validation copy |
| 3 | User consent + legal | K | scroll-gate, `/legal` layout + anchors, `__SUPPORT_EMAIL__` |
| 4 | Profile creation (schema-driven) | A, P | the whole UI half: `x-uri`, `x-error-message`, `x-reference-source`, `show-if`, completion %, wallet import |
| 5 | U18 / guardian | C, S | signup guardian routes (parked), precreate pair (parked), the publish-after-commit race, UI flow |
| 6 | Browse / list | H | discover (parked), native fallback via `faultInjection`, anchor re-rank, facet-envelope shape |
| 7 | Map | — | markers (parked), viewport, clustering, precision labels, count-pill |
| 8 | Actions | D, E, F, R | UI both sides, bulk selection, contact-details error codes, per-profile scoping |
| 9 | Match score | — | `match-score/calculate` (parked), modal, recalculate |
| 10 | Lifecycle | O | retire fan-out row assertions (needs `db`), counterparty mail (needs sink), event publication |
| 11 | Public / shareable profile | — | all of it |
| 12 | Contact support | ui-support | attachments, rate limit, 502/503 via `fail-next` |
| 13 | Integrator surface | I, J, V | needs `serviceApiKey` seeded; dashboard export, decrypt ownership |
| 14 | Inter-instance / peer | — | `*_local` routes (parked); full test needs a 2nd instance → SKIP |
| 15 | Cross-cutting UI | ui-i18n-theme | brand skin, responsive, a11y structural, console-error budget |
| 16 | Tourist (`orange_dot`) | — | all of it |

`report.mjs`'s CLI entry point (`main()`) parses this table directly
(`parseSuiteTable`), so it is the single source of truth — the exported
`SUITES` constant is only a fallback default for a caller that passes no
`input.suites` (a unit test asserting against a fixed catalogue, say).
Renumbering a suite means updating this table; `report.mjs` picks the change
up automatically at the CLI entry point, nothing to keep in sync by hand.

## human-only

<!--
  What a PASS here still does not prove — standing limits of the black-box
  approach itself, true regardless of how this target happens to be
  configured. This is the opposite of a capability gate: nothing would
  change if we wired more env vars or seeded more infra. If an entry could
  be closed by configuring something, it belongs in `## capability-gated`
  below, not here (field-test fix E moved `geocoding accuracy` for exactly
  this reason).
-->

- brand skin correctness (logo, palette) — a screenshot is captured, not judged
- whether a responsive layout *looks* right at each breakpoint
- accessibility beyond structural aria/focus checks
- real Keycloak/OIDC login (config-gated; authProvider defaults to betterauth)
- true multi-instance inter-instance browse (needs a second API)
- real DigiLocker and Dhiway wallet imports
- real SMS delivery — DLT template ids ship empty by design
- email deliverability and mail-client rendering
- relevance quality when the search stub ran instead of --profile search

## capability-gated

<!--
  Config-gated surface that is "not configured here", not a standing limit —
  the mechanical twin of the `## human-only` list above. Most entries in
  this category are already derived straight from the run's own capability
  skips (`report.mjs`'s `skipSummary`, rendered right under the
  "⏭️ Skipped (capability-gated)" counter in every report — never
  hand-maintained). This block exists ONLY for a gate that has no live
  `requireCapabilities()` call to derive from yet, so it would otherwise be
  invisible to that automatic summary. Add an entry here only when that is
  true; the moment a spec starts gating on it for real, delete the line —
  the automatic summary takes over and duplicating it here would drift.
-->

- geocoding accuracy without GOOGLE_GEOCODING_API_KEY or PHOTON_URL — no spec gates on this yet, so it can't appear in the derived skip summary above; still "not configured here", not a standing limit
