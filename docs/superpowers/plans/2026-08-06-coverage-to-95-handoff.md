# Coverage → 95% — handoff prompt for a fresh session

**Created:** 2026-08-06
**Status:** infra + dead-code landed as PRs; coverage work is batch 1 of many.

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

### Target and current state

Baseline measured on the `feature` branch (2026-08-06). **Re-measure before
starting** — see "How to measure" below.

| Package | Lines | Notes |
|---|---|---|
| `apps/api` | 57.8% (was 55.52%) | batch 1 landed; 706 tests passing |
| `apps/ui` | 41.76% | untouched — the biggest remaining gap |
| `packages/config` | 82.08% | small file count, quick wins |
| `packages/schemas` | 78.45% | |
| `packages/auth` | 96.49% | already above target |
| `packages/database`, `notification`, `match_score` | 0% | **OUT OF SCOPE — the user explicitly excluded these.** Do not add tests or coverage for them. They are excluded in `sonar-project.properties`. |

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
3. **PR #487** — `test/coverage-api-batch-1`: batch 1, 96 tests, based on #486.

### Critical context you would otherwise waste time rediscovering

- **SonarCloud had never successfully analyzed this repo.** The org is
  `blue-dots-economy`, project key `Blue-Dots-Economy_signals-dpg`. A `SONAR_TOKEN`
  repo secret existed but no CI step ever called the scanner; the single analysis
  attempt on record failed in under a second. PR #486 adds
  `sonar-project.properties` + a `sonar` job in `.github/workflows/ci.yaml`.
  **The CI scan has not been verified end-to-end yet** — confirm it authenticates
  and reports once #486 merges. Dashboard:
  https://sonarcloud.io/project/overview?id=Blue-Dots-Economy_signals-dpg
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
- **Subagent fan-out failed repeatedly here.** Seven parallel agents were
  launched across two attempts; every one died on "Connection closed
  mid-response" or a 600s stall, and one of them `git stash`-ed the main
  thread's uncommitted work as "out of scope" (recovered via `git stash pop`).
  **Recommendation: work inline.** If you must delegate, give each agent a
  strictly disjoint directory, and forbid: any `git` command, `pnpm install`,
  editing `package.json`/`vitest.config.ts`, and `--coverage` (concurrent
  coverage writes to the shared `coverage/` dir collide).

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

Ranked by uncovered-lines × ease. Re-derive with the ranking command above, since
batch 1 already moved some of these.

**apps/api** (~1,600 uncovered lines):
| File | Lines | Was |
|---|---|---|
| `src/services/item_service.ts` | 131 | 11.4% |
| `src/routes/v1/consent/u18_profile_consent.ts` | 134 | 11.2% |
| `src/routes/v1/action/fetch_actions.ts` | 116 | 4.3% |
| `src/network_schema_cache.ts` | 114 | 3.5% |
| `src/utils/item_fetch_runtime.ts` | 81 | 2.5% |
| `src/routes/v1/item/create_item.ts` | 67 | 4.5% |
| `src/services/signup_guardian.ts` | 65 | 4.6% |
| `src/routes/v1/item/lifecycle.ts` | 60 | 8.3% |
| `src/utils/action_event_runtime.ts` | 59 | 28.8% |
| `src/scripts/backfill_lifecycle.ts` | 55 | 0% |
| `src/routes/v1/admin/participant_read.ts` | 53 | 37.7% |
| `src/routes/v1/consent/*` (the rest) | ~250 | 8–19% |

Note `src/server.ts` (17 lines, 0%) and `plugins/auth/auth_middleware.ts` (18
lines, 0%) — the middleware is worth covering; `server.ts` is a bootstrap entry
and may be better added to `sonar.coverage.exclusions` than tested.

**apps/ui** — untouched and the largest gap (~3,300 uncovered lines). Not yet
analysed per-file; start by generating the ranking. `apps/ui/CLAUDE.md` flags the
largest files: `pages/home-page.tsx` (~1370 lines), `pages/profile-form-page.tsx`
(~670), `components/forms/schema-form.tsx` (~500). Existing UI tests use
`@testing-library/react` + `happy-dom`; read `apps/ui/src/test/setup.ts` and a
couple of existing `src/**/*.test.tsx` files for the pattern. UI tests are much
slower than API ones (the baseline full-UI coverage run took ~17 min once).

Also: the UI baseline run reported **6 non-fatal errors** alongside 557 passing
tests. Worth diagnosing — they may indicate unhandled rejections in tests.

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

### Honest expectation-setting

Batch 1 was 96 tests for **+2.3pp** on api. The remaining gap is ~37pp on api and
~53pp on ui, over roughly **5,000 uncovered lines**. Linear extrapolation puts
95% at **1,500+ additional tests** — a multi-week effort across many PRs, not a
single session. Some of the remainder is also genuinely awkward to unit-test
(bootstrap files, thin DB wrappers) and may be better handled by targeted
`sonar.coverage.exclusions` entries than by contorted tests; propose those to the
user rather than adding low-value tests to inflate a number.

If the user wants a faster route to a green SonarCloud gate, two options worth
raising with them explicitly:
- Set the quality gate on **new-code coverage** rather than overall coverage
  (SonarCloud's default and recommended posture) — new code gets held to 95%
  while the legacy backlog is paid down incrementally.
- Run the excluded `*.integration.test.ts` suite in CI with Postgres + Redis
  services and merge its lcov with the unit lcov. That reclaims a large amount of
  already-written-but-uncounted coverage. `ci.yaml` already has a
  `schema-parity` job that stands up `postgres:16-alpine` services — copy that
  pattern. This is likely the single biggest coverage win available for the
  least new code.

## PROMPT ENDS HERE
