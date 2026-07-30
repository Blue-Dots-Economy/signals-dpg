# U18 Action Channel Block — Block minors' actions on external channels, keep the UI flow

Issue: [#395](https://github.com/Blue-Dots-Economy/signals-dpg/issues/395) — sub-issue of #367 (Terms & Consent for channels outside the app), §4.3.

## Goal

Block **U18 (under-18) participants from performing actions via any external / on-behalf channel** (voice, aggregator, network-service, API). A minor's action must only be possible **from the UI, where the user acts on themselves** (and there, the existing guardian-OTP flow still governs it). **Adults are unaffected on every channel.**

This is the enforcement counterpart to #367 §4.3: where the UI requires a fresh guardian OTP, external channels must be **blocked outright** — there is no guardian-OTP path over voice/aggregator for now.

## Non-goals

- The **nudge** (email/SMS "come back to the app") on a blocked action — that is [#396](https://github.com/Blue-Dots-Economy/signals-dpg/issues/396). This spec only returns a clear, documented error; it exposes a seam #396 can hook.
- Update-path **create/update** consent gating — that is [#397](https://github.com/Blue-Dots-Economy/signals-dpg/issues/397).
- Adding a guardian-OTP path over voice — explicitly deferred by the issue.

## Design decisions (confirmed)

The issue flags these as "needs:decision". Confirmed with product:

| # | Question | Decision |
|---|----------|----------|
| 1 | Which callers does the block cover? | **Any on-behalf call** — any request carrying an `acting_org` (aggregator, network_service, future voice). Only the UI self-session (no `acting_org`) is exempt. |
| 2 | Which domains? | **Only guardian-gated domains** (`guardianConsentRequired(cfg, domain)` — network.json marks the domain). Matches today's U18 gating precondition. |
| 3 | Unknown/unrecorded age on an external call? | **Fail-closed (block).** Can't prove adult ⇒ don't allow on-behalf. (Changes today's behavior, which proceeds on unknown age — see Back-compat.) |
| 4 | Which action paths? | **Perform + status-updates.** `action/perform` gets the block; `update_action_status` is already self-acted-only (no on-behalf path), so the block is a locked invariant there, not new behavior. |
| A/B | One API or a separate voice API? | **(A) one API, gate by caller + age.** The channel is reliably attestable on the request (below), so a separate endpoint isn't needed. |

## Model: channel + age are both already knowable on the request

**Channel (who/where):** `_resolve_acting_actor.ts` already encodes it —
- **self / UI:** no `acting_org` on the request → `effective_user_id = request_user_id` (session cookie, or apikey-as-self). Audit columns null.
- **external / on-behalf:** `acting_org` present (`aggregator` | `network_service` | future `voice`) + `acting_as_user_id` required.

So `Boolean(request.acting_org)` is the channel signal. No new "channel claim" field is needed, and it can't be spoofed by the payload (it derives from the authenticated `x-acting-org-id` + api-key).

**Age (U18 vs adult):** `guardianActionGate` already derives it —
`getWardAge(wardUserId)` → `isMinor(age)`, guarded by `guardianConsentRequired(cfg, sourceDomain)`. `age` is the Signals #331 snapshot (`age_recorded_at` lower bound), not a live DOB; `null` when never recorded.

## Gate contract change — `services/guardian_action_gate.ts`

Make the gate **channel-aware** and add a terminal **block** outcome. This keeps `perform_action` and `update_action_status` sharing one policy (they already both call `guardianActionGate` + map via `guardianGateFailure`), so perform/status can't drift.

### Input

```ts
export type GateInput = {
  // …existing fields…
  channel: 'self' | 'external';   // NEW — derived from Boolean(request.acting_org)
};
```

### Result

```ts
export type GateResult =
  | { status: 'not_required' }
  | { status: 'challenge_issued' }
  | { status: 'verified'; scope: string }
  | { status: 'invalid_otp' }
  | { status: 'throttled' }
  | { status: 'rate_limited' }
  | { status: 'no_provider' }
  | { status: 'external_minor_blocked'; reason: 'minor' | 'age_unknown' };   // NEW
```

### Logic (after the existing `guardianConsentRequired` short-circuit)

```
if (!guardianConsentRequired(cfg, sourceDomain)) return not_required   // unchanged
age = await getWardAge(wardUserId)

if (channel === 'external') {
  if (age !== null && !isMinor(age)) return not_required               // ADULT on-behalf → proceed (unchanged for adults)
  // minor, OR age unknown (fail-closed, decision 3)
  return external_minor_blocked{ reason: age === null ? 'age_unknown' : 'minor' }
}

// channel === 'self' (UI): existing behavior verbatim
if (age === null || !isMinor(age)) return not_required
…issue / verify guardian OTP…
```

Only two behaviors change, both scoped to `channel === 'external'` on a gated domain: a **minor** (was: OTP challenge) and an **unknown-age** user (was: proceed) now **block**. Everything on the `self` path, and every adult, is byte-for-byte unchanged.

### Failure mapping — `guardianGateFailure`

```ts
case 'external_minor_blocked':
  return new BulkItemFailure(
    'MINOR_ACTION_CHANNEL_BLOCKED',
    "This participant is a minor; actions for minors must be completed in the app and can't be performed via this channel.",
  );
```

- Per-item code `MINOR_ACTION_CHANNEL_BLOCKED` in the bulk envelope (`{status:'error', error, message}`); aggregate HTTP 422 (bulk) / the single-object route surfaces it the same way perform already surfaces per-item errors. Documented so aggregator/voice callers can branch on it.
- The `reason` (`minor` | `age_unknown`) is logged (not leaked in the message) for support triage.

## Endpoint behavior

### `POST /api/v1/action/perform` (+ `/perform/bulk`)

`runPerformActions` already resolves `actor` and calls `guardianActionGate(...)`. Pass the channel:

```ts
channel: request.acting_org ? 'external' : 'self',
```

`wardUserId` stays `actor.effective_user_id` (the on-behalf participant, or the self user). No other change to the handler — the new `external_minor_blocked` result flows through the existing `guardianGateFailure` throw.

### `POST /api/v1/action/update-status`

Self-acted only (on-behalf removed per `2026-05-23-action-on-behalf-of…`). The caller must own the item; a service-user api-key can't stand in for a participant. Pass `channel: 'self'` (there is no `acting_org` on-behalf path here). Result: the block **never fires** on this path today — the U18 UI OTP flow (stage `accept`) is unchanged. Passing the field keeps the gate signature uniform and **locks the invariant**: if on-behalf is ever re-added to status-updates, minors are blocked automatically. A test asserts this.

## Implementation outline

### Files
- `apps/api/src/services/guardian_action_gate.ts` — add `channel` to `GateInput`; add `external_minor_blocked` to `GateResult`; branch as above; map in `guardianGateFailure`.
- `apps/api/src/routes/v1/action/perform_action.ts` — pass `channel: request.acting_org ? 'external' : 'self'` into the gate call.
- `apps/api/src/routes/v1/action/update_action_status.ts` — pass `channel: 'self'`.
- (No schema/contract change — no new request field; only a new documented error code.)

### Out of scope (seams left for siblings)
- Nudge on block → #396 (hook off `MINOR_ACTION_CHANNEL_BLOCKED`).
- Update/create consent gating → #397.

## Back-compat / rollout risk (assessed — low)

Fail-closed on unknown age (decision 3) was initially a concern (age-less **adults** on a gated domain would block). Confirmed with product that the real blast radius is **near zero**: on a guardian-gated domain a profile **cannot go live without an age recorded**, and the action path already rejects a non-live source with `PROFILE_NOT_LIVE` **before** the gate runs. So an age-less user on a gated domain can't reach the gate with a live source anyway — fail-closed only hardens the edge (e.g. an age-less user who somehow has a live source), it doesn't newly break a working adult flow.

Non-gated domains and the UI path are unaffected either way.

## Test plan

### Unit — `guardian_action_gate` (new/extended)
- external + minor (gated domain) → `external_minor_blocked{reason:'minor'}`.
- external + age unknown (gated) → `external_minor_blocked{reason:'age_unknown'}` (fail-closed).
- external + adult (gated) → `not_required` (adults unaffected).
- external + any age on a **non-gated** domain → `not_required` (short-circuits before age).
- self + minor (gated) → `challenge_issued` / `verified` (UI OTP flow unchanged).
- self + adult / unknown → `not_required` (unchanged).
- `guardianGateFailure(external_minor_blocked)` → `MINOR_ACTION_CHANNEL_BLOCKED`.

### Unit — `perform_action.test.ts` (extend)
- authed on-behalf (acting_org) + minor source owner on a gated domain → per-item `MINOR_ACTION_CHANNEL_BLOCKED`, no relay fetch.
- authed on-behalf + adult → proceeds (existing 201 path).
- self session + minor → existing guardian-OTP behavior (challenge/verify) unchanged.

### Unit — `update_action_status.test.ts`
- self + minor → OTP flow unchanged; assert channel is always `'self'` and the block never fires.

### Integration — `u18_perform_action.integration.test.ts` (extend)
- Seed a minor (age recorded < 18) + a gated domain; perform via api-key + acting_as → 422 `MINOR_ACTION_CHANNEL_BLOCKED`; same source via session → guardian-OTP challenge.
- Seed an adult; perform via api-key + acting_as → succeeds.

### Manual smoke
- Deployed-style: aggregator key + `acting_as` a minor → blocked; an adult → works; the minor completes the same action in the UI via guardian OTP.

## Open follow-ups (deferred)
- Guardian-OTP-over-voice (issue explicitly defers).
- Nudge copy + dispatch on block (#396).
- If age capture on gated-domain onboarding lands, revisit whether fail-closed can be the permanent default with no adult false-positives.

## Spec self-review
- **Adults never blocked** on any channel — the external branch returns `not_required` for a confirmed adult; the only new blocks are minor + (fail-closed) unknown-age, both external + gated-domain only. ✔ (matches the user's explicit "don't block external completely" constraint)
- **Channel is attestable, not spoofable** — derives from authenticated `acting_org`, not a payload claim. ✔
- **One policy, two paths** — perform + status share `guardianActionGate`/`guardianGateFailure`, so codes can't drift. ✔
- **Biggest risk called out** — fail-closed unknown-age can catch age-less adults on gated domains; mitigation options listed for review. ✔
