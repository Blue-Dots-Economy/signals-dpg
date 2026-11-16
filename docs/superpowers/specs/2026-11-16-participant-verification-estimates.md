# Participant Verification — Stories & Estimates

**Issue:** [signals-dpg#883](https://github.com/Blue-Dots-Economy/signals-dpg/issues/883) · **Design:** `2026-11-12-participant-verification-design.md` 

## Design (before implementation) — 1 day

| Story | Days |
|---|---|
| Resolve open questions, choose the signed-object format, agree the Signals API contract | 1 |

## signals-dpg — ~6 days

| Story | Days |
|---|---|
| Verification config (`network.json`) and DB tables | 0.5 |
| Instance signing key and public key endpoint (JWKS) | 1 |
| Verify attributes and issue the signed object when all required attributes are verified | 1.5 |
| Revoke on attribute change or profile retire | 1 |
| Return verified status on profile and dashboard reads | 1 |
| Tests and docs | 1 |

## aggregator-dpg — ~5 days

| Story | Days |
|---|---|
| Signals client methods, API routes, `profiles.verify` for coordinator | 2 |
| Coordinator verification screen and verified icon | 2 |
| Tests | 1 |

## Both repos — ~1 day

| Story | Days |
|---|---|
| Testing both apps together, PR reviews and fixes | 1 |
