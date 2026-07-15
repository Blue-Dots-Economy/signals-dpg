# U18 Phase 5b — Per-Action Guardian Gate (Challenge/Response)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** For a minor on a `guardian_consent_required` domain, every action (`perform_action` initiate, `update_action_status` accept) requires a fresh guardian OTP. First call without an OTP → issue OTP + fail that item with `GUARDIAN_OTP_REQUIRED`; re-call with `guardian_otp` → verify → write the guardian `action` consent row → proceed. No blanket (spec D6).

**Architecture:** A single shared gate helper `guardianActionGate(...)` encapsulates: detect minor+gated (source item creator via `minor_guardian`/`isMinor` + `guardianConsentRequired` on the source domain) → if not gated, no-op → if gated and no OTP supplied, `issueGuardianOtp` + signal "challenge" → if OTP supplied, throttle + `verifyGuardianOtp`; the caller writes the guardian `action` ledger row on success. Wired identically into both action endpoints so the two hot paths share one tested code path. `perform_action` is bulk → the gate runs per item and raises `BulkItemFailure`; `update_action_status` is single.

**Tech Stack:** TS (ESM, strict), Fastify, Drizzle/Postgres, ioredis, Vitest (unit + integration; dpg-db + dpg-redis up).

## Global Constraints

- ESM, strict TS, no `any`; `import type`.
- Reuse Phase 3 OTP (`issueGuardianOtp`/`verifyGuardianOtp`/`assertVerifyAttemptAllowed`/`GuardianOtpError`), Phase 1 (`isMinor`,`guardianConsentRequired`,`getNetworkConfigById`), Phase 2 (`resolveConsentVersion` `variant:'u18'`), Phase 4 repo (`getMinorGuardian`,`getGuardianContactPlaintext`).
- Guardian action consent = `consent_record` row: `level:'item'`? No — action consent is user-level with action fields. Match the existing action-consent shape: `level:'item'`, `consentCategory:'action'`, `actionType`, `actionStage`, `itemId` (source item), `source:'guardian'`, `variant:'u18'` metadata. **Read how the adult path writes action consent** (`update_action_status.ts` accept path + `create_item`/`perform_action` consent writes) and mirror its column usage exactly — do not invent new columns.
- OTP scope per action attempt: `guardian_action:${wardUserId}:${actionType}:${sourceItemId}:${targetItemId}` (stable for the same intended action; re-call reuses it).
- Version resolved BEFORE consuming the nonce. Routes never throw uncaught. Fail-closed: gated minor without a verified OTP never performs the action.
- Do NOT change adult behavior: a non-minor, or an ungated domain, must hit exactly today's code path.

## Pre-flight (read before Task 1)

Read `apps/api/src/routes/v1/action/perform_action.ts` and `update_action_status.ts` end-to-end, and how each currently records action consent (the `consent` block → `consent_record` insert). The gate must slot in AFTER the existing ownership/live/interaction checks and BEFORE the state-changing write, and the guardian action row must use the same `consent_record` columns the adult accept path uses (plus `source:'guardian'`).

---

### Task 1: `guardian_otp` schema field + `guardianActionGate` helper

**Files:**
- Modify: `packages/schemas/src/api/action_schemas.ts` (add optional `guardian_otp` to `PerformActionBodySchema`, `PerformNetworkActionBodySchema`, `UpdateActionStatusBodySchema`)
- Create: `apps/api/src/services/guardian_action_gate.ts`
- Test: `apps/api/src/services/__tests__/guardian_action_gate.test.ts` (unit, mocked deps)

**Interfaces:**
- Add to each of the three body schemas: `guardian_otp: z.string().length(6).optional(),`.
- Produces:
```ts
type GateInput = {
  wardUserId: string;      // source item creator
  network: string;
  sourceDomain: string;
  actionType: string;
  sourceItemId: string;
  targetItemId: string;
  otp?: string;            // body.guardian_otp
};
type GateResult =
  | { status: 'not_required' }                       // adult or ungated → proceed normally
  | { status: 'challenge_issued' }                   // OTP sent; caller fails the item GUARDIAN_OTP_REQUIRED
  | { status: 'verified'; scope: string }            // OTP ok; caller writes guardian action row + proceeds
  | { status: 'invalid_otp' }
  | { status: 'throttled' };
export async function guardianActionGate(input: GateInput): Promise<GateResult>;
```
Logic:
1. `cfg = await getNetworkConfigById(network)`; if `!guardianConsentRequired(cfg, sourceDomain)` → `not_required`.
2. `mg = await getMinorGuardian(wardUserId)`; if `!mg || !isMinor(mg.birthYear, mg.birthMonth)` → `not_required`.
3. `scope = 'guardian_action:' + [wardUserId, actionType, sourceItemId, targetItemId].join(':')`.
4. If no `otp`: `contact = getGuardianContactPlaintext(wardUserId)` (if none → treat as `challenge_issued` is wrong — return a distinct state; simplest: throw `GuardianOtpError`? No — return `{status:'challenge_issued'}` only after a successful issue). Call `issueGuardianOtp({scope, contact})`; return `challenge_issued`. (Bubble `GuardianOtpError` RATE_LIMITED/NO_OTP_PROVIDER to the caller to map.)
5. If `otp`: `assertVerifyAttemptAllowed(scope)` (throttled→`throttled`); `ok = verifyGuardianOtp({scope, otp})`; `verified`(+scope) or `invalid_otp`.

- [ ] **Step 1: add the schema field** — append `guardian_otp: z.string().length(6).optional(),` inside the three schemas listed. Run `pnpm --filter schemas exec vitest run` to confirm nothing breaks (existing action schema tests still pass).

- [ ] **Step 2: write the failing unit test** for `guardianActionGate` — mock `@/network_configs` (`getNetworkConfigById` → cfg with a gated/ungated domain), `@/services/minor` is real (pure), `@/services/minor_guardian_repo` (`getMinorGuardian`,`getGuardianContactPlaintext`), and `@/services/guardian_otp` (`issueGuardianOtp`,`verifyGuardianOtp`,`assertVerifyAttemptAllowed`). Cases: ungated→not_required; gated+adult(no mg)→not_required; gated+minor+no otp→issues + challenge_issued; gated+minor+otp ok→verified; otp wrong→invalid_otp; throttled→throttled. Run → fails (no module).

- [ ] **Step 3: implement `guardian_action_gate.ts`** per the logic above.

- [ ] **Step 4: run unit test + tsc** → green, exit 0.

- [ ] **Step 5: commit** (`feat(u18): guardian_otp field + guardianActionGate helper`).

---

### Task 2: wire the gate into `perform_action` (initiate)

**Files:**
- Modify: `apps/api/src/routes/v1/action/perform_action.ts`
- Test: `apps/api/src/routes/v1/action/__tests__/u18_perform_action.integration.test.ts`

- [ ] **Step 1:** In the per-item `runBulk` body of `perform_action_handler`, after `sourceItemSnapshot` is fetched + the `lifecycle_status==='live'` check, insert the gate:
```ts
const gate = await guardianActionGate({
  wardUserId: actor.effective_user_id,
  network: body.source_item.item_network,
  sourceDomain: body.source_item.item_domain,
  actionType: body.action_type,
  sourceItemId: body.source_item.item_id,
  targetItemId: body.target_item.item_id,
  otp: body.guardian_otp,
});
if (gate.status === 'challenge_issued') throw new BulkItemFailure('GUARDIAN_OTP_REQUIRED', 'Guardian OTP sent; resubmit with guardian_otp to confirm this action.');
if (gate.status === 'invalid_otp') throw new BulkItemFailure('GUARDIAN_OTP_INVALID', 'Guardian OTP is invalid or expired.');
if (gate.status === 'throttled') throw new BulkItemFailure('GUARDIAN_OTP_THROTTLED', 'Too many guardian OTP attempts; try again shortly.');
```
Wrap the `issueGuardianOtp` `GuardianOtpError` (RATE_LIMITED/NO_OTP_PROVIDER) — either inside the gate (return distinct statuses) or catch here and map to `BulkItemFailure('GUARDIAN_OTP_RATE_LIMITED'|'OTP_PROVIDER_UNAVAILABLE', ...)`. Prefer handling in the gate by adding `'rate_limited' | 'no_provider'` to `GateResult`.
When `gate.status === 'verified'`, after the existing action write, add a guardian `action` consent row (`source:'guardian'`, `variant:'u18'`, version from `resolveConsentVersion({network, category:'action', actionType, stage:'initiate', variant:'u18'})`) mirroring the adult action-consent write shape. If u18 action version is unconfigured, resolve falls back — confirm `resolveConsentVersion` for `category:'action'` is NOT variant-split in Phase 2 (it isn't) → so use the existing (non-variant) action version; record the guardian row with the existing action version + `metadata:{variant:'u18'}`. (Action statements were intentionally not variant-split in Phase 2.)

- [ ] **Step 2:** integration test (mock notifier): served `blue_dot/seeker` gated; seed a **minor** ward with a live source profile + guardian details, and a target item. First `perform_action` (no `guardian_otp`) → per-item error `GUARDIAN_OTP_REQUIRED`, and an OTP nonce exists in Redis at the action scope. Read it, re-call with `guardian_otp` → success + a guardian `action` consent row written. Also: an **adult** ward (no minor_guardian) performing the same action → succeeds directly (no challenge) — proves no adult regression. Clean up.

- [ ] **Step 3:** run integration + tsc; also run the existing `perform_action` tests to confirm no regression. Commit.

---

### Task 3: wire the gate into `update_action_status` (accept)

**Files:**
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`
- Test: `apps/api/src/routes/v1/action/__tests__/u18_update_action_status.integration.test.ts`

- [ ] **Step 1:** In `update_action_status_handler`, for the **accept** transition (the PII-revealing/consent-requiring stage the adult path already gates), after the existing existing-action lookup + interaction resolution and before the status write, run `guardianActionGate` with `stage:'accept'` context: `wardUserId = <the accepting user's id>` (the item owner accepting — `request.user.id` / effective actor), `sourceDomain`/`sourceItemId` = the accepting side's item, `actionType` = the action's type, `targetItemId` = the other party. Map the gate statuses to `reply.code(428).send({error:'GUARDIAN_OTP_REQUIRED',...})` (challenge), `400 GUARDIAN_OTP_INVALID`, `429 GUARDIAN_OTP_THROTTLED`, `429 GUARDIAN_OTP_RATE_LIMITED`, `503 OTP_PROVIDER_UNAVAILABLE`. On `verified`, write the guardian `action`/`accept` consent row inside the existing status-update transaction (mirror the adult accept-consent write, `source:'guardian'`, `metadata:{variant:'u18'}`).
  - Note: this endpoint is single (not bulk) → use `reply.code(428)` for the challenge (true challenge/response HTTP semantics).

- [ ] **Step 2:** integration test: a **minor** accepting an action → first call (no otp) → 428 GUARDIAN_OTP_REQUIRED + OTP issued; re-call with otp → 200 + guardian accept consent row + status advanced. Adult accept → unchanged (no challenge). Clean up.

- [ ] **Step 3:** run integration + existing update_action_status tests + tsc. Commit.

---

## Phase 5b exit criteria

- Minor on a gated domain: perform/accept require a fresh guardian OTP (challenge → re-call → verified), a guardian `action` consent row is written per action, no blanket.
- Adults + ungated domains: byte-for-byte unchanged behavior (proven by an adult test + the existing action suites staying green).
- Fail-closed; version-before-nonce; throttled; routes never throw uncaught; no `any`.

## Self-review notes

- **Spec coverage:** D6 per-action, no blanket + §7 action gate + Phase-3 carry-forward throttle → the gate + both wirings. Challenge/response semantics: 428 on the single endpoint, per-item `GUARDIAN_OTP_REQUIRED` on the bulk endpoint.
- **Risk:** two hot paths. Mitigation: one shared helper (tested in isolation, Task 1), explicit adult-no-regression assertions in both integration tests, and re-running the existing action suites.
- **Action version:** Phase 2 did not variant-split `category:'action'` — so the guardian action row uses the existing action version with `metadata.variant='u18'`. If product later wants distinct u18 action statements, extend the resolver (out of scope here).
- **Open:** the accept-side `wardUserId` is the accepting party — confirm during Task 3 that the minor check applies to whichever party is a minor (the accepting minor needs guardian consent to accept; a minor initiator was already gated at perform). Document the resolved semantics in the handler.
