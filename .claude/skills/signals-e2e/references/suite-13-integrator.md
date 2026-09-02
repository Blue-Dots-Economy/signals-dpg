---
suite: 13
name: Integrator surface
requires:
  fixtures: a minted `network_service` API key + acting-org id, exported as
    `E2E_SERVICE_API_KEY` / `E2E_ACTING_ORG_ID` before invoking `run.sh`. In
    the main checkout: `pnpm --filter api db:seed:services` (aliased at the
    repo root as `pnpm db:seed:services:api`).
  capabilities: `serviceAuth` — **not enabled by `stack-up.sh` today**
    (spec §3.5 names this as a known reconciliation gap; `stack-up.sh`'s own
    closing log line lists exactly `db notificationStub faultInjection
    deterministicKey` as enabled, `serviceAuth` is absent). Without the export
    above, every case below reports a clean capability SKIP (section 4), not a
    failure — that is correct behaviour for an unseeded target, not a bug.
  grep: `Journey I|Journey J|Journey V`
---

# Suite 13 — Integrator surface

## Cases

**Journey I (service auth & participant):**
- an invalid API key is rejected (403 `INVALID_API_KEY`, no session fallback)
- a valid key without an acting-org header is rejected (400 `MISSING_ACTING_ORG`)
- a valid service caller creates a participant, and a duplicate returns 409
- `network_service` upserts an aggregator org (idempotent on slug)
- `network_service` performs an action on behalf of a user; negatives enforced

**Journey J (aggregator dashboard):**
- dashboard rolls up an aggregator's onboarded participants; refresh + export work
- a non-aggregator acting org is rejected from the dashboard

**Journey V (admin participant tiers):**
- a lookup with no identifier is refused
- an unknown identifier reports absence without leaking anything
- the onboarding org reads its participant back, and decrypt returns cleartext PII
- an aggregator cannot read a participant it did not onboard
- decrypt refuses a caller with no acting org
- a signed-in human cannot reach the admin tier

## Known gaps (parked for the follow-on plan)

- **Seeding `serviceAuth` is not part of `lib/stack-up.sh` or any script in
  this skill.** The architecture sketch names a `seed.sh` for exactly this;
  it was never built across Tasks 2–9. Until it is, running this suite for
  real means minting the key by hand (see `requires:` above) before invoking
  `run.sh` — the skill itself will not do it for you, and will not fail loudly
  about it either (a missing key is a silent, correctly-reasoned SKIP, which
  is easy to mistake for "this suite has no gaps" if you don't read section 4).
- Dashboard **export** format/content is only smoke-tested ("export work"),
  not asserted field-by-field.
- **Decrypt ownership** boundary is asserted in the deny direction (an
  aggregator can't read another's participant) but the allow direction's
  actual decrypted PII shape is only spot-checked, not schema-validated.
