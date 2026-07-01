# Consent v1 — Phase 3: Profile-creation consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** When a user creates their profile, show the `profile_creation` consent statement + an "I agree" checkbox above the submit — the checkbox appears only once all required fields validate clean, and the submit stays disabled until the form is valid AND the checkbox is checked. On submit, record a `profile_creation` `consent_record` row (item-level) tied to the new item.

**Architecture:** UI-merge + backend-ledger. The UI reads the merged `consent.json` (`documents.profile_creation`) for the statement + `current_version`, gates the profile form, and sends `consent` in the create payload; the backend writes the row after the item is created (real `item_id`).

**Tech Stack:** Fastify + Zod + Drizzle; React 19 + RJSF (`@rjsf/shadcn` + `@rjsf/validator-ajv8`); vitest.

## Global Constraints

- Files & DB columns snake_case; route handler exports snake_case, internal fns camelCase; Zod PascalCase.
- ESM only, strict TS, no `any`, `import type`; no `// TODO`, no `console.log` in library code. Routes never throw.
- **Profile-creation consent is ALWAYS asked** on create (no version-skip). Only on **create**, not edit.
- Checkbox **never pre-checked**; submit disabled until **valid AND checked**; the checkbox is **hidden until all required fields validate clean**.
- `consent_record` row for this: `level:'item'`, `consentCategory:'profile_creation'`, `userId`, `itemId` (new item), `network`, `brand` (client-supplied), `documentVersion`, `source:'profile'`.
- `network` derived server-side from the created item; `version`/`brand` client-supplied.

## Interfaces from earlier phases (on branch — reuse, don't rebuild)

- `consent_record` table (`@api/db/postgres/schema`), columns incl. `level, consentCategory, userId, itemId, network, brand, documentVersion, source, acceptedAt`.
- `useConsentConfig()` (`apps/ui/src/hooks/use-consent-config.ts`) → `{ config, isLoading }`; `config.documents.profile_creation = { current_version, versions: [{ version, statement, effective_from }] }`.
- `useNetworkTheme()` → `{ themeId, brand }`.
- Reusable `ConsentCheckbox` at `apps/ui/src/components/actions/consent-checkbox.tsx`: props `{ text, checked, onCheckedChange, id? }` (renders statement + checkbox + "I agree").
- `create_item_handler` (`apps/api/src/routes/v1/item/create_item.ts`): after `createItemInternal(db, {...})` → `created.itemId`; returns `{ item_type, item_id }` at 201. `callerId = request.user?.id`.
- `CreateItemBodySchema` in `packages/schemas/src/api/item_schemas.ts`.
- `SchemaForm` (`apps/ui/src/components/forms/schema-form.tsx`): wraps RJSF `Form` with `validator` (from `@rjsf/validator-ajv8`), props incl. `schema, onSubmit, disabled, id`; RJSF submit configured via `ui:submitButtonOptions`.
- `profile-form-page.tsx` (`apps/ui/src/pages/profile-form-page.tsx`): renders `<SchemaForm .../>`, has `handleSubmit`, `isEdit`, `selectedDomain`, `network.id`, builds `CreateItemPayload` → `createItem` (`apps/ui/src/lib/item-api.ts`).

---

## File Structure

- Modify `packages/schemas/src/api/item_schemas.ts` — add optional `consent` to `CreateItemBodySchema`.
- Modify `apps/api/src/routes/v1/item/create_item.ts` — write the `profile_creation` row post-create.
- Modify `apps/ui/src/components/forms/schema-form.tsx` — add optional `hideSubmit` + `onValidityChange` props (backward-compatible).
- Modify `apps/ui/src/pages/profile-form-page.tsx` — consent footer + gated external submit + consent in payload.
- Modify `apps/ui/src/lib/item-api.ts` — add `consent?` to `CreateItemPayload`.
- Tests: `apps/api/.../create_item` integration (consent row); `schema-form` validity unit test.

---

## Task 1: Backend — record profile_creation consent on item create

**Files:** modify `packages/schemas/src/api/item_schemas.ts`, `apps/api/src/routes/v1/item/create_item.ts`; test in `apps/api/src/routes/v1/item/__tests__/` (add to or create a create_item consent integration test).

**Interfaces produced:** `CreateItemBodySchema` gains optional `consent: { category: 'profile_creation'; version: number; brand?: string | null }`. On a successful create with `consent` present, one `consent_record` row is written (`level:'item'`, `source:'profile'`, `itemId` = new item).

- [ ] **Step 1: Schema.** In `item_schemas.ts`, add to `CreateItemBodySchema.extend({...})`:
```typescript
  consent: z
    .object({
      category: z.literal('profile_creation'),
      version: z.number().int().min(1),
      brand: z.string().min(1).nullish(),
    })
    .optional(),
```

- [ ] **Step 2: Write the row.** In `create_item_handler`, after the item is created (where `created.itemId` is available, before/after building the 201 response) and only when `body.consent` is present: insert into `consent_record`:
```typescript
if (body.consent) {
  try {
    await db.insert(consent_record).values({
      level: 'item',
      consentCategory: 'profile_creation',
      userId: callerId,
      itemId: created.itemId,
      network: body.item_network,
      brand: body.consent.brand ?? null,
      documentVersion: body.consent.version,
      source: 'profile',
      acceptedAt: new Date(),
    });
  } catch (err) {
    request.log.error({ err, itemId: created.itemId }, 'profile consent write failed');
    // Do not fail item creation on consent-write error; log for reconciliation.
  }
}
```
Import `consent_record` from `@api/db/postgres/schema`. (Item creation must not be rolled back if only the consent write fails — the item exists; log-and-continue. This is the deliberate v1 policy.)

- [ ] **Step 3: Integration test** — create an item with `consent: { category:'profile_creation', version:1 }` → assert 201 AND a `consent_record` row exists with `level:'item'`, `consentCategory:'profile_creation'`, `itemId` = returned id, `source:'profile'`. Also a create WITHOUT consent → 201 and no consent row. Follow the existing create_item test harness.

- [ ] **Step 4: Verify** — `pnpm typecheck`; `docker compose up -d db redis && pnpm --filter api test:integration create_item`. Pass.

- [ ] **Step 5: Commit** — `feat(api): record profile_creation consent on item create (#99)`

---

## Task 2: UI — SchemaForm validity + hide-submit hooks

**Files:** modify `apps/ui/src/components/forms/schema-form.tsx`; test `apps/ui/src/components/forms/__tests__/schema-form-validity.test.tsx` (or a pure helper test).

**Interfaces produced:** `SchemaForm` gains two optional, backward-compatible props:
- `hideSubmit?: boolean` — when true, set `ui:submitButtonOptions` to `{ norender: true }` so RJSF renders no submit button (an external button drives submission via `form={id}`).
- `onValidityChange?: (isValid: boolean) => void` — called whenever form data changes (and once on mount) with the AJV validity of the current data.

- [ ] **Step 1: Validity computation.** In `schema-form.tsx`, compute validity using the existing `validator` (`@rjsf/validator-ajv8`): `validator.isValid(rjsfSchema, data, rjsfSchema)`. Call `onValidityChange` inside the existing `onChange` handler (after `setData`) and once in a `useEffect` on mount / when `data`/`rjsfSchema` change. Guard: only compute when `onValidityChange` is provided.

- [ ] **Step 2: hideSubmit.** When `hideSubmit` is true, merge `norender: true` into `uiSchema['ui:submitButtonOptions']` (keep existing className logic for the non-hidden case). Default false → existing behavior unchanged.

- [ ] **Step 3: Test.** Unit-test that (a) `onValidityChange(false)` fires when required fields are empty and `onValidityChange(true)` when filled (drive via rendering `SchemaForm` with a small `{ required:['name'], properties:{name:{type:'string',minLength:1}} }` schema and simulating input), OR extract the `validator.isValid(...)` call into a tiny exported pure helper `isFormValid(validator, schema, data)` and unit-test that directly (preferred — deterministic). (b) `hideSubmit` results in no submit button rendered.

- [ ] **Step 4: Verify** — `pnpm typecheck`; run the test. Pass. Confirm existing SchemaForm consumers (item forms) are unaffected (props are optional/defaulted).

- [ ] **Step 5: Commit** — `feat(ui): schema-form validity callback + hideSubmit (#99)`

---

## Task 3: UI — profile-form consent footer + gated submit

**Files:** modify `apps/ui/src/pages/profile-form-page.tsx`, `apps/ui/src/lib/item-api.ts`.

**Interfaces consumed:** `SchemaForm` (`hideSubmit`, `onValidityChange`, `id`), `useConsentConfig` (returns `{ config, isLoading }` → use `isLoading` as `consentLoading`), `useNetworkTheme`, `ConsentCheckbox`, `createItem`. Define `consentRequired = !isEdit && !!statement` (statement from the loaded `profile_creation` doc).

- [ ] **Step 1: Payload type.** In `item-api.ts`, add to `CreateItemPayload`: `consent?: { category: 'profile_creation'; version: number; brand?: string | null }`.

- [ ] **Step 2: Consent state + config.** In `profile-form-page.tsx` (create mode only — `!isEdit`): `const { config } = useConsentConfig(); const { themeId, brand } = useNetworkTheme();` Derive `const profileDoc = config?.documents.profile_creation; const profileVersion = profileDoc?.versions.find(v => v.version === profileDoc.current_version); const statement = profileVersion?.statement ?? '';`. Add state: `const [formValid, setFormValid] = React.useState(false); const [consentChecked, setConsentChecked] = React.useState(false);`

- [ ] **Step 3: Gate the form.** Pass to `<SchemaForm>`: `hideSubmit={!isEdit}` (only gate on create; edit keeps its normal submit), `onValidityChange={!isEdit ? setFormValid : undefined}`, and ensure a stable `id` (e.g. `id="profile-form"`). Below the SchemaForm, in create mode, render a footer:
  - When `formValid && statement`: render `<ConsentCheckbox text={statement} checked={consentChecked} onCheckedChange={setConsentChecked} />`.
  - A submit button `type="submit" form="profile-form"` styled `bg-brand-cta hover:brightness-110 ...` (match the app CTA), disabled unless the form is valid AND (consent not required OR checkbox checked) AND consent config has finished loading: `disabled={!formValid || consentLoading || (consentRequired && !consentChecked)}`. This external button submits the RJSF form (triggering validation → `handleSubmit`). The `consentLoading` guard prevents an eager submit before we know whether consent is required.
  - (Edit mode: unchanged — RJSF's own submit still renders.)

- [ ] **Step 4: Include consent in create payload.** In `handleSubmit`, for the create branch (not edit), add to `createPayload`: `consent: { category: 'profile_creation', version: profileDoc?.current_version ?? 1, brand: brand === 'standard' ? null : brand }`. (Only when `profileDoc` exists; if the network has no consent config, omit consent — the form still submits, no gate. Mirror Phase 2's fail-open-for-missing-config stance: if there's no `profile_creation` doc, do NOT hide the submit / require the checkbox — treat as no-consent-required. Implement: `const consentRequired = !isEdit && !!statement;` drive `hideSubmit`/footer/gating off `consentRequired`.)

- [ ] **Step 5: Verify** — `pnpm typecheck`; `pnpm --filter ui exec tsc --noEmit`. No new unit test required (behavior verified end-to-end by controller), but do not break existing tests. Manually reason through: empty form → no checkbox, submit disabled; fill required → checkbox appears, submit still disabled; check box → submit enabled; submit → item created + consent row.

- [ ] **Step 6: Commit** — `feat(ui): profile-creation consent gate + record on submit (#99)`

---

## Phase 3 Done — Verification

- `pnpm typecheck` clean; backend create_item consent integration test passes; schema-form validity test passes.
- Controller end-to-end: on `/profile/new`, checkbox hidden until required fields valid; submit disabled until valid+checked; on submit a `profile_creation` row (level item, source profile) is written with the new `item_id`; editing an existing profile shows no consent gate; a network with no `profile_creation` config still lets profile creation proceed (no gate).

## Notes

- Consent-write failure does NOT roll back item creation (log-and-continue) — the item is the user's primary action; the consent row is reconciled from logs if it ever fails. Deliberate v1 policy.
- If `useConsentConfig` hasn't loaded yet when create mode renders, `statement` is empty → `consentRequired` false → the submit is not gated. Once config loads, the gate engages. Acceptable; the config is fast/cached. (If a stricter "wait for config before allowing submit" is desired, gate the submit additionally on `config` presence — optional.)
