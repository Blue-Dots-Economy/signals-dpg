---
paths:
  - "apps/api/src/routes/**"
  - "apps/api/src/services/**"
  - "apps/api/src/middleware/**"
  - "apps/ui/src/pages/**"
  - "apps/ui/src/components/**"
  - "packages/schemas/src/**"
  - "packages/config/src/consent_config_loader.ts"
  - "e2e/**"
  - "openapi.json"
---

# The E2E suite ships with the change, not after it

`e2e/` is a **release gate**, not a test folder that gets caught up later. A behaviour change that lands without a corresponding change in `e2e/` silently downgrades the gate — the suite keeps passing while no longer describing the product. Strategy doc §10 states the rule; `e2e/scripts/check-coverage.mjs` enforces the route half of it.

**The gate is currently at 46% route coverage (24/52 operations).** The uncovered 28 are parked in `e2e/coverage-baseline.json` with a burn-down plan in `docs/testing/e2e-coverage-backlog.md`. That list may **only shrink**. Adding a line to it means you shipped a route with no journey.

## What to do, by kind of change

| You are… | Do this in `e2e/` |
|---|---|
| **Adding a route** | Add or extend a journey that calls it. Then `npm run coverage` — it fails until the route is mapped. |
| **Adding an error code** (`return reply.code(N).send({ error: 'X' })`) | Assert `X` in a negative test. An error code with no test is an untested branch of a fail-closed guard — exactly the class of bug this gate exists to catch. |
| **Changing behaviour** of an existing route | Update the *invariant* the journey asserts, not just the expected value. If the assertion still passes unchanged, ask whether it was asserting anything real. |
| **Adding a fail-closed guard** (consent, U18, ownership, auth) | Both directions: the blocked path returns the exact code, **and** the allowed path still works. A guard tested only in the deny direction can be fail-open in the allow direction. |
| **Adding a UI screen or flow** | UI-layer only if it's UI risk (rendering, i18n, theming, form wiring). Business rules belong in an API journey — see strategy §2.3. |
| **Deleting a route or feature** | Delete the journey/assertions with it, and drop its `coverage-baseline.json` line. The check warns on baseline entries whose route no longer exists. Do not leave a `test.skip` behind as a tombstone. |
| **Renaming a route** | The check reports the old path as a stale baseline entry and the new one as unmapped. Fix both. |

## Mechanics (don't reinvent these)

- `import { test, expect } from '../../src/fixtures.js'` — never from `@playwright/test` directly. Fixtures give you `cfg`, `caps`, `api`, `service`, `authCtx`, `provider`, `mailpit`.
- **Assert behaviour, not payload shape.** The app is schema-driven; hardcoding field lists from one `network.json` is how this suite rots. Resolve fields via `resolveBinding()` / `src/schema.ts`.
- **Never silently skip.** If a target can't support an assertion, gate it with `requireCapabilities(test, caps, ['db'])` so it reports as skipped-with-reason. A `test.skip(true)` with no capability reason is a lie in the report.
- New capability needed? Add it to `Capabilities` **and** `REASONS` in `src/capabilities.ts`, and to the config that enables it. Both, or the skip message is blank.
- Namespace all test data through `src/identities.ts` (`RUN_ID`, `is_test`) so parallel runs don't collide.
- Name the describe block after the journey letter in strategy §4 so the matrix stays honest. New journey ⇒ add a §4 entry and a §10 matrix row.
- Path built at runtime, or exercised through the browser? The literal-path scanner can't see it — annotate the spec:
  `// @covers GET /api/v1/action/{action_id}/contact-details`

## Before you call the change done

```bash
pnpm --filter api spec:dump      # regenerate openapi.json if you touched routes
cd e2e && npm run coverage       # traceability gate — must exit 0
npm run typecheck
```

`openapi.json` is the route table the check reads. If you added a route and didn't re-dump the spec, the check passes for the wrong reason.

Running the suite needs a live target and is a separate step (`bash e2e/run-e2e.sh local`, or `/e2e local`) — the coverage check does not need one.

## The judgement call

Not every change needs a new spec file. Extending an existing journey is usually right; a new journey letter is for a genuinely new surface. What is **not** a judgement call: shipping a new route, a new error code, or a new fail-closed guard with nothing in `e2e/` to prove it works. If you believe a change genuinely needs no E2E coverage, say so explicitly in the PR description rather than leaving it unstated.
