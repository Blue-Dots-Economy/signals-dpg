---
suite: 3
name: User consent + legal
requires:
  fixtures: `provisioningMethod(cfg, caps) !== null` + `caps.testOtp` (Journey
    K creates a live user via `createLiveProfileUser`/service provisioning).
  capabilities: testOtp; the UI-side consent flow additionally needs
    `passConsentGate(page)` (`e2e/src/ui.ts`) — see the SKILL.md gotcha table,
    it waits on the "That's everything" hint text rather than `aria-disabled`.
  grep: `Journey K`
---

# Suite 3 — User consent + legal

## Cases (Journey K — consent ledger)

- a client-supplied consent version is ignored; the server records its own
- re-accepting terms is append-only and does not multiply the current version
- `profile_creation` consent is idempotent (re-accept records nothing new)

`passConsentGate` (Task 3's defect-1 fix) is exercised indirectly by every UI
signup flow that clicks through the consent screen (`uiSignupAdult`), not by a
dedicated "does the scroll-gate itself work" spec.

## Known gaps (parked for the follow-on plan)

- **The scroll-gate itself is untested as a behaviour.** `passConsentGate`
  makes the *helper* work reliably; nothing asserts that clicking "Accept &
  Continue" *before* scrolling to the end actually fails, i.e. that the gate
  is real and not just cosmetically disabled.
- **`/legal` route layout + anchors** — no UI spec visits the single `/legal`
  route (#637) and asserts its section anchors resolve.
- **`__SUPPORT_EMAIL__` substitution** — this is one of `notify.ts`'s three
  global copy-drift invariants (`assertNoCopyDrift`), but no spec calls the
  notify sink yet (see the `emails` alias) — so today nothing actually
  exercises it against a consent-related email.
