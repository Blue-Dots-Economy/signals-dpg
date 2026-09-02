---
name: signals-e2e
description: Verify (or reuse) an already-running local Signals DPG stack — bring one up first with the run-signals-dpg skill if none is live — run the black-box Playwright suite end to end, and produce a five-section signoff a human can read. The local oracles (email/SMS sink, search stub, item_search indexer) are built and unit-tested but not yet wired into any spec today; that wiring is the follow-on coverage plan, not something this run currently exercises. Use when asked to end-to-end test Signals, run a full e2e, test the U18/guardian flow, sign off on Signals before a release, or "run /signals-e2e".
---

# signals-e2e — one command to test Signals and sign off on it

**Prerequisite: the stack must already be up.** `lib/run.sh` (via
`lib/stack-up.sh`) only *verifies and waits* for a live target on `:2742` —
it does not start anything, and fails after ~40s if nothing answers. Bring
the stack up first with the `run-signals-dpg` skill (`/run-signals-dpg [dot]`),
*then* invoke this one.

`/signals-e2e [dot] [alias]` runs the suite; `/signals-e2e cleanup [tag]` tears
down a prior or orphaned run on demand. `dot` defaults to `blue_dot`; an
`alias` scopes the run to one flow (§3 below).

This skill is an **orchestrator**. It does not reimplement anything — it wires
together the scripts in `lib/` and hands the actual work to `lib/run.sh`. Every
per-suite detail (fixture recipes, case lists, what's parked for the follow-on
plan) lives in `references/`, read **just-in-time** per suite, so the last
suite of a long run gets the same attention as the first — this file is never
the place to add a new case.

## 1. Ground rules (spec §10 — carried from the aggregator skill because they're right)

- **Never edit a tracked file to make a run work.** `.env` and `apps/ui/.env`
  are gitignored and are `/run-signals-dpg`'s business; e2e-only vars go in as
  inline `E2E_*` env, never into `e2e/config/local.json`. A run leaves the
  working tree clean — verify with `git status --porcelain` after every
  invocation.
- **Tag and ledger every seeded row.** A half-cleaned DB makes the *next* run
  lie — see `lib/cleanup.sh` and `e2e/src/ledger.ts`.
- **A flow that could not run is a SKIP with its reason, never a PASS.** A bare
  `test.skip` with no reason is treated as a defect (report section 2), not a
  documented gap.
- **One restart is a fix; a retry loop is a lie.** Anything else needing a
  retry is a finding, not a pass.

## 2. The dot matrix

| Dot | Domains | What it uniquely reaches |
|---|---|---|
| `blue_dot` (default) | seeker, provider | both `apply` and `connect` actions, a U18-gated seeker, and a brand skin (`upsdm`) — the single dot that maximises coverage per minute |
| `orange_dot` | tourist | suite 16 only — run this as a *second* pass after `blue_dot`, never instead of it |

Unspecified defaults to a full `blue_dot` run. A dot that can't reach a given
suite reports it as a SKIP with its reason, never a silent pass.

## 3. The alias table (spec §6)

| Alias | Suite | Existing coverage today |
|---|---|---|
| `auth`, `login` | 2 | Journey A, B, `journey-auth.ui.spec.ts` |
| `consent`, `legal` | 3 | Journey K |
| `profile`, `form`, `schema` | 4 | Journey A, P — UI half parked for Plan 2 |
| `u18`, `guardian` | 5 | Journey C, S — gaps parked for Plan 2 |
| `browse`, `search` | 6 | Journey H |
| `map` | 7 | none yet — parked for Plan 2 |
| `actions`, `connect`, `apply` | 8 | Journey D, E, F, R |
| `match` | 9 | none yet — parked for Plan 2 |
| `lifecycle`, `retire` | 10 | Journey O |
| `share`, `public` | 11 | none yet — parked for Plan 2 |
| `support` | 12 | `journey-l-support.spec.ts` (API + UI) |
| `aggregator`, `admin` | 13 | Journey I, J, V — **SKIPs without a hand-minted service key**: this suite needs `serviceApiKey` seeded and nothing generates one (`seed.sh` to mint it was never built), so today it reports as a documented SKIP, not a pass |
| `peer` | 14 | none yet — parked for Plan 2 |
| `emails` | — (cross-cutting mail sweep) | oracle built (`notify.ts`/`notify-sink.mjs`), no spec wires it yet — parked for Plan 2 |
| `tourist` | 16 | none yet — parked for Plan 2 |
| *(omit alias)* | full run | every spec in `e2e/tests/` |

**An alias not in this table is refused** — `lib/run.sh` prints this exact
table and exits 2. It never falls back to running everything: a scoped run
that quietly becomes a full one wastes half an hour, and a full run that
quietly becomes scoped is worse, because it signs off on work it never
touched. A scoped report's section 4 always names every *other* suite as "not
run in this invocation", so a scoped pass can never be misread as a full one.

Each suite's `references/suite-NN-*.md` declares its fixture recipe under
`requires:` — prerequisites are seeded directly through the API in seconds,
never by replaying an earlier suite. That is what makes a scoped run fast
enough to use after a one-line change. The honest limit: a scoped run proves
its flow works *given* correctly-shaped inputs; only a full run tests the
seams between suites.

## 4. Phase order (spec §7)

| Phase | What | Owner |
|---|---|---|
| −1 (once) | Fix the drift audit's static defects, run green against a live stack, *before* trusting any result from this suite | done — Task 3 |
| −0.5 (every invocation) | **Bring the stack up if it isn't already** — `/run-signals-dpg [dot]` | you, the caller, first |
| 0 | Preflight: docker, node ≥24, ports, the notification-env triple-check | `lib/run.sh` |
| 1 | Reuse the already-live stack, or fail: `lib/stack-up.sh` only *verifies* a target on `:2742` and waits up to 40s for it — it never starts one itself. Then start the 3 stubs, snapshot the DB. | `lib/run.sh` |
| 2 | API tier — deterministic, no browser | `npm run e2e:api` via `lib/run.sh` |
| 3 | UI tier — headed, so the run is watchable | `npm run e2e:ui -- --headed` via `lib/run.sh` |
| 4 | Mail sweep (parked for Plan 2 — no spec wires the sink yet) | — |
| 5 | Report, teardown, residue diff, `git status --porcelain` clean | `lib/report.mjs` + `lib/cleanup.sh` |
| 6 | `orange_dot` restart + tourist pass | re-invoke with `dot=orange_dot alias=tourist` |

If a UI spec fails, open it live with the chrome-devtools MCP tools and
inspect DOM/console/network rather than inferring from a trace — that triage
step is the one place this skill reaches for a live browser directly instead
of Playwright.

## 5. ⚑ Gotchas — each has cost real time on this plan

| ⚑ | Trap | Why it bites |
|---|---|---|
| `aria-disabled` consent gate | Playwright doesn't wait on `aria-disabled`; a plain `.click()` no-ops. Use `passConsentGate(page)` (`e2e/src/ui.ts`), which waits on the "That's everything" hint text instead. |
| Blank-UI env pair | `VITE_NETWORK_ID` / `VITE_API_URL` must agree across root `.env` **and** `apps/ui/.env` — root wins. A mismatch renders a blank UI with no console error. |
| UI port ambiguity | On this machine `:3000` is the **aggregator** portal (Next.js), not Signals (`:5173`). `stack-up.sh` probes both and verifies identity via the `/src/main.tsx` module-script marker — a 200 alone is not enough. |
| Array-facet `contains_any` | A single-value selection on an array-valued facet **must** emit `contains_any` (jsonb `?|`), never `in` — `in` extracts the field as text and silently returns zero rows. Demonstrated live in Task 6. |
| Map count < list total | *Expected*, not a bug: un-geocoded migrated rows plus the map's viewport scope. **Not currently asserted anywhere** — suite 7 (map) has no spec at all yet (parked for Plan 2), and zero specs in this suite use `@known` today. When suite 7 is written, this behaviour must be annotated `@known`, not left to fail as a surprise. |
| `x-uri` through a `$ref` | `applyUriPatterns` walks `properties`/`items` but not `$defs`/`definitions` — a field marked through a shared `$ref` gets no pattern and its validation silently does nothing. Not asserted by any spec today either. |
| Peer-fetch HMAC 401 | Inter-instance item fetch can 401 because `lifecycle_filter` is stripped by Zod before the HMAC re-check. Needs a 2nd instance to reproduce — suite 14, parked. |
| `@known` has no validation | A test can be silenced out of the exit code (though not out of section 3's rendered text) purely by attaching a `@known` annotation, with nothing checking it references a real tracked issue. Treat it like an unchecked eslint-disable — read section 3, don't just trust a green exit code. |
| `kill -INT` on a `&`-backgrounded run | `run.sh` traps INT and TERM and tears down promptly either way — *except* when it was itself started with a trailing `&` from a non-interactive, job-control-off shell (`nohup bash lib/run.sh ... &`, common from automation). Bash then sets SIGINT to ignore for that process **before it even starts**, and no `trap` inside the script can override that (a documented bash/POSIX rule, verified empirically, not a bug in this script). Plain `kill <pid>` (SIGTERM, the default) always works regardless of how it was launched; so does Ctrl-C at a real terminal. Prefer either over `kill -INT` for a backgrounded invocation. |

## 6. Running it

**Before any of this**: the stack must already be live. `run.sh`
(`stack-up.sh`) verifies and waits — it does not bring anything up — so run
`/run-signals-dpg [dot]` first, once, for whichever dot you're about to test.
Also confirm the target's `.env` has `NOTIFICATION_SERVICE_ENDPOINT` pointed
at the notify-sink (`http://localhost:4545`) and, if you need the search
stub's envelope recorder to see traffic, `SIGNALS_SEARCH_URL` pointed at it
(`http://localhost:4546`) — `run.sh` checks both and fails loudly rather than
running blind if the notification one is missing or points elsewhere.

```bash
# full run, blue_dot
bash .claude/skills/signals-e2e/lib/run.sh

# scoped to one flow
bash .claude/skills/signals-e2e/lib/run.sh blue_dot u18

# tourist pass on the other dot
bash .claude/skills/signals-e2e/lib/run.sh orange_dot tourist

# clean up a prior or orphaned run on demand
bash .claude/skills/signals-e2e/lib/run.sh cleanup <run-id>
```

`SIGNALS_REPO=/path/to/Signals-DPG` if the running stack lives in a different
checkout than this worktree (this worktree has no root `.env`/`node_modules`
of its own — see `lib/stack-up.sh`'s header comment).

The report (`e2e/run/<run-id>/report.md`) has five sections in this fixed
order: **1. Working**, **2. Not working** (exit code is non-zero iff this is
non-empty), **3. Known / expected**, **4. Not tested — needs a human**
(computed, never hand-written), **5. Coverage drift**.

## 7. Suite index (read just-in-time — not inlined here)

| # | Suite | Reference |
|---|---|---|
| 0 | Preflight & stack-up | `references/suite-00-preflight.md` |
| 1 | Config, schema, served domains | `references/suite-01-config.md` |
| 2 | Auth & account | `references/suite-02-auth.md` |
| 3 | User consent + legal | `references/suite-03-consent-legal.md` |
| 4 | Profile creation (schema-driven) | `references/suite-04-profile.md` (stub) |
| 5 | U18 / guardian | `references/suite-05-u18-guardian.md` (stub) |
| 6 | Browse / list | `references/suite-06-browse.md` (stub) |
| 7 | Map | `references/suite-07-map.md` (stub) |
| 8 | Actions | `references/suite-08-actions.md` (stub) |
| 9 | Match score | `references/suite-09-match-score.md` (stub) |
| 10 | Lifecycle | `references/suite-10-lifecycle.md` (stub) |
| 11 | Public / shareable profile | `references/suite-11-public-profile.md` (stub) |
| 12 | Contact support | `references/suite-12-support.md` |
| 13 | Integrator surface | `references/suite-13-integrator.md` |
| 14 | Inter-instance / peer | `references/suite-14-peer.md` (stub) |
| 15 | Cross-cutting UI | `references/suite-15-cross-cutting-ui.md` (stub) |
| 16 | Tourist (`orange_dot`) | `references/suite-16-tourist.md` (stub) |

Suites 0, 1, 2, 3, 12 and 13 have a full reference (fixture recipe + case
list) — the ones the existing lifted journeys plus this plan's stubs/indexer
already cover. The rest are short stubs naming the follow-on coverage plan
(`docs/testing/e2e-drift-audit-2026-09-02.md` §3, `coverage.md`'s "Gap this
design closes" column) so the index above is never a dead link — open the stub
to see exactly what's parked and why, rather than assuming "not built yet"
means "not thought about".

`coverage.md` (this directory) is the coverage **contract**, enforced by
`e2e/scripts/check-coverage.mjs`. It is not duplicated here.
