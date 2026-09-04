---
suite: 2
name: Auth & account
requires:
  fixtures: Journey A needs `cfg.selfSignupMode === 'allowed'` + `caps.testOtp`.
    Journey B needs `cfg.selfSignupMode === 'gated'` + (for its service-path
    test) `caps.serviceAuth` (E2E_SERVICE_API_KEY/E2E_ACTING_ORG_ID — NOT set
    by `stack-up.sh` today, see suite 13's reference). Authenticated UI needs
    `provisioningMethod(cfg, caps) !== null` + `caps.testOtp`.
  capabilities: testOtp always; serviceAuth for Journey B's onboarding case
    only (skips cleanly without it, does not fail).
  grep: `Journey A|Journey B|Authenticated UI`
---

# Suite 2 — Auth & account

`blue_dot`'s target runs `selfSignupMode: allowed` (`config/local.json`), so
Journey A's cases execute; Journey B's `gated` cases self-skip on this target
via `test.skip(({ cfg }) => cfg.selfSignupMode !== 'gated', ...)` — that is
correct behaviour, not a hole, and would flip if the alias were run against a
target configured `gated`.

## Cases

**Journey A** (self-signup → profile → discoverable):
- new adult signs up, creates a profile, and it becomes discoverable
- consent gates discoverability: no profile consent ⇒ not live/discoverable

**Journey B** (gated self-signup):
- auth config reports self-signup disabled
- an unknown identifier cannot self-register (no OTP issued)
- the service-provisioning path onboards a participant who can then log in
  (`serviceAuth`-gated)

**Authenticated UI** (`journey-auth.ui.spec.ts`):
- an injected session passes `RequireAuth` (profile-form loads, no redirect)
- an anonymous visit to a protected route redirects to login (control)

## Known gaps (parked for the follow-on plan)

- **Wrong-portal toast** — no assertion that visiting the aggregator's login
  flow against a Signals-only account (or vice versa) surfaces the intended
  user-facing message rather than a generic failure.
- **Session expiry** — no journey lets a session age out and asserts the
  re-auth path; every existing test authenticates fresh.
- **Channel validation copy** — the exact user-facing error text for an
  invalid phone/email at signup is untested; only the machine error code is
  asserted today.
