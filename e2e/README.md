# signals-dpg — End-to-End Functional Tests (external mode)

Black-box functional tests that run against an **already-running** signals-dpg
instance (local or a deployed dev instance). The suite **never** starts, migrates,
or seeds infrastructure — it points at a target described by a config file and
asserts behavior.

This folder is **self-contained**: it has its own `package.json` and is **not** part
of the pnpm workspace. It touches nothing in the rest of the repo.

Design rationale and the full journey/gate strategy live in
[`../docs/testing/e2e-functional-test-strategy.md`](../docs/testing/e2e-functional-test-strategy.md).

---

## Prerequisites

You need a **running** signals-dpg target. For local, the easiest way is the
repo's own setup (`../local-setup/` or `../SETUP.md`) — bring up the API + UI +
db + redis, then run the suite against it.

For OTP journeys to run headlessly, the target must be launched with
`CREATE_TEST_OTP=true` (or expose an inspectable notification sink). Tests that
need capabilities the target doesn't offer are **skipped and reported**, never
silently passed.

## Install

```bash
cd e2e
npm install
npx playwright install chromium
```

> Uses npm on purpose, so the folder stays fully decoupled from the repo's pnpm
> workspace. Nothing outside `e2e/` is modified.

## Run

```bash
# against your local instance (full fidelity)
E2E_ENV=local npm run e2e

# against the deployed dev instance
E2E_ENV=dev   npm run e2e

# subsets
E2E_ENV=local npm run e2e:api      # API journeys only (no browser)
E2E_ENV=local npm run e2e:ui       # browser journeys only
npm run e2e:report                 # open the last HTML report
```

`E2E_ENV` selects `config/<env>.json`. Use `E2E_CONFIG=/abs/path.json` for an
explicit file. The **preflight** project runs first and fails fast (skipping the
rest) if the target is unreachable or on an incompatible schema.

### One-shot runner: `/e2e` command + `run-e2e.sh`

`run-e2e.sh` is a thin wrapper that selects the env, loads its secrets, ensures
deps, and runs a tier. It's exposed as a Claude Code slash command
(`.claude/commands/e2e.md`) and is equally runnable from a plain shell or CI:

```bash
/e2e local              # in a Claude session — full suite against local
/e2e dev api            # dev target, API tier only

bash e2e/run-e2e.sh local           # same, from a shell
bash e2e/run-e2e.sh local preflight # tiers: api | ui | preflight | all (default)
```

**Per-env secrets.** The wrapper sources a gitignored `e2e/.env.<env>` (never
committed; `.env.*` is ignored, `.env.*.example` templates are tracked). Copy a
template and fill in the service credentials:

```bash
cp e2e/.env.local.example e2e/.env.local   # then set E2E_SERVICE_API_KEY / E2E_ACTING_ORG_ID
```

Mint a local `network_service` key with:
`POSTGRES_URL="postgres://<user>:<pass>@localhost:5432/signals" pnpm db:seed:services:api`.

## Configuration

One file per environment under `config/`. Fields are documented in
[`src/config.ts`](src/config.ts). Secrets should come from the environment and
override the file — **never commit real secrets**:

| Env var | Overrides |
|---|---|
| `E2E_API_BASE_URL` / `E2E_UI_BASE_URL` | target URLs |
| `E2E_SERVICE_API_KEY` / `E2E_ACTING_ORG_ID` | P5/P6 service-auth creds |
| `E2E_DB_URL` | enables the `@needs-db` introspection tier |
| `E2E_NOTIFICATION_STUB_URL` | inspectable notification sink |
| `E2E_PEER_API_BASE_URL` | second peer instance (G3) |
| `E2E_WORKERS` / `E2E_RUN_ID` | parallelism / stable run namespace |

### Capability gating (skip-and-report)

Not every assertion can run against every target. Tests declare what they need via
`requireCapabilities(test, caps, [...])`; unsupported ones skip with a visible
reason. Config presence enables each capability:

| Capability | Enabled when… | Typically |
|---|---|---|
| `testOtp` | `otp.mode = test-otp` or a notification sink is set | local ✅ / dev ✅ if enabled |
| `db` | `db.url` set | local ✅ / dev ✗ |
| `faultInjection` | `faultInjection: true` | local ✅ / dev ✗ |
| `deterministicKey` | `deterministicPiiKey: true` | local ✅ / dev ✗ |
| `serviceAuth` | `auth.serviceApiKey` + `actingOrgId` set | as provisioned |
| `peer` | `peer.apiBaseUrl` set | G3 only |

## Layout

```
e2e/
  config/<env>.json      external-mode target configs
  src/
    config.ts            typed config + loader (+ env overrides)
    capabilities.ts      capability flags + skip-and-report helper
    api-client.ts        thin HTTP client over Playwright request
    fixtures.ts          base test: cfg, caps, api, service
    identities.ts        namespaced is_test identifiers
    auth.ts              OTP signup/login helpers (000000 under CREATE_TEST_OTP)
    schema.ts            served-binding resolution + minimal item_state builder
    flows.ts             persona factory: create a live-profile user
    actions.ts           action perform/update helpers (envelope + consent retry)
    ui.ts                browser helpers (?lang=en pinning, UI signup flow)
  tests/
    preflight/           target readiness gate (runs first)
    api/journey-*.spec.ts    A–K
    ui/journey-*.ui.spec.ts  A,H,L (+ auth enabler, smoke)
  scripts/
    check-coverage.mjs   route traceability gate (openapi.json vs the suite)
  coverage-baseline.json known, parked coverage gaps — shrink-only
```

### UI (browser) journeys

The `ui` project drives the real React UI. Selectors are anchored on **roles +
the English strings from `apps/ui/src/i18n/locales/en.json`**, and every UI test
pins the language with `?lang=en` (the app's `lang` querystring detector) so text
selectors are stable. Run `npx playwright install chromium` before the first UI run.

On a **gated** target the UI self-signup path is disabled, so authenticated UI
tests provision a user via API and inject the session token (`uiLoginAs`).

Implemented (UI): **A** (self-signup → consent → OTP → home; gated ⇒ skips),
**H** (anonymous discovery top-bar), **L** (language + theme + support dialog),
**auth enabler** (token injection proven via a RequireAuth route), smoke.

Deferred (final UI increment): **D/F** action modal → accept → contact reveal
(a two-browser-context flow — highest flake/cost; the API layer already covers
accept + reveal + the full error matrix), **C** guardian UI (needs
`SELF_SIGNUP_MODE=allowed` — minor self-signup can't run on a gated target), and
the schema-driven profile form.

## Keeping the suite current (the coverage gate)

This suite is a **release gate**, so it has to track the product. The rule
(strategy §10) is enforced by a check, not by good intentions:

```bash
npm run coverage            # fails if a route has no mapped test
npm run coverage:json       # machine-readable, for CI
npm run coverage:baseline   # re-park the current gaps (shrink-only)
```

`scripts/check-coverage.mjs` reads the repo-root `openapi.json` — the route table
Fastify generates from the live routes (`pnpm --filter api spec:dump`) — and
compares it against every `/api/...` path the suite calls. A route can't hide
behind a plugin prefix.

A spec declares coverage by **calling the path literally**, or by annotating it
when the path is dynamic or driven through the browser:

```ts
// @covers GET /api/v1/action/{action_id}/contact-details
```

**Current state: 24/52 operations exercised (46%).** The other 28 are parked in
[`coverage-baseline.json`](coverage-baseline.json) — a debt register that may only
shrink. The burn-down plan, with proposed journeys R–Z, is in
[`../docs/testing/e2e-coverage-backlog.md`](../docs/testing/e2e-coverage-backlog.md).
Claude follows [`.claude/rules/e2e-coverage.md`](../.claude/rules/e2e-coverage.md),
which loads automatically when routes, services, or UI files are edited.

## Adding a journey

1. Add `tests/api/journey-<x>-<name>.spec.ts` (or `tests/ui/...`).
2. `import { test, expect } from '../../src/fixtures.js';`
3. Gate infra-dependent assertions with
   `requireCapabilities(test, caps, ['db'])`.
4. Name the describe block after the journey in the strategy doc (§4) so the
   traceability matrix stays honest.
5. Run `npm run coverage` and drop any route it now covers from
   `coverage-baseline.json`.

## Scope note

Per current direction, this suite is the **external E2E test cases only**. Per-PR
CI wiring (the G0 integration/lint jobs) is intentionally **held** and not part of
this folder.
