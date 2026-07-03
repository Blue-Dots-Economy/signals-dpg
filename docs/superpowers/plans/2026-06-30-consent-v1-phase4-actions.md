# Consent v1 — Phase 4: Connect/apply action consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Move connect/apply consent text out of `network.json` into `consent.json`, record per-action consent as `consent_record` rows (initiate + accept), and drive required-ness from `reveals_pii_on_status` — retiring the inline `consent_text_initiator`/`consent_text_receiver` fields.

**Architecture:** UI-merge + backend-ledger. Required-ness stays **server-enforced** via `reveals_pii_on_status` (network.json). The consent **statement** is sourced by the UI from `consent.json` (`actions[action_type].initiate|accept`); the UI sends `{ acknowledged, version, brand }`. The backend records the `consent_record` row where the action lives and keeps the `action_events.event_payload` snapshot (now storing `version` instead of `text`).

**Tech Stack:** Fastify + Zod + Drizzle; React 19; vitest.

## Global Constraints

- Files & DB columns snake_case; route exports snake_case, internal fns camelCase; Zod PascalCase.
- ESM only, strict TS, no `any`, `import type`; no `// TODO`, no `console.log` in library code. Routes never throw.
- **Action consent is ALWAYS asked** each time (initiate/accept) when required — no version-skip.
- **Required-ness (server-enforced, replaces the removed text-presence check):**
  - **Initiate:** required iff `interaction.reveals_pii_on_status.length > 0`.
  - **Accept:** required iff `interaction.reveals_pii_on_status.includes(target_status)`.
  This preserves today's exact gating for all shipped configs (blue_dot/purple_dot declared reveals + text together; yellow_dot/inter-network declared neither).
- `consent_record` action rows: `level:'item'`, `consentCategory:'action'`, `action_type`, `action_stage:'initiate'|'accept'`, `userId`, `itemId`, `action_id`, `network`, `brand`, `documentVersion`, `source:'action'`.
- The consent payload becomes `{ acknowledged: true, version: number, brand?: string | null }` — **`text` is removed**.
- `network` derived server-side from the action; `version`/`brand` client-supplied.

## Interfaces from earlier phases (on branch)

- `consent_record` table (`@api/db/postgres/schema`).
- `consent.json` served + merged: `config.actions?.[action_type]?.initiate|accept = { current_version, versions:[{version, statement, effective_from}] }`. `useConsentConfig()` returns the merged config (UI).
- `ConsentAckSchema` in `packages/schemas/src/api/action_schemas.ts` (currently `{ acknowledged: literal true, text }`), used by `PerformActionBodySchema`, `PerformNetworkActionBodySchema`, `UpdateActionStatusBodySchema`.
- `buildActionEventPayload` in `apps/api/src/utils/action_event_runtime.ts` (embeds `consent: { acknowledged, text, consented_at }`).
- Initiator gate + forward: `apps/api/src/routes/v1/action/perform_action.ts` (checks consent, then `fetch`es the target `/network/action/perform`, gets back `{ action_id }`).
- Target action creation: `apps/api/src/routes/v1/network/action/perform_action.ts` (inserts `item_actions` → `created.action_id`; has `body.source_item_owner`, `body.source_item.item_id`, `body.consent`; builds event via `buildActionEventPayload({..., consent: body.consent})`).
- Receiver: `apps/api/src/routes/v1/action/update_action_status.ts` (has `body.action_id`, target item local, `callerId = request.user.id`).
- UI: `apps/ui/src/components/actions/action-modal.tsx` (initiate; `ACTION_CONSENT_SENTINEL`), `action-status-updater.tsx` + `bulk-status-dialog.tsx` (accept), `apps/ui/src/lib/action-api.ts` (`ConsentAck` payload type), `apps/ui/src/engine/types.ts` (`DotActionSchema`).

---

## Task 1: Backend — rework required-ness, record action consent, retire text in payload/event

**Files:** `packages/schemas/src/api/action_schemas.ts`, `apps/api/src/utils/action_event_runtime.ts`, `apps/api/src/routes/v1/action/perform_action.ts`, `apps/api/src/routes/v1/network/action/perform_action.ts`, `apps/api/src/routes/v1/action/update_action_status.ts`; update tests: `action/__tests__/perform_action.test.ts`, `action/__tests__/update_action_status.test.ts`, `packages/schemas/src/__tests__/action_schemas.test.ts`, `action/__tests__/consent_flow.integration.test.ts`.

- [ ] **Step 1: ConsentAckSchema.** Change to:
```typescript
export const ConsentAckSchema = z
  .object({
    acknowledged: z.literal(true),
    version: z.number().int().min(1),
    brand: z.string().min(1).nullish(),
  })
  .strict();
```
(`PerformActionBodySchema`, `PerformNetworkActionBodySchema`, `UpdateActionStatusBodySchema` reference it — no other edit needed there.)

- [ ] **Step 2: buildActionEventPayload.** Change the `consent` input + output to `version`:
```typescript
  consent?: { acknowledged: true; version: number };
  // ...
  consent: { acknowledged: input.consent.acknowledged, version: input.consent.version, consented_at: new Date().toISOString() },
```

- [ ] **Step 3: Initiator gate (`action/perform_action.ts`).** Replace the two `interaction.consent_text_initiator?.trim()` conditions:
  - Gate: `if (interaction.reveals_pii_on_status.length > 0 && !body.consent?.acknowledged) { throw new BulkItemFailure('CONSENT_REQUIRED', 'Initiator consent acknowledgment required for this action.'); }`
  - Replace the info-log's `consent_text_length: body.consent.text.length` with `consent_version: body.consent.version` (guard on `body.consent?.acknowledged`).

- [ ] **Step 4: Record initiate row (`network/action/perform_action.ts`).** After `const [created] = await db.insert(item_actions)...returning({...})`, and only when `body.consent` present, insert:
```typescript
if (body.consent) {
  try {
    await db.insert(consent_record).values({
      level: 'item',
      consentCategory: 'action',
      actionType: body.action_type,
      actionStage: 'initiate',
      userId: body.source_item_owner,
      itemId: body.source_item.item_id,
      actionId: created.action_id,
      network: body.source_item.item_network,
      brand: body.consent.brand ?? null,
      documentVersion: body.consent.version,
      source: 'action',
      acceptedAt: new Date(),
    });
  } catch (err) {
    request.log.error({ err, action_id: created.action_id }, 'initiate consent write failed');
  }
}
```
Import `consent_record` from `@api/db/postgres/schema`. (`itemId` is a uuid column; `body.source_item.item_id` is a uuid string — fine.) Log-and-continue: never fail action creation on a consent-write error.

- [ ] **Step 5: Receiver gate + record (`update_action_status.ts`).**
  - Required-ness: `const requiresReceiverConsent = interaction.reveals_pii_on_status.includes(body.action_status);` (drop the `&& consent_text_receiver` clause).
  - Replace the info-log `consent_text_length` with `consent_version: body.consent.version`.
  - After the event is stored (where `body.action_id` + the target item id are known), when `requiresReceiverConsent && body.consent?.acknowledged`, insert a `consent_record` row: `level:'item'`, `consentCategory:'action'`, `actionType: <action_type>`, `actionStage:'accept'`, `userId: callerId`, `itemId: <target/receiver item id>`, `actionId: body.action_id`, `network: <target item network>`, `brand: body.consent.brand ?? null`, `documentVersion: body.consent.version`, `source:'action'`, `acceptedAt: new Date()`. (Read the handler to get the correct action_type + target item id variables in scope; they are already loaded for the interaction lookup / event build.) Wrap in try/catch log-and-continue.

- [ ] **Step 6: Pass version through event build.** Where `buildActionEventPayload({..., consent: body.consent})` is called (target perform + update_action_status), `body.consent` now has `{ acknowledged, version, brand }` — the builder reads `version` (Step 2). No further change if the object is passed through; confirm the builder input type matches (`{ acknowledged, version }`).

- [ ] **Step 7: Update tests.** Update the four test files to the new shape:
  - `action_schemas.test.ts`: ConsentAck now `{acknowledged, version}` (not `text`); update valid/invalid cases.
  - `perform_action.test.ts` / `update_action_status.test.ts`: consent payloads use `version`; required-ness now keys off `reveals_pii_on_status` (adjust fixtures/expectations); CONSENT_REQUIRED still thrown when required + omitted.
  - `consent_flow.integration.test.ts`: send `consent: { acknowledged: true, version: 1 }` (drop `text`); assert the `event_payload.consent` now carries `version: 1` (not `text`); the 422 CONSENT_REQUIRED case still holds (purple_dot connect declares `reveals_pii_on_status`). Also assert a `consent_record` row exists for the initiate (level item, action, initiate, action_id).

- [ ] **Step 8: Verify** — `pnpm typecheck`; `pnpm --filter api test` (unit) + `docker compose up -d db redis && pnpm --filter api test:integration consent` (the consent_flow + new assertions). Pass.

- [ ] **Step 9: Commit** — `feat(api): record connect/apply consent rows; drive required-ness from reveals_pii (#99)`

---

## Task 2: Retire `consent_text_*` from network config + schema

**Files:** `packages/schemas/src/network_workflow.ts`, `packages/config/src/network_runtime.ts`, `examples/schemas/blue_dot/network.json`, `examples/schemas/purple_dot/network.json`; update `packages/schemas/src/__tests__/network_workflow.test.ts`.

- [ ] **Step 1: Schema.** In `network_workflow.ts`, remove `consent_text_initiator` and `consent_text_receiver` from `NetworkActionInteractionSchema` and delete the now-unused `ConsentTextSchema`. **Keep `reveals_pii_on_status`** and its superRefine validation.

- [ ] **Step 2: Runtime type.** In `network_runtime.ts`, remove `consent_text_initiator`/`consent_text_receiver` from the `NetworkActionInteraction` type (keep `reveals_pii_on_status` — confirm it's present or add if the type lists it).

- [ ] **Step 3: Configs.** Remove the `consent_text_initiator` / `consent_text_receiver` lines from `examples/schemas/blue_dot/network.json` and `examples/schemas/purple_dot/network.json` (all interactions). Leave `reveals_pii_on_status` intact. (These statements already live in the seeded `consent.json` from Phase 1.)

- [ ] **Step 4: Tests.** Update `network_workflow.test.ts` — remove assertions about `consent_text_*`; keep `reveals_pii_on_status` assertions. Ensure the configs still parse.

- [ ] **Step 5: Verify** — `pnpm typecheck`; `pnpm --filter @dpg/schemas exec vitest run` (network_workflow tests); confirm the network.json files still load (the running app / an existing config-load test). Pass.

- [ ] **Step 6: Commit** — `refactor(config): retire consent_text_* from network.json + schema (#99)`

---

## Task 3: UI — source action statements from consent.json, send version

**Files:** `apps/ui/src/engine/types.ts`, `apps/ui/src/lib/action-api.ts`, `apps/ui/src/components/actions/action-modal.tsx`, `apps/ui/src/components/actions/action-status-updater.tsx`, `apps/ui/src/components/actions/bulk-status-dialog.tsx`.

- [ ] **Step 1: Types.** `engine/types.ts` `DotActionSchema`: remove `consent_text_initiator` / `consent_text_receiver` (keep `reveals_pii_on_status`). `action-api.ts`: change the consent payload type from `{ acknowledged: true; text: string }` to `{ acknowledged: true; version: number; brand?: string | null }` (both in `PerformActionPayload` and `UpdateActionStatusPayload`, and the `ACTION_CONSENT_SENTINEL` value shape).

- [ ] **Step 2: Initiate (`action-modal.tsx`).** Replace `const consentText = (actionSchema.consent_text_initiator ?? '').trim();` with the statement sourced from the merged consent config: `const { config } = useConsentConfig(); const { brand } = useNetworkTheme(); const initDoc = config?.actions?.[actionType]?.initiate; const initVersion = initDoc?.versions.find(v => v.version === initDoc.current_version); const consentText = initVersion?.statement ?? '';`. Required-ness: `const consentRequired = (actionSchema.reveals_pii_on_status?.length ?? 0) > 0;` — gate the submit on `consentRequired && !consentChecked` (as today). When submitting with consent, set the sentinel payload to `{ acknowledged: true, version: initDoc!.current_version, brand: brand === 'standard' ? null : brand }`. Show the `ConsentCheckbox` with `consentText` only when `consentRequired` (as today). (If `initDoc` is absent but `consentRequired` is true, the statement is empty — render nothing/fallback; the gate still requires the checkbox. Acceptable — matches the config-driven design; log nothing.)

- [ ] **Step 3: Accept (`action-status-updater.tsx` + `bulk-status-dialog.tsx`).** Replace `const consentText = (interaction?.consent_text_receiver ?? '').trim();` with `config?.actions?.[action_type]?.accept` current-version statement (via `useConsentConfig`). `requiresConsent = (interaction?.reveals_pii_on_status ?? []).includes(targetStatus)` (drop the `&& consentText !== ''`). Payload: `{ acknowledged: true, version: acceptDoc!.current_version, brand }` instead of `{ acknowledged, text }`.

- [ ] **Step 4: Verify** — `pnpm typecheck`; `pnpm --filter ui exec tsc --noEmit`; run existing action-related UI tests (if any) — don't break them. Pass.

- [ ] **Step 5: Commit** — `feat(ui): source action consent from consent.json + send version (#99)`

---

## Phase 4 Done — Verification

- `pnpm typecheck` clean; `pnpm --filter api test` + `test:integration consent` pass (consent_flow updated: version snapshot + `consent_record` initiate row); schemas/network tests pass.
- Controller end-to-end (blue_dot): initiate a connect/apply → consent checkbox shows the statement from `consent.json`, required when the action reveals PII; on submit an `action`/`initiate` `consent_record` row is written with `action_id`; accept the request → an `action`/`accept` row is written; `network.json` no longer contains `consent_text_*`; PII reveal still gated by `reveals_pii_on_status`.

## Notes

- Recording placement: **initiate** row is written on the instance that creates the action (`network/action/perform_action.ts`), using the forwarded `source_item_owner` + `source_item.item_id` + returned `action_id`; **accept** row on the instance that owns the action (`update_action_status.ts`). In single-instance deployments these are the same DB.
- `event_payload.consent` now stores `version` (not `text`) — this is a deliberate shape change; the `consent_flow` integration test asserts the new shape.
- Consent-write failures never roll back the action/event (log-and-continue) — deliberate v1 policy, consistent with Phase 3.
- Per-interaction statement overrides (spec §4) are NOT used in v1 UI — action-level `initiate`/`accept` statements are used. `purple_dot`'s per-interaction wording differences are collapsed to the action-level statement in `consent.json`; revisit if per-interaction text is required.
