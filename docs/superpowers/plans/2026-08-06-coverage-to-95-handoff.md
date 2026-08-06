# Coverage → 95% — handoff prompt for a fresh session

**Created:** 2026-08-06
**Status:** TARGET MET on every in-scope package except apps/ui. api 97.89%, schemas 99.82%, config 98.15%, auth 96.99%; 3,018 tests passing workspace-wide. apps/ui remains at 41.76% and is the only outstanding work.

This file is a **self-contained prompt**. Paste the "PROMPT STARTS HERE" section
into a fresh Claude Code session (or hand it to an async agent) and it has
everything needed to continue without re-deriving the situation.

Per this repo's own convention (root `CLAUDE.md`): treat this document as a
**point-in-time record, not living documentation**. The numbers below were true
at creation. Re-measure before trusting them — if this file and the code
disagree, the code wins.

---

## PROMPT STARTS HERE

You are continuing a code-coverage push in `/Users/mahesh/Code/Blue-Dots/signals-dpg`
(pnpm + Turborepo monorepo, Fastify API + React UI). The goal is to raise test
coverage toward **>95%** as reported by SonarCloud, continuing work already
started. Read `CLAUDE.md` and `AGENTS.md` first — they are the canonical guides.

### Decisions the user has already made — do not re-litigate these

1. **SonarCloud stays on the main-only plan.** No upgrade for branch/PR analysis.
   Consequence: coverage **cannot gate a PR**, and the dashboard only moves when
   code reaches `main`. **Local lcov is the source of truth** for reporting
   progress; quote measured local numbers, not the dashboard.
2. **Integration tests ARE wired into CI** and their lcov is reported alongside
   the unit lcov (`apps/api/coverage-integration/lcov.info`). Done — see the
   `sonar` job in `ci.yaml`. Don't remove it; it reclaims ~25 suites' worth of
   already-written coverage.
3. **Finish `apps/api` to ~95% before starting `apps/ui`.** UI is the bigger gap
   but far slower per test; API's mocking patterns are proven.
4. **Genuinely untestable code is excluded from the denominator**, not tested:
   `apps/api/src/server.ts` (bootstrap) and `apps/api/src/scripts/**` (one-off
   CLI commands). Applied in BOTH `apps/api/vitest.config.ts` and
   `sonar-project.properties` — **keep those two lists in sync** or the local
   number and the SonarCloud number will disagree. Adding a further exclusion is
   allowed but propose it with line counts first; don't quietly widen it to make
   a number look better.

### Target and current state

Baseline measured on the `feature` branch (2026-08-06). **Re-measure before
starting** — see "How to measure" below.

| Package | Lines | Notes |
|---|---|---|
| `apps/api` | **97.89%** (was 55.52%) | 1530 tests; denominator 3751 after exclusions |
| `packages/schemas` | **99.82%** (was 64.75% honest) | 636 tests |
| `packages/config` | **98.15%** (was 82.08%) | 140 tests |
| `packages/auth` | **96.99%** (was 23.60% honest) | 155 tests |
| `apps/ui` | 41.76% | **the only remaining gap** — untouched by design (user chose API-first) |
| `packages/database`, `notification`, `match_score` | n/a | **OUT OF SCOPE — the user explicitly excluded these.** Excluded in `sonar-project.properties`. |

**Beware inflated historical numbers.** Earlier in this work `auth` was reported
as 96.49% and `schemas` as "100%". Both were measurement artifacts: without an
explicit `coverage.include`, vitest's v8 provider only reports files a test
actually LOADED, so untested modules vanish from the denominator (and from lcov,
where SonarCloud scores them 0%). All packages now pin `include`, so the numbers
above are whole-source. If you add a package, add `include` too.

`apps/ui/src/components/ui/**` (generated shadcn component kit) is deliberately
excluded from the coverage requirement via `sonar.coverage.exclusions` — don't
chase coverage there.

### Work already landed (three stacked PRs, all against `feature`)

Check their merge status first with `gh pr list --base feature`; the stacking
means a merge order matters.

1. **PR #485** — `chore/dead-code-cleanup`: verified dead-code removal. Ran
   `knip`; most of its 15-file / 24-dep output was **false positives** (workspace
   deps consumed via `@dpg/*` path aliases rather than node_modules resolution,
   and the `apps/ui/src/tourist/*` second Vite entry point knip can't see).
   Only 5 files + 14 deps were verified-dead and removed.
   **If you re-run knip, do NOT trust its raw output** — verify each candidate by
   grep for the actual import specifier before deleting. Specifically left alone
   on purpose: the 141 unused-export / 76 unused-type findings (too noisy —
   many are route handlers imported only by tests, and shadcn kit exports),
   all `workspace:*` deps, and the `turbo` devDependency (CLI-invoked).
2. **PR #486** — `chore/coverage-sonar-infra`: the coverage plumbing. This is the
   **base branch** the test PRs stack on.
3. **PR #487** — `test/coverage-api-batch-1`: batches 1-2, 243 tests, based on #486.
   NOTE: a PR targeting `chore/coverage-sonar-infra` gets **zero CI checks** — `ci.yaml`
   triggers `pull_request` only on `[develop, main, feature]`. GitHub auto-retargets
   the base to `feature` when #486 merges, and CI runs then. Do not merge a stacked
   PR while it shows `Checks 0`.

### Critical context you would otherwise waste time rediscovering

- **SonarCloud had never successfully analyzed this repo.** The org is
  `blue-dots-economy`, project key `Blue-Dots-Economy_signals-dpg`. A `SONAR_TOKEN`
  repo secret existed but no CI step ever called the scanner; the single analysis
  attempt on record failed in under a second. PR #486 adds
  `sonar-project.properties` + a `sonar` job in `.github/workflows/ci.yaml`.
  The `sonar` job is now **verified working** — it passed on PR #486 in 2m50s and
  the "SonarCloud Code Analysis" check passed. Dashboard:
  https://sonarcloud.io/project/overview?id=Blue-Dots-Economy_signals-dpg
- **THE key SonarCloud constraint: the org's plan analyses the MAIN branch only.**
  Branch and PR analysis is a paid feature. The PR-scoped dashboard explicitly
  reports *"Not analyzed — your current plan does not include branch analysis"*,
  and the project overview reports *`"main" branch has not been analyzed yet`*.
  Consequences you must plan around:
  - **Coverage numbers only appear on SonarCloud once code reaches `main`.** A PR
    into `develop` or `feature` will never move the dashboard.
  - CI originally had **no push trigger for `main`** (`push: [develop, feature]`),
    so the default branch was never scanned at all. PR #486 adds `main` to the
    push triggers — without that fix, no amount of added coverage would ever
    surface as a SonarCloud number.
  - Until something lands on `main`, **validate coverage locally** with the
    commands below; treat the local lcov numbers as the source of truth and the
    SonarCloud dashboard as a lagging indicator.
  - Worth raising with the user: whether to upgrade the plan for branch analysis,
    or accept main-only reporting.
- **The single biggest reason coverage looks low:** a large amount of API logic is
  exercised *only* by `*.integration.test.ts` files, which `apps/api/vitest.config.ts`
  **excludes** from the default run (they need live Postgres + Redis). So the code
  has tests that count for nothing. The highest-leverage work is writing fast,
  dependency-mocked **unit** tests that cover those same paths. Do not delete or
  modify the integration tests.
- **`@vitest/coverage-v8` was already in the lockfile but wired into nothing.**
  PR #486 wires it into api, ui, auth, config, schemas.
- **Vitest hangs on exit for ~120s** in this environment ("Tests closed
  successfully but something prevents Vite server from exiting"). Tests
  themselves finish in seconds. **Run every vitest command with
  `run_in_background: true`** and read the output file, or you will burn a
  2-minute timeout on every single verification.
- **Parallelise with the `Workflow` tool, NOT the `Agent` tool.** The bare `Agent`
  tool failed **8 times out of 8** across three attempts (batches of 4, 2 and 1,
  with progressively tighter prompts) — all "Connection closed mid-response" or
  600s stalls, and one agent `git stash`-ed the main thread's uncommitted work.
  Switching to `Workflow` with the same task decomposition succeeded **5/5 with
  zero errors in ~3 minutes**. Use it. The working recipe:
  - One agent per module, each owning **exactly one disjoint test file path** so
    nothing contends in the shared tree.
  - Forbid, explicitly and per-agent: any `git` command, `pnpm install`, editing
    `package.json`/`vitest.config.ts`/tsconfig or any production source, and
    `--coverage` (concurrent coverage writes to the shared `coverage/` dir
    collide).
  - Tell each agent to run vitest **in the background** writing to its own
    `/tmp/<key>.log`, then poll that log — a foreground run looks like a stall
    (see the exit-hang note above) and gets the agent killed.
  - Use a `schema` so each agent returns `{testFile, testCount, allPassing,
    summaryLine, skipped}`; the `skipped` field is where the genuinely useful
    findings surface.
  - The reusable script is at `.../workflows/scripts/coverage-batch-2-*.js` in the
    session dir; the pattern is worth copying verbatim.
- **Always run `pnpm --filter api exec tsc --noEmit` after adding tests.** Tests
  passing does NOT mean the file typechecks, and CI's `typecheck-api` job compiles
  test files too. Batch 1 shipped 8 type errors this way. The specific trap:
  `vi.fn(() => ...)` infers a **zero-argument** signature, so `mock.calls[0][0]`
  fails to typecheck and spreading through a `vi.mock` factory errors — declare
  the mock's parameters (`vi.fn((_row: Record<string, unknown>) => ...)`).

### How to measure

```bash
# Per package (ALWAYS run in background — see the hang note above)
pnpm --filter api exec vitest run --coverage.enabled --coverage.reporter=text-summary
pnpm --filter ui  exec vitest run --coverage.enabled --coverage.reporter=text-summary

# Per-file ranking, worst first — this is how to pick the next targets
pnpm --filter api exec vitest run --coverage.enabled --coverage.reporter=json-summary
node -e "
const d=require('./apps/api/coverage/coverage-summary.json');
Object.entries(d).filter(([k])=>k!=='total')
 .map(([f,s])=>({f:f.replace(process.cwd()+'/',''),p:s.lines.pct,n:s.lines.total}))
 .sort((a,b)=>a.p-b.p).filter(r=>r.p<50)
 .forEach(r=>console.log(r.p.toFixed(1).padStart(6),String(r.n).padStart(5),r.f));
"
```

### The established test pattern — follow it

Read `apps/api/src/routes/v1/consent/__tests__/u18_status.test.ts` (the canonical
route-handler example) and any file added in PR #487. The shape:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock handles, so vi.mock factories can close over them.
const { someDep } = vi.hoisted(() => ({ someDep: vi.fn() }));
vi.mock('@/some/module', () => ({ someDep: (...a: unknown[]) => someDep(...a) }));
vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

// Import the NAMED exported handler AFTER the mocks.
import { some_handler } from '../some_route';

// Fake reply with chainable code()/send() capturing statusCode/body.
function makeReply() {
  return {
    statusCode: 0, body: undefined as unknown,
    code(c: number) { this.statusCode = c; return this; },
    send(b: unknown) { this.body = b; return this; },
  };
}
```

For drizzle db calls, fake the builder chain (`select→from→where→limit`); see
`apps/api/src/services/__tests__/minor_guardian_repo.test.ts` (added in #487) for
a queue-based fake that handles chains ending at either `.where()` or `.limit()`,
and `apps/api/src/middleware/__tests__/acting_org.test.ts` for an older variant.

**Two traps in that drizzle fake, both of which cost time here** — see
`apps/api/src/routes/v1/consent/__tests__/consent_status_handlers.test.ts` for
the corrected version:
1. If `.where()` returns a **thenable**, its `then` MUST forward *both* callbacks
   (`then(res, rej)`). Forwarding only `res` makes a rejected query hang the
   `await` until the 5s test timeout instead of surfacing the error — so the
   error-path test fails with a timeout that looks unrelated to the mock.
2. Never simulate a DB failure by monkey-patching the shared row queue
   (`rowQueue.shift = ...`). The override leaks into every subsequent test in the
   file. Use a resettable flag (`dbState.failWith`) cleared in `beforeEach`.

Repo conventions that shape assertions:
- **Routes never throw.** They `return reply.code(N).send({ error, message })`
  with a machine-readable `error` code — assert on those codes.
- PG error codes `23505` (unique) and `23503` (FK) are handled explicitly.
- Files are snake_case; route handler exports are snake_case
  (`create_item_handler`), internal functions camelCase; Zod schemas PascalCase.
- ESM only, strict TS, **no `any`** (use an eslint-disable line where a fake
  request/reply genuinely needs it, as the existing tests do).
- **No `// TODO` comments** — open an issue instead.

### Highest-value remaining targets

**apps/api, packages/schemas, packages/config and packages/auth are DONE** (all
>95%). The stale per-file target list that used to live here has been removed
rather than left to mislead — every file it named is now covered.

`apps/ui` is the only remaining work; see "What is left: apps/ui only" below.
Always re-derive targets with the ranking command in "How to measure" rather
than trusting a list in this file.


### Workflow to follow

1. Branch off the coverage-infra branch (or `feature` once #486 is merged):
   `git checkout -b test/coverage-<area>-batch-N chore/coverage-sonar-infra`
2. Pick a cluster of related low-coverage files from the ranking.
3. Write tests. Run them in background. Fix until green.
4. Re-measure package coverage; record the before/after delta.
5. Run the full package suite to confirm nothing regressed.
6. Commit, push, open a PR against the same base the previous batch used.
   **The repo requires an "In Plain Terms" section in every PR description** — a
   short jargon-free explanation for a non-expert teammate, alongside
   Summary / Test plan. This is a hard rule from `CLAUDE.md`.
7. Repeat. Report honest deltas — do not claim a coverage number you did not
   measure.

### What is left: apps/ui only

`apps/ui` is at **41.76%** and is the whole remaining job (~3,300 uncovered
lines). It was deliberately deferred — the user chose to finish the API first.

Start by generating the per-file ranking (see "How to measure"), then reuse the
Workflow recipe above: one agent per cluster, one disjoint test file each. What
differs from the API work:

- UI tests use `@testing-library/react` + `happy-dom`. Read
  `apps/ui/src/test/setup.ts` and a couple of existing `src/**/*.test.tsx` first.
- They are **much slower** — the full UI coverage run took ~17 minutes once.
  Budget for that and keep every run backgrounded.
- `apps/ui/src/components/ui/**` (generated shadcn kit) is already excluded from
  the coverage requirement. Don't chase it.
- The largest files, per `apps/ui/CLAUDE.md`: `pages/home-page.tsx` (~1370
  lines), `pages/profile-form-page.tsx` (~670), `components/forms/schema-form.tsx`
  (~500).
- The UI baseline run reported **6 non-fatal errors** alongside 557 passing
  tests. Diagnose those early — they may be unhandled rejections that will
  confuse later runs.

Rate achieved on the API for calibration: ~1,150 tests took it from 55.52% to
97.89%, across five Workflow batches of 5-7 agents each.

### Findings filed rather than fixed

The agents surfaced real defects while writing tests. Every one is **pinned by a
test asserting current behaviour**, so fixing the source will fail that test and
force a deliberate assertion update — nothing can be fixed silently. Filed as
issues #490, #491, #492, #493, #494, #495, #500, #501, #502. Highlights:

- **#501** — `packages/auth` logs the OTP in plaintext via `console.log` when no
  notification client is configured; also unescaped `appName`/`user.name` in
  outbound email HTML.
- **#502** — `verifyOtp` deletes the one-time OTP key *before* the self-signup
  gate and identifier checks, so a non-code failure burns a valid code.
- **#500** — an empty `status_rules` array crashes network-config load with a raw
  TypeError instead of a ZodError.
- **#490** — several handlers violate the repo's "routes never throw" rule.
- **#494** — some queries against the partitioned `items` table can't prune.

## PROMPT ENDS HERE
