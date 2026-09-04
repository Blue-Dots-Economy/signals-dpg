---
suite: 1
name: Config, schema, served domains
requires:
  fixtures: preflight passing; Journey A needs `cfg.selfSignupMode === 'allowed'`
    and `caps.testOtp` (CREATE_TEST_OTP on the target); Journey L (API) needs
    `provisioningMethod(cfg, caps) !== null` (either self-signup allowed or
    service creds present, so SOME account can be created).
  capabilities: testOtp for Journey A; none beyond preflight for Journey L's
    anonymous-401 case.
  grep: `Journey A|Journey P` for suite 4 overlap; this suite's own reference
    below has no dedicated grep of its own — its cases live inside Journey A
    and the dedicated support-config spec, both already covered by other
    aliases (`auth`, `support`).
---

# Suite 1 — Config, schema, served domains

## Cases

- `GET /api/v1/network/schemas` sanity (preflight; suite 0's own spec, also
  the schema every downstream journey depends on)
- Journey A: signup → profile → discoverable exercises the served-domain
  schema resolving correctly end to end for the domain under test
- `/api/v1/support/config` (Journey L, API): **the one live-failure gap this
  design actually closes** — anon gets 401, an authenticated caller gets the
  server's own attachment limits back (Task 3's defect 3 fix)

## Known gaps (parked for the follow-on plan)

- `POST /api/v1/network/refetch_schemas` — no journey exercises the cache-bust
  path at all (listed in `check-coverage.mjs --json`'s `parked` set today).
- Served-domain **subsetting** — no spec proves that an instance serving only
  a subset of a network's domains actually restricts what it returns; every
  existing journey runs against a target serving all of `blue_dot`'s domains.
