# `signals-e2e` — a one-command end-to-end signoff for Signals DPG

**Status:** design · **Dated:** 2026-09-02 · **Branch:** `feat/signals-e2e-skill`

## 1. The problem

Testing Signals before a release means bringing the local stack up by hand and
walking every flow in a browser. It is slow enough that it mostly does not
happen, so regressions surface in review — or later.

`e2e/` (lifted onto `feature` in the preceding commit) already solves part of
this: 16 API journeys, 7 UI specs, and a route-traceability gate. What it
cannot do is run unattended against a stack nobody started, assert the emails
and the ranked search feed, clean up after itself, or answer "is the U18 flow
still fine?" without running everything.

This design adds a skill that closes those gaps and produces a signoff a human
can read.

**Goal.** `/signals-e2e` brings the stack up, exercises Signals end to end, and
reports what works, what does not, and what a human still has to look at.
`/signals-e2e u18` does the same for one flow.

**Non-goal.** Replacing `e2e/`. The Playwright suite is the engine; this skill
is the orchestration, the missing oracles, and the report around it.

## 2. What exists, and why so much of it is dormant

The lifted suite is black-box by design: it runs against an already-running
target and never starts, migrates, or seeds anything. Its `config/local.json`
declares six optional capabilities and leaves **every one of them off**:

| Capability | Value today | What skips because of it |
|---|---|---|
| `notificationStubUrl` | `null` | every email and SMS assertion |
| `faultInjection` | `false` | discover native fallback, resilience guards |
| `db.url` | `null` | all row-level assertions (retire PII scrub, jitter, ledger rows) |
| `deterministicPiiKey` | `false` | exact PII-location-jitter assertions |
| `auth.serviceApiKey` / `actingOrgId` | `null` | the whole integrator surface |
| `peer.apiBaseUrl` | `null` | inter-instance / peer auth |

The capability machinery is sound — `capabilities.ts` gates each test and
reports skipped-with-reason rather than passing. The tests are simply not
being asked to run. **`notificationStub` is a declared capability with
`REASONS` copy and no implementation behind it.**

So the largest single win here is not new test cases. It is *turning the
existing suite on*, by supplying the three things the config is asking for.

Measured on `feature`, not estimated: **33/53 operations (62%)**, and error-code
coverage **9/89 (~10%)** per `docs/testing/e2e-coverage-backlog.md`.

## 3. Architecture

```
.claude/skills/signals-e2e/
├── SKILL.md              orchestrator: ground rules, dot matrix, alias table,
│                         phase order, the ⚑ gotcha table, suite index
├── coverage.md           the manifest: suite → cases → code covered,
│                         plus the explicit human-only list
├── lib/
│   ├── stack-up.sh       delegates to /run-signals-dpg, adds e2e-only inline
│   │                     env, starts the stubs, writes the reuse marker
│   ├── capabilities.sh   flips config/local.json's capabilities on for the run
│   ├── seed.sh           fixture recipes (accounts, orgs, API keys), ledgered
│   ├── cleanup.sh        tag + ledger + snapshot-diff teardown
│   ├── notify-sink.mjs   notification-service stand-in (email + SMS)
│   ├── search-stub.mjs   signals-search /v1/search + envelope recorder
│   ├── search-indexer.mjs  Redis ingest-stream → item_search
│   └── report.mjs        the five-section signoff
└── references/
    ├── suite-NN-*.md     one per suite, read just-in-time
    └── emails.md         35 email + 5 SMS cases: trigger → case → assertions
```

New Playwright specs land in `e2e/tests/`, using the existing fixtures. The
skill never forks the suite.

### 3.1 `notify-sink.mjs` — the email and SMS oracle

Signals renders the **complete** email (subject, HTML, resolved CTA href) and
POSTs it to `<NOTIFICATION_SERVICE_ENDPOINT>/notify`. The sink is therefore a
full oracle, not a template inspector. `local-mail-sink/sink.mjs` is the
starting point; this extends it.

- `POST /notify` — captures `{channel, template_id, to, priority, variables,
  dedupe_id}`. Email `variables` carry the rendered `subject`/`html` plus
  `attachments`; SMS carries the DLT `template_id` and `variables`.
- `GET /providers` — so a probe does not 500.
- `GET /_e2e/mail?to=&subject=&channel=&since=` — assertions are one request.
- `POST /_e2e/reset`, `POST /_e2e/fail-next` — the latter forces a send failure,
  the only way to reach `502 SUPPORT_SEND_FAILED` and to prove the
  best-effort paths never turn a recorded consent into a 500.

**Resolving a captured mail back to its case.** Every email ships as
`template_id: 'basic_email'`, so the wire cannot identify which of the 35 cases
it was. The helper instead loads the same layered `messages.properties` the API
loads, turns the case's `subject` template into a regex (`{{token}}` → `.+?`),
and matches on (recipient, subject-regex). One line per assertion, and it
breaks loudly if copy changes without the manifest.

**Three global invariants over every captured message**, which catch copy drift
across all 35 cases at once:

1. no unsubstituted `{{` survives,
2. no `__SUPPORT_EMAIL__` survives,
3. every CTA href is absolute and on the expected per-domain origin.

SMS semantics: a case whose `templateId` is empty (not yet DLT-approved) is a
**no-op skip, not a failure** — the sink asserts nothing was posted, which is
the correct behaviour.

Sets `notificationStubUrl`, enabling the `notificationStub` capability.

### 3.2 `search-stub.mjs` — the ranked feed

`signals_search_client.ts:8` still says *"signals-search cannot be run locally
— every test mocks this module or its fetch call."* **That comment is now out
of date** (see the drift audit §2.1): as of #625 / `ee7e498d`,
`local-setup/docker-compose.yml` has a `search` profile running
`signals-search-api` on :3100, the ingestion worker, and a TEI embedding server
with `BAAI/bge-m3` baked in.

So the stub is a **choice with reasons**, not a workaround, and both modes are
supported:

- **Stub (default).** The real profile's images are `platform: linux/amd64` and
  the embedder wants 3–8 GB for a ~2.3 GB ONNX model. On an 8 GB arm64 host
  that runs under emulation and thrashes. The stub costs nothing, and it keeps
  two things the real service cannot easily provide: the fault-injection modes
  and the request-envelope recorder.
- **Real (opt-in, `realSearch` capability).** `--profile search` for a fidelity
  run on a machine that can host it. Reported in the signoff as which mode ran,
  because relevance *quality* is only meaningful under the real service.

The contract is a plain `POST /v1/search` behind `SIGNALS_SEARCH_URL` +
`x-api-key`, with a fully specified Beckn envelope in and full item rows out.

- Parses the real envelope, queries local Postgres (`item_search` joined to
  `items`, live-only), honours `in`/`contains_any` filter clauses, the single
  `s_dwithin` spatial clause, `textSearch`, and pagination. Returns the full
  item-row shape with a **deterministic** `score`, so ranking order is
  assertable rather than random.
- Records every inbound envelope to `envelopes.jsonl`. This is the part the real
  service cannot give us. The client's own comment warns that a single-value
  selection on an array facet must emit `contains_any`, never `in`, or the query
  silently returns zero rows — we assert that on the envelope directly.
- `POST /_e2e/mode` = `ok` | `down` | `slow` | `anchor-not-found`, making three
  otherwise unreachable paths deterministic: the native fallback with
  `meta.source = native_fallback` and `degraded = true`, the 5 s timeout, and
  the discover anchor-retry on `ANCHOR_NOT_FOUND`.

Enables `faultInjection`, which backlog §2.1 #6 explicitly asks for.

### 3.3 `search-indexer.mjs` — without it, half the guards pass while broken

`XREAD BLOCK` on the ingest stream; on `upsert` writes an `item_search` row
(embedding `NULL`, `geo` from `item_locations`, `lifecycle_status` and
`source_updated_at` from `items`); on `delete` removes it.

This matters because when `item_search` is empty the API **silently falls back**
to `items.item_locations`. A lifecycle transition that publishes no event would
pass every assertion. With the indexer the real bugs become visible: the
publish-after-commit race (signals-search#122), "every transition publishes, not
just retire" (#557), and the indexed-versus-fallback bbox path.
`POST /_e2e/pause` also makes "published but not yet indexed" testable.

### 3.4 The browser half: Playwright for coverage, chrome-devtools for judgement

Two browser mechanisms are available and they are not interchangeable.

**Playwright carries the coverage.** Every UI case becomes a spec in
`e2e/tests/ui/`. The reason is that the expensive part is already built —
`fixtures.ts`, `ui.ts` (`uiLoginAs`, `gotoEn`), `flows.ts`
(`createLiveProfileUser`) — so a new spec is ~30 lines, runs in seconds across
4 workers, and keeps protecting the feature in CI after the session that wrote
it has ended. It is also what makes scoped runs cheap: `--grep u18` is seconds,
where re-walking the flow by hand is not.

Specs run **headed**, so a run is watchable.

**chrome-devtools MCP carries triage and judgement.** When a spec fails, the
skill opens that page live and inspects DOM, console and network rather than
inferring from a trace. And the inherently visual checks — brand skin,
responsive layout — get a live screenshot pass that is reported as needing a
human eye (§8.1), never asserted as correct.

The division is deliberate: a scripted assertion is worth more than a live one
*because* it outlives the conversation, and a live inspection is worth more than
a scripted one *because* it can answer a question nobody wrote down in advance.

### 3.5 What `stack-up.sh` has to reconcile

The suite was written against a different local topology than
`/run-signals-dpg` produces. Known deltas, each of which fails the run before
any assertion if left alone:

- **`uiBaseUrl` is `http://localhost:5173`; `/run-signals-dpg` serves the UI on
  `:3000`.** Every UI spec would fail on connection-refused. Resolve at run time
  by probing both ports rather than hardcoding either, since the skill's own
  notes record that some branches do use Vite's default.
- `auth.serviceApiKey` / `actingOrgId` are `null`; a local
  `network_service` key must be minted (`pnpm db:seed:services:api`) and
  injected, or the whole integrator surface skips.
- `db.url` is `null`; the row-level assertions need the local Postgres URL.
- `otp.mode` is `test-otp`, which requires the API launched with
  `CREATE_TEST_OTP=true` — the skill must assert this rather than assume it,
  because a target without it makes every OTP journey skip silently.

## 4. Coverage model

Sixteen suites. The exhaustive per-case list lives in `coverage.md`; this table
is the contract and the gap assignment.

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

**Post-divergence features.** The suite predates a month of `feature` work, so
the audit's §3 is part of this coverage contract, not a separate backlog. The
highest-value entries, because their defining failure mode is *silence* rather
than an error:

| Feature | Landed | Suite |
|---|---|---|
| Whole notification subsystem — externalised copy + dispatcher (#529), per-domain CTA (#569), lifecycle + onboarding mail (#531/#534), SMS engine (#532/#535) | `23d86c4f`, `43f5b9ce`, `5db2d908`, `fac98753` | mail sweep |
| Item event on **every** lifecycle transition (#557/#564) | `95fe484e` | 10 |
| Shareable profile links + public page (#476), downloadable QR (#567) | `def4fe0c`, `02b092f0` | 11 |
| My Actions per-profile filter & sort, server-enforced (#439) | `43e1677e` | 8 |
| `x-uri` marker + URL validation (#576) | `da9ec9b8` | 4 |
| Config-driven go-live gates (#344) | `309b7892` | 4 |
| Consent scroll-gate (#636), one `/legal` route (#637) | `65b18c39`, `500d4465` | 3 |
| Support attachments + `/support/config` (#551/#552) | `b9a8b5e8` | 12 |
| Self-action guard; viewport clamping; bbox fallback (#503) | `fe5d7abd`, `8da77e48`, `367459b7` | 7 |
| Participant-decrypt projection + contact + locations (#521) | `75f44255` | 13 |
| Brand lockups, sidebar footer, `getRuntimeEnv` settings (#605) | `72185ffe`, `05954e10` | 15 |

**Error codes.** The P0 set from backlog §2.2 is in scope: the U18 fail-closed
family, pair-cap, and the ownership / PII-boundary codes. Each asserted in both
directions — the blocked path returns the exact code *and* the allowed path
still works — because a guard tested only in the deny direction can be fail-open
in the allow direction. The remaining ~60 codes stay on that backlog.

**Dot selection.** The skill asks. Unspecified defaults to a full `blue_dot` run
followed by an `orange_dot` tourist pass: `blue_dot` is the only dot carrying
both `apply` and `connect`, a U18-gated seeker, and a brand skin (`upsdm`), so
it maximises coverage per minute. `config/local.json` already targets
`blue_dot`. Anything a dot cannot reach is a SKIP with its reason.

## 5. Cleanup

`identities.ts` tags rows `is_test` *"so a bulk sweep can remove them"* — the
sweep was never written. It is written here, and constrained by a standing
project rule: **never run type-wide `DELETE` cleanup against the local compose
DB.** Nothing keys on `item_type` or network. Three scopes, each covering the
previous one's blind spot:

1. **Tags at creation.** Emails, phones, org slugs and each profile's
   display-name field carry the run tag. Reaches most rows.
2. **A created-ledger**, because tags cannot reach everything. Every created
   primary key is appended to `run/<tag>/created.jsonl` as `{table, pk}` and
   replayed in reverse at teardown. This catches what a tag cannot: a
   `consent_record` row has no name field, and an `item_actions` row written by
   the counterparty during a bulk flow was never ours to name.
3. **A pre-run per-table row-count snapshot, diffed after teardown.** The only
   check that cannot be fooled by something we forgot to both tag *and* ledger.

Scope: `user`, better-auth `session`/`account`/`verification`, `items`,
`item_locations`, `item_search`, `item_actions`, `action_events`,
`consent_record`, `item_metrics`, the minor/guardian rows, `organization` +
members + API keys; Redis item/geo caches, OTP keys, support rate-limit
counters, and this run's ingest-stream entries; on disk the sink mail dir,
envelopes, and screenshots.

**Cleanup completeness is itself an asserted item.** Non-zero residue is a FAIL
with the exact table and count, never a quiet pass. A shell `trap` runs teardown
on failure or interrupt; preflight detects orphan tags from a killed earlier run
and offers to clear them; `/signals-e2e cleanup [tag]` cleans a prior run on
demand.

## 6. Scoped runs

`/signals-e2e u18` runs one flow and signs off on it.

- **An alias table in `SKILL.md`** maps plain English to suites: `u18`/`guardian`
  → 5; `consent`/`legal` → 3; `profile`/`form`/`schema` → 4; `browse`/`search`
  → 6; `map` → 7; `actions`/`connect`/`apply` → 8; `match` → 9;
  `lifecycle`/`retire` → 10; `share`/`public` → 11; `support` → 12;
  `aggregator`/`admin` → 13; `peer` → 14; `emails` → the mail sweep;
  `tourist` → 16; `auth`/`login` → 2.
- **Each suite file declares `requires:` as fixture recipes, not as other
  suites.** Prerequisites are seeded directly through the API in seconds, never
  by replaying earlier UI suites. That is what makes a scoped run fast enough to
  use after a one-line change.
- **Stack reuse.** `stack-up.sh` writes a marker recording the running stack's
  dot, e2e env, and stub versions. On a match, phase 1 is skipped entirely and a
  repeat scoped run starts asserting in seconds.
- **The signoff is scoped and says so.** Same five sections, a header naming
  exactly what ran, and section 4 listing every other suite as *"not run in this
  invocation"*, so a scoped pass can never be misread as a full one.

**The honest limitation, which the report states:** seeding prerequisites means
a scoped run verifies the target flow *given* correctly-shaped inputs. A green
`/signals-e2e u18` proves the U18 flow works; it does not prove that ordinary
signup produces the account shape U18 starts from. Only a full run tests the
seams between suites.

## 7. Phase flow

**Phase −1, once, before any of this is meaningful.** The drift audit
(`docs/testing/e2e-drift-audit-2026-09-02.md` §1) found four defects in the
lifted suite: the `aria-disabled` consent gate, the stale `domainLabelFromKey`
mirror, `uiBaseUrl` on the wrong port, and the unmapped `/support/config`
route. Until those are fixed no UI result from this suite means anything, so
they are fixed and the suite is run green against a live stack **before** any
new coverage is written.

| Phase | What | Time |
|---|---|---|
| 0 | Preflight: docker, node 24, ports, orphan tags | ~30 s |
| 1 | `stack-up.sh` → `/run-signals-dpg` + 3 stubs + capability flip + `npm run coverage` | ~90 s |
| 2 | `e2e/run-e2e.sh` API tier — the deterministic engine, no model in the loop | ~2 min |
| 3 | UI tier + the new specs, headed so the run is watchable | 20–30 min |
| 4 | Mail sweep: all 35 + 5 cases, the 3 global invariants, any case never triggered | ~1 min |
| 5 | Report, teardown, residue diff, `git status --porcelain` clean | ~1 min |
| 6 | `orange_dot` restart + tourist pass | ~5 min |

Pushing everything scriptable into phase 2 is what keeps this quick: the model
drives only the browser, where judgement earns its cost. Triage of a *failing*
UI spec is the one place the skill reaches for chrome-devtools directly.

## 8. The report

Five sections, and the last two are why this exists:

1. **Working** — PASS, grouped by suite.
2. **Not working** — FAIL, each with expected versus actual, the repro, and the
   screenshot or trace path.
3. **Known / expected** — documented behaviours that look like bugs and are not:
   map count below list total (un-geocoded rows plus viewport scope), `x-uri`
   through a `$ref` unenforced, the peer-fetch HMAC 401. Asserted as *known* so
   they never pollute section 2.
4. **Not tested — needs a human**, each with its reason. Computed from the run's
   SKIPs plus the manifest's `human-only` entries, never hand-written.
5. **Coverage drift** — whatever `npm run coverage` found unmapped.

Non-zero exit if and only if section 2 is non-empty.

### 8.1 What will always be in section 4

Stated up front so the skill's promise is not overread. It is *"no human
testing required to know whether the features work"*, not *"nothing is left for
a human to look at"*:

- visual and aesthetic judgement — brand skin correctness, whether a responsive
  layout *looks* right, accessibility beyond structural checks
- real Keycloak / OIDC login (config-gated; `authProvider: "auto"`)
- true multi-instance inter-instance browse (needs a second API)
- geocoding accuracy when neither `GOOGLE_GEOCODING_API_KEY` nor `PHOTON_URL`
  is set
- real DigiLocker and Dhiway wallet imports
- real SMS delivery — the DLT template ids ship empty by design
- email deliverability and client-side rendering

## 9. Staying current

`coverage.md` is the contract; two mechanisms enforce it, one inherited and one
new.

**Inherited:** `e2e/scripts/check-coverage.mjs` already fails when a route ships
without a journey, and `.claude/rules/e2e-coverage.md` already tells feature
authors what to do per kind of change. That rule loads automatically on
`apps/api/src/routes/**` and `apps/ui/src/pages/**`. Nothing to rebuild.

**New:** the route table is not the whole product. `coverage-check` is extended
to also enumerate UI routes from `app.tsx`, email cases from `email_cases.ts`,
SMS cases from `sms.default.properties`, `x-*` schema markers and
`go_live_required` tokens from each `network.json`, and i18n namespaces from
`en.json` — and to diff those against `coverage.md`. A new route, email case, or
schema marker with no named case fails the check **by name**.

## 10. Ground rules

Carried from the aggregator skill, because they are right:

- **Never edit a tracked file to make a run work.** `.env` and `apps/ui/.env` are
  gitignored and are `/run-signals-dpg`'s business; e2e-only vars go in inline.
  The capability flip to `config/local.json` is the one exception and is
  reverted at teardown — the working tree must end clean.
- **Tag and ledger every seeded row.** A half-cleaned DB makes the *next* run
  lie.
- **A flow that could not run is a SKIP with its reason, never a PASS.**
- **One restart is a fix; a retry loop is a lie.** Anything else needing a retry
  is a finding.

## 11. Risks

- **Divergence from `functional-testing-automation`.** The lift is a copy;
  sanketika-1009's branch still holds the Keycloak half plus ~4,500 lines of
  unit tests. If they resume, the two `e2e/` trees must be reconciled. Mitigation
  is to keep skill-owned code in `.claude/skills/signals-e2e/` and confine
  changes inside `e2e/` to additive specs and config.
- **Stub fidelity.** `search-stub.mjs` implements the contract, not the real
  ranking. It proves the API builds correct envelopes and consumes responses
  correctly; it cannot prove real relevance quality. That belongs in section 4.
- **UI spec maintenance.** Broad UI coverage is the largest new artifact and the
  most likely to rot. The extended coverage check is the defence; it is a floor,
  not a guarantee.
- **Runtime.** A full pass is 30–45 minutes. If that discourages use, the
  scoped-run path is the intended answer, not trimming the full run.
