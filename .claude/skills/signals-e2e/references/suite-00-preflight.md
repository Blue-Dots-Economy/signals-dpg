---
suite: 0
name: Preflight & stack-up
requires:
  fixtures: none — this suite IS the "is there a target at all" gate
  capabilities: none (runs before capability wiring is even meaningful)
  runs_as: tests/preflight/target-ready.spec.ts, a Playwright `dependencies`
    project every api/ui spec depends on — it always runs first regardless of
    --grep, so a dead target fails fast instead of every downstream spec
    failing individually with a connection-refused error.
---

# Suite 0 — Preflight & stack-up

The existing journey coverage here is "none" by design — the lifted suite
assumes an already-running target and never brings one up. **All of this
suite's gap is closed outside a Playwright spec**, in `lib/stack-up.sh` +
`lib/run.sh`:

- the UI identity + port probe (`:3000` is the aggregator here, not Signals —
  see the SKILL.md gotcha table),
- reading real DB credentials from the target's own `.env` rather than
  guessing,
- the notification-env triple-check (`NOTIFICATION_SERVICE_ENDPOINT` +
  `_KEY_ID` + `_SECRET` — all three, or the API sends nothing while
  `notificationStub` still reads as enabled),
- the stack-reuse marker (skip stack-up entirely when a live target already
  matches the requested dot).

## Cases (tests/preflight/target-ready.spec.ts)

- root endpoint is live and serves domains
- auth config is reachable and matches the declared signup mode (skips if the
  target predates `GET /api/v1/auth/config`)
- a network schema resolves for the first served domain (schema sanity)

## Known gaps

- Orphan-tag detection at preflight (spec §5: "preflight detects orphan tags
  from a killed earlier run and offers to clear them") is not built — a killed
  run's residue must be swept explicitly via `/signals-e2e cleanup <tag>`
  rather than being offered automatically on the next full run. Parked for the
  follow-on plan.
