# Connect-Flow Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the schema-driven action-create form (and the receiver's status dropdown) with a single configurable consent checkbox, gated server-side, with the consent text snapshot persisted in the event payload as an audit record.

**Architecture:** Two new optional fields on `NetworkActionInteractionSchema` (`consent_text_initiator`, `consent_text_receiver`) drive a server-enforced gate on `perform_action` and `update_action_status`. The consent acknowledgement (text snapshot + server-stamped timestamp) lands in `event_payload.consent`, parallel to `status`/`remark`. UI gets a new `<ConsentCheckbox>` primitive; `<ActionModal>` and `<ActionStatusUpdater>` render the consent path when configured. The receiver's status dropdown is removed — action-card buttons from PR #36 already pre-select the status. The cross-instance gate fires at user-facing entry only; mirror endpoints propagate the snapshot.

**Tech Stack:** TypeScript, Zod, Fastify, React 19, Vitest, Drizzle ORM. Monorepo with `@dpg/*` workspace alias.

**Branch:** This plan builds on PR #36 (action-card status buttons). Branch from `feature` (the integration branch that holds PR #36), name it `feat/connect-flow-consent`. The spec is already committed locally on `feature` at `d8c3251`; cherry-pick or rebase as appropriate before starting.

**Spec:** `docs/superpowers/specs/2026-05-31-connect-flow-consent-design.md` (read it before starting).

---

### Task 1: Branch setup

**Files:** none (git operations only)

- [ ] **Step 1: Confirm starting point**

```bash
git fetch origin
git log -1 origin/feature --oneline
# Expected: c70b86e (or newer) — PR #36 merged
```

- [ ] **Step 2: Cut new branch from feature**

```bash
git checkout -b feat/connect-flow-consent origin/feature
```

- [ ] **Step 3: Ensure the spec commit is present**

```bash
git log --oneline | head -3
# If 'docs: connect-flow consent simplification spec' (d8c3251) is missing,
# cherry-pick it from the brainstorming session:
#   git cherry-pick d8c3251
```

- [ ] **Step 4: Push the branch + verify clean tree**

```bash
git push -u origin feat/connect-flow-consent
git status
# Expected: nothing to commit, working tree clean
```

---

### Task 2: Schemas — `consent_text_*` fields on `NetworkActionInteractionSchema`

**Files:**
- Modify: `packages/schemas/src/network_workflow.ts`
- Test: `packages/schemas/src/__tests__/network_workflow.test.ts`

- [ ] **Step 1: Write failing tests**

Add these tests at the end of the existing `describe` block in `packages/schemas/src/__tests__/network_workflow.test.ts`. Adapt the fixture builder to match the existing helper in that file (look for `buildInteraction` or equivalent — copy the existing pattern).

```ts
it('parses an interaction with both consent_text fields', () => {
  const parsed = NetworkActionInteractionSchema.parse({
    ...validInteractionFixture(),
    consent_text_initiator: 'I agree to share my PII with this provider.',
    consent_text_receiver: 'I agree to share my PII with the requester.',
  });
  expect(parsed.consent_text_initiator).toBe('I agree to share my PII with this provider.');
  expect(parsed.consent_text_receiver).toBe('I agree to share my PII with the requester.');
});

it('parses an interaction with neither consent_text field (back-compat)', () => {
  const parsed = NetworkActionInteractionSchema.parse(validInteractionFixture());
  expect(parsed.consent_text_initiator).toBeUndefined();
  expect(parsed.consent_text_receiver).toBeUndefined();
});

it('rejects whitespace-only consent_text', () => {
  expect(() =>
    NetworkActionInteractionSchema.parse({
      ...validInteractionFixture(),
      consent_text_initiator: '   ',
    })
  ).toThrow();
});

it('rejects consent_text longer than 500 chars', () => {
  expect(() =>
    NetworkActionInteractionSchema.parse({
      ...validInteractionFixture(),
      consent_text_initiator: 'x'.repeat(501),
    })
  ).toThrow();
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm --filter @dpg/schemas test -- network_workflow
# Expected: 4 new tests fail (field unknown / no validation)
```

- [ ] **Step 3: Add the fields to the schema**

In `packages/schemas/src/network_workflow.ts`, near the existing `NetworkActionInteractionSchema` declaration (around line 122):

```ts
const ConsentTextSchema = z.string().trim().min(1).max(500);
```

Then inside the `z.object({...})` body for `NetworkActionInteractionSchema`, alongside `reveals_pii_on_status`, add:

```ts
consent_text_initiator: ConsentTextSchema.optional(),
consent_text_receiver: ConsentTextSchema.optional(),
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm --filter @dpg/schemas test -- network_workflow
# Expected: all green, no regressions on existing tests
```

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/network_workflow.ts packages/schemas/src/__tests__/network_workflow.test.ts
git commit -m "feat(schemas): consent_text_initiator/receiver on NetworkActionInteractionSchema"
```

---

### Task 3: Schemas — `ConsentAckSchema` + extend action body schemas

**Files:**
- Modify: `packages/schemas/src/api/action_schemas.ts`
- Create: `packages/schemas/src/__tests__/action_schemas.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/schemas/src/__tests__/action_schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ConsentAckSchema,
  PerformActionBodySchema,
  UpdateActionStatusBodySchema,
} from '../api/action_schemas';

describe('ConsentAckSchema', () => {
  it('accepts a valid consent acknowledgement', () => {
    const parsed = ConsentAckSchema.parse({
      acknowledged: true,
      text: 'I agree to share my PII.',
    });
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.text).toBe('I agree to share my PII.');
  });

  it('rejects acknowledged:false', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: false, text: 'I agree.' })
    ).toThrow();
  });

  it('rejects empty / whitespace text', () => {
    expect(() => ConsentAckSchema.parse({ acknowledged: true, text: '' })).toThrow();
    expect(() => ConsentAckSchema.parse({ acknowledged: true, text: '   ' })).toThrow();
  });

  it('rejects text longer than 500 chars', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: true, text: 'x'.repeat(501) })
    ).toThrow();
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: true, text: 'ok', extra: 1 })
    ).toThrow();
  });
});

describe('PerformActionBodySchema with consent', () => {
  it('accepts a body without consent (back-compat)', () => {
    const parsed = PerformActionBodySchema.parse({
      action_type: 'connect',
      source_item: { item_network: 'n', item_domain: 'd', item_type: 't', item_id: 'i' },
      target_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: 'i',
        item_instance_url: 'http://x',
      },
      requirements_snapshot: {},
    });
    expect(parsed.consent).toBeUndefined();
  });

  it('accepts a body with a valid consent block', () => {
    const parsed = PerformActionBodySchema.parse({
      action_type: 'connect',
      source_item: { item_network: 'n', item_domain: 'd', item_type: 't', item_id: 'i' },
      target_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: 'i',
        item_instance_url: 'http://x',
      },
      requirements_snapshot: {},
      consent: { acknowledged: true, text: 'I agree.' },
    });
    expect(parsed.consent?.acknowledged).toBe(true);
  });
});

describe('UpdateActionStatusBodySchema with consent', () => {
  it('accepts a body without consent', () => {
    const parsed = UpdateActionStatusBodySchema.parse({
      action_id: '00000000-0000-0000-0000-000000000000',
      action_status: 'rejected',
    });
    expect(parsed.consent).toBeUndefined();
  });

  it('accepts a body with consent + remarks coexisting', () => {
    const parsed = UpdateActionStatusBodySchema.parse({
      action_id: '00000000-0000-0000-0000-000000000000',
      action_status: 'accepted',
      remarks: 'optional note',
      consent: { acknowledged: true, text: 'I agree.' },
    });
    expect(parsed.remarks).toBe('optional note');
    expect(parsed.consent?.acknowledged).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm --filter @dpg/schemas test -- action_schemas
# Expected: imports fail (ConsentAckSchema doesn't exist), and consent fields missing
```

- [ ] **Step 3: Add the schema and extend the body schemas**

In `packages/schemas/src/api/action_schemas.ts`, near the top exports, add:

```ts
export const ConsentAckSchema = z
  .object({
    acknowledged: z.literal(true),
    text: z.string().trim().min(1).max(500),
  })
  .strict();

export type ConsentAck = z.infer<typeof ConsentAckSchema>;
```

Then extend all three body schemas in this file (search the file for `BodySchema` to locate them):

```ts
export const PerformActionBodySchema = z.object({
  // …existing fields…
  requirements_snapshot: z.record(z.unknown()),
  consent: ConsentAckSchema.optional(),
});

export const PerformNetworkActionBodySchema = z.object({
  // …existing fields (this is the cross-instance mirror body)…
  consent: ConsentAckSchema.optional(),
});

export const UpdateActionStatusBodySchema = z.object({
  action_id: z.string().uuid(),
  action_status: z.string(),
  remarks: z.string().optional(),
  consent: ConsentAckSchema.optional(),
});
```

Add one more test to `action_schemas.test.ts` covering the mirror body:

```ts
describe('PerformNetworkActionBodySchema with consent', () => {
  it('accepts a body with consent (passed through from initiator instance)', () => {
    // Build a minimal valid fixture matching the existing schema's required fields
    // (action_type, source_item, target_item, requirements_snapshot, source_item_owner, …).
    // Then add consent and assert it parses.
  });
});
```

(Concretely match the existing required fields by reading them off the schema first — they're already shown in the same file you're editing.)

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm --filter @dpg/schemas test
# Expected: all green (existing + new tests)
```

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/api/action_schemas.ts packages/schemas/src/__tests__/action_schemas.test.ts
git commit -m "feat(schemas): ConsentAckSchema + consent field on action body schemas"
```

---

### Task 4: Schemas — export `ConsentAckSchema` from the package root

**Files:**
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Add the export**

In `packages/schemas/src/index.ts`, add to the exports that re-export from `./api/action_schemas`:

```ts
export { ConsentAckSchema, type ConsentAck } from './api/action_schemas';
```

(Match the existing export style — if the file uses `export *` re-exports, this is already in. Check first.)

- [ ] **Step 2: Verify the symbol is importable**

```bash
pnpm --filter api exec tsc --noEmit
# Expected: clean
```

- [ ] **Step 3: Commit**

```bash
git add packages/schemas/src/index.ts
git commit -m "chore(schemas): export ConsentAckSchema from package root"
```

---

### Task 5: API — extend `buildActionEventPayload` with consent + add `consent` to system keys

**Files:**
- Modify: `apps/api/src/utils/action_event_runtime.ts`
- Test: there is no dedicated test for this helper today; coverage lands via the route tests in Tasks 6 and 8. Add a focused unit test in `apps/api/src/utils/__tests__/action_event_runtime.test.ts` (create file if absent).

- [ ] **Step 1: Write failing test**

In `apps/api/src/utils/__tests__/action_event_runtime.test.ts` (create if missing):

```ts
import { describe, expect, it } from 'vitest';
import { buildActionEventPayload } from '../action_event_runtime';

describe('buildActionEventPayload consent', () => {
  const ctx = {
    action_type: 'connect',
    source_item: { item_network: 'n', item_domain: 'd', item_type: 't', item_id: 'i', item_instance_url: 'http://x' },
    target_item: { item_network: 'n', item_domain: 'd', item_type: 't', item_id: 'i', item_instance_url: 'http://x' },
    requirements_snapshot: {},
  };

  it('omits consent when none provided', () => {
    const payload = buildActionEventPayload({
      action_status: 'accepted',
      remarks: null,
      context: ctx,
    });
    expect(payload.consent).toBeUndefined();
  });

  it('includes consent + server-stamped consented_at when provided', () => {
    const payload = buildActionEventPayload({
      action_status: 'accepted',
      remarks: null,
      context: ctx,
      consent: { acknowledged: true, text: 'I agree.' },
    });
    expect(payload.consent).toMatchObject({
      acknowledged: true,
      text: 'I agree.',
    });
    expect(typeof (payload.consent as Record<string, unknown>).consented_at).toBe('string');
    expect(Number.isNaN(Date.parse(((payload.consent as Record<string, string>).consented_at)))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
pnpm --filter api exec vitest run src/utils/__tests__/action_event_runtime.test.ts
# Expected: TypeScript error or runtime failure — consent isn't accepted yet
```

- [ ] **Step 3: Extend the helper and the system-keys list**

In `apps/api/src/utils/action_event_runtime.ts`:

```ts
// line ~27 — extend the system keys list
const actionEventSystemPayloadKeys = ['status', 'remark', 'consent'] as const;
```

```ts
// line ~200 — extend buildActionEventPayload signature + body
export function buildActionEventPayload(input: {
  event_schema?: Record<string, unknown>;
  action_status: string;
  remarks?: string | null;
  context: ActionEventPayloadContext;
  consent?: { acknowledged: true; text: string };
}): Record<string, unknown> {
  const base = {
    ...projectEventPayloadFromSchema(input.event_schema, input.context),
    status: input.action_status,
    remark: input.remarks ?? defaultActionEventRemark(input.action_status),
  };
  if (!input.consent) return base;
  return {
    ...base,
    consent: {
      acknowledged: input.consent.acknowledged,
      text: input.consent.text,
      consented_at: new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm --filter api test
# Expected: all existing tests + 2 new tests pass (176+2=178 if no other tasks have run yet)
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils/action_event_runtime.ts apps/api/src/utils/__tests__/action_event_runtime.test.ts
git commit -m "feat(api): event payload carries consent snapshot with server-stamped timestamp"
```

---

### Task 6: API — `perform_action.ts` initiator consent gate + forward to mirror

**Files:**
- Modify: `apps/api/src/routes/v1/action/perform_action.ts`
- Test: `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`. Find the existing `describe('perform_action_handler', ...)` block and add inside it (or in a sibling describe):

```ts
describe('initiator consent gate', () => {
  // Helper: mock `getActionInteraction` to return an interaction declaring
  // consent_text_initiator. Reuse whatever mocking helper already exists in
  // this file for swapping interactions.
  // (Look for existing tests that customize the interaction return — copy that pattern.)

  it('returns 403 CONSENT_REQUIRED when interaction declares consent_text_initiator but body has no consent', async () => {
    mockInteraction({ consent_text_initiator: 'I agree to share my PII.' });
    const reply = await invokeHandler({
      // …same body fixture used by other tests…
      consent: undefined,
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error).toBe('CONSENT_REQUIRED');
  });

  it('forwards the consent block to /network/action/perform when supplied', async () => {
    mockInteraction({ consent_text_initiator: 'I agree.' });
    const fetchSpy = mockNetworkFetch({ ok: true, status: 201, body: { action_id: 'x' } });
    await invokeHandler({
      // …body…
      consent: { acknowledged: true, text: 'I agree.' },
    });
    const forwardedBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(forwardedBody.consent).toEqual({ acknowledged: true, text: 'I agree.' });
  });

  it('does not gate when interaction has no consent_text_initiator (back-compat)', async () => {
    mockInteraction({ consent_text_initiator: undefined });
    mockNetworkFetch({ ok: true, status: 201, body: { action_id: 'x' } });
    const reply = await invokeHandler({ /* body */ consent: undefined });
    expect(reply.statusCode).toBe(201);
  });
});
```

(If the file's existing tests use different fixture/mocking helpers, follow that style — these test bodies should mirror the structure of the existing `perform_action.test.ts` tests, just with the new assertions.)

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts
# Expected: 3 new tests fail (no gate yet; consent isn't forwarded)
```

- [ ] **Step 3: Add the gate and forward consent**

In `apps/api/src/routes/v1/action/perform_action.ts`:

After the existing `const interaction = getActionInteraction(...)` call (around line 142-150), insert before the `requirementsSnapshot = mergeItemStateWithPrivate(...)` call:

```ts
if (interaction.consent_text_initiator?.trim() && !body.consent?.acknowledged) {
  return reply.code(403).send({
    error: 'CONSENT_REQUIRED',
    message: 'Initiator consent acknowledgment required for this action.',
  });
}
```

Then in the outgoing fetch body (around line 192-200), add `consent` to the forwarded payload:

```ts
body: JSON.stringify({
  action_type: body.action_type,
  source_item: sourceItem,
  target_item: targetItem,
  source_item_owner: actor.effective_user_id,
  requirements_snapshot: requirementsSnapshot,
  performed_by_org_id: actor.audit.performed_by_org_id,
  performed_by_service_user_id: actor.audit.performed_by_service_user_id,
  consent: body.consent,
}),
```

(Send `body.consent` verbatim. When undefined, JSON.stringify drops the key; when present, the mirror endpoint receives the literal snapshot the user saw.)

Add a structured log on consent recorded, right after the gate check passes:

```ts
if (body.consent?.acknowledged) {
  request.log.info(
    {
      side: 'initiator',
      action_type: body.action_type,
      target_item_id: body.target_item.item_id,
      consent_text_length: body.consent.text.length,
    },
    'consent recorded',
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts
# Expected: all green
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/action/perform_action.ts apps/api/src/routes/v1/action/__tests__/perform_action.test.ts
git commit -m "feat(api): perform_action enforces initiator consent gate when configured"
```

---

### Task 7: API — `/network/action/perform` mirror persists consent (no re-gate)

**Files:**
- Modify: `apps/api/src/routes/v1/network/action/perform_action.ts`
- Coverage: the route's body schema is already extended in Task 3 via `PerformNetworkActionBodySchema`. End-to-end persistence is exercised by the integration test in Task 15.

- [ ] **Step 1: Locate the `buildActionEventPayload` call**

```bash
grep -n "buildActionEventPayload" apps/api/src/routes/v1/network/action/perform_action.ts
```

There's exactly one call site in this handler (it's where the new action's event is built before `insertActionEvent`).

- [ ] **Step 2: Thread `body.consent` into the call**

Modify the call to add `consent: body.consent`:

```ts
const eventPayload = buildActionEventPayload({
  event_schema: interaction.event_schema,
  action_status: 'created',
  remarks: null,
  context: { /* …existing… */ },
  consent: body.consent,
});
```

Use whatever `action_status` value the existing call already uses (likely `'created'` for the initial action event) — this task only adds the consent line, nothing else.

**Do not** add a consent gate here. The originating instance has already gated; this endpoint trusts the consent block as part of the propagated action.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api exec tsc --noEmit
# Expected: clean
```

- [ ] **Step 4: Run existing tests**

```bash
pnpm --filter api test
# Expected: all green, no regressions (mirror behaviour for non-consent case unchanged)
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/network/action/perform_action.ts
git commit -m "feat(api): network/action/perform mirror persists initiator consent snapshot"
```

---

### Task 8: API — `update_action_status.ts` receiver consent gate + persistence

**Files:**
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`
- Test: `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`. Match the file's existing fixture / mocking style:

```ts
describe('receiver consent gate', () => {
  it('returns 403 CONSENT_REQUIRED when target status is in reveals_pii_on_status and body has no consent', async () => {
    mockInteraction({
      reveals_pii_on_status: ['accepted'],
      consent_text_receiver: 'I agree to share my PII.',
    });
    const reply = await invokeHandler({
      body: { action_id: 'a-1', action_status: 'accepted' },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error).toBe('CONSENT_REQUIRED');
  });

  it('passes through when status is not in reveals_pii_on_status (rejected does not need consent)', async () => {
    mockInteraction({
      reveals_pii_on_status: ['accepted'],
      consent_text_receiver: 'I agree to share my PII.',
    });
    const reply = await invokeHandler({
      body: { action_id: 'a-1', action_status: 'rejected', remarks: 'not a fit' },
    });
    expect(reply.statusCode).toBe(200);
  });

  it('persists consent + remarks coexisting when both supplied on accept', async () => {
    mockInteraction({
      reveals_pii_on_status: ['accepted'],
      consent_text_receiver: 'I agree.',
    });
    const reply = await invokeHandler({
      body: {
        action_id: 'a-1',
        action_status: 'accepted',
        remarks: 'looking forward',
        consent: { acknowledged: true, text: 'I agree.' },
      },
    });
    expect(reply.statusCode).toBe(200);
    // assert via the captured insertActionEvent / db mock that event_payload
    // contains both remark + consent
  });

  it('does not gate when interaction has no consent_text_receiver (back-compat)', async () => {
    mockInteraction({ reveals_pii_on_status: ['accepted'], consent_text_receiver: undefined });
    const reply = await invokeHandler({
      body: { action_id: 'a-1', action_status: 'accepted' },
    });
    expect(reply.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts
# Expected: 4 new tests fail
```

- [ ] **Step 3: Add the gate and pass consent into the event payload**

In `apps/api/src/routes/v1/action/update_action_status.ts`, after the existing `interaction = getActionInteraction(...)` resolution (around line 87-95) and after the status-transition validation (around line 96-101), insert:

```ts
const requiresReceiverConsent =
  interaction.reveals_pii_on_status.includes(body.action_status) &&
  !!interaction.consent_text_receiver?.trim();

if (requiresReceiverConsent && !body.consent?.acknowledged) {
  return reply.code(403).send({
    error: 'CONSENT_REQUIRED',
    message: 'Receiver consent acknowledgment required to transition to this status.',
  });
}
```

Then extend the `buildActionEventPayload(...)` call (around line 103-128) to pass consent through:

```ts
const eventPayload = buildActionEventPayload({
  event_schema: interaction.event_schema,
  action_status: body.action_status,
  remarks: body.remarks,
  context: { /* …existing… */ },
  consent: body.consent,
});
```

Add a structured log mirroring the perform_action one, right after the gate passes when consent is present:

```ts
if (body.consent?.acknowledged) {
  request.log.info(
    {
      side: 'receiver',
      action_id: body.action_id,
      action_status: body.action_status,
      consent_text_length: body.consent.text.length,
    },
    'consent recorded',
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts
# Expected: all green
```

- [ ] **Step 5: Run full API suite**

```bash
pnpm --filter api test
# Expected: all green
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/action/update_action_status.ts apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts
git commit -m "feat(api): update_action_status enforces receiver consent gate on reveal statuses"
```

---

### Task 9: UI — `<ConsentCheckbox>` primitive

**Files:**
- Create: `apps/ui/src/components/actions/consent-checkbox.tsx`

apps/ui has no test infrastructure today — this task ships the component and relies on manual smoke + downstream usage tests via type-checking.

- [ ] **Step 1: Create the component**

Create `apps/ui/src/components/actions/consent-checkbox.tsx`:

```tsx
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

interface ConsentCheckboxProps {
  text: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
}

export function ConsentCheckbox({
  text,
  checked,
  onCheckedChange,
  id = 'consent-acknowledge',
}: ConsentCheckboxProps) {
  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <p className="text-sm text-foreground mb-3 whitespace-pre-line">{text}</p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer leading-snug">
          I agree
        </Label>
      </div>
    </div>
  );
}
```

(Adjust the import paths for Checkbox / Label to match what other action components import — grep the existing `action-modal.tsx` or `action-status-updater.tsx` for the right shadcn paths.)

- [ ] **Step 2: Verify it compiles**

```bash
pnpm --filter ui exec tsc --noEmit
# Expected: clean
```

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/components/actions/consent-checkbox.tsx
git commit -m "feat(ui): ConsentCheckbox primitive for action consent acknowledgement"
```

---

### Task 10: UI — `action-api.ts` extend payload types with consent

**Files:**
- Modify: `apps/ui/src/lib/action-api.ts`

- [ ] **Step 1: Add the consent field to both payload types**

Around lines 92-97 (`PerformActionPayload`) and 115-119 (`UpdateActionStatusPayload`), add:

```ts
export interface PerformActionPayload {
  action_type: string;
  source_item: ActionItemRef;
  target_item: ActionItemRef & { item_instance_url: string };
  requirements_snapshot: Record<string, unknown>;
  consent?: { acknowledged: true; text: string };
}

export interface UpdateActionStatusPayload {
  action_id: string;
  action_status: string;
  remarks?: string;
  consent?: { acknowledged: true; text: string };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter ui exec tsc --noEmit
# Expected: clean
```

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/lib/action-api.ts
git commit -m "feat(ui): action-api payload types carry optional consent block"
```

---

### Task 11: UI — `<ActionModal>` renders consent path conditionally

**Files:**
- Modify: `apps/ui/src/components/actions/action-modal.tsx`

- [ ] **Step 1: Read the file**

```bash
# Familiarise yourself with the existing structure — especially how requirement_schema is rendered, the Submit button's disabled state, and how the submit handler builds the request body.
```

- [ ] **Step 2: Apply the changes**

In `apps/ui/src/components/actions/action-modal.tsx`:

1. Add `import { ConsentCheckbox } from './consent-checkbox';` at the top.
2. Replace the hardcoded subtitle "Share details so the other party can review your request." (around line 36) with conditional rendering — if `consent_text_initiator` is set, that text replaces the subtitle; otherwise the old subtitle remains for back-compat.
3. Add state for the consent checkbox: `const [consentChecked, setConsentChecked] = useState(false);` and a derived `const consentText = actionSchema.consent_text_initiator?.trim() ?? '';` (where `actionSchema` is the existing interaction object the modal already receives).
4. Below the `<SchemaForm>` render (around line 71-80), conditionally render the consent checkbox when `consentText` is non-empty:

```tsx
{consentText && (
  <ConsentCheckbox
    text={consentText}
    checked={consentChecked}
    onCheckedChange={setConsentChecked}
  />
)}
```

5. Update the Submit button's disabled prop to also require `consentChecked` when `consentText` is non-empty:

```tsx
disabled={
  /* …existing schema-form-invalid check… */ ||
  (consentText !== '' && !consentChecked)
}
```

6. In the submit handler that builds the `PerformActionPayload`, add the consent block when applicable:

```tsx
const payload: PerformActionPayload = {
  // …existing fields…
  ...(consentText && consentChecked
    ? { consent: { acknowledged: true as const, text: consentText } }
    : {}),
};
```

The `text` value comes from `consentText` (the variable we already derived from the interaction) — capturing the exact string the user just saw rendered.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter ui exec tsc --noEmit
# Expected: clean
```

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/actions/action-modal.tsx
git commit -m "feat(ui): action modal renders consent checkbox when configured; gates Submit"
```

---

### Task 12: UI — `<ActionStatusUpdater>` status-aware branching, drop dropdown

**Files:**
- Modify: `apps/ui/src/components/actions/action-status-updater.tsx`

- [ ] **Step 1: Re-read the file to understand current shape**

```bash
# Find: where status dropdown is rendered (existing line ~122-133), where remarks Input is (line ~137-144), where the payload is built (line ~101).
```

- [ ] **Step 2: Replace the dropdown form with status-aware branching**

Modify the component to receive (or read from props) the pre-selected status from the action-card button. The card already invokes the updater with a specific status (Accept → 'accepted', Reject → 'rejected', etc.), so the status is known at modal-open time.

1. Import `ConsentCheckbox` and the interaction object (this component should already have access to the interaction's `reveals_pii_on_status` and `consent_text_receiver` — same path as the modal in Task 11).
2. Derive:
   ```tsx
   const requiresConsent =
     interaction.reveals_pii_on_status?.includes(targetStatus) &&
     !!interaction.consent_text_receiver?.trim();
   const consentText = interaction.consent_text_receiver?.trim() ?? '';
   const [consentChecked, setConsentChecked] = useState(false);
   const [remarks, setRemarks] = useState('');
   ```
3. Replace the existing dropdown + remarks form (lines ~119-146) with this branching:

```tsx
{requiresConsent ? (
  <ConsentCheckbox
    text={consentText}
    checked={consentChecked}
    onCheckedChange={setConsentChecked}
  />
) : (
  <div>
    <Label htmlFor="action-remarks">Reason (optional)</Label>
    <Textarea
      id="action-remarks"
      value={remarks}
      onChange={(e) => setRemarks(e.target.value)}
      placeholder="Add a brief note (optional)"
    />
  </div>
)}
```

Use `Textarea` (multi-line) here rather than the old `Input` — reject/cancel reasons can run long. Import from `@/components/ui/textarea`.

4. Update Submit disabled state:

```tsx
disabled={requiresConsent && !consentChecked}
```

5. Update the payload build (line ~101):

```tsx
const payload: UpdateActionStatusPayload = {
  action_id,
  action_status: targetStatus,
  ...(requiresConsent
    ? { consent: { acknowledged: true as const, text: consentText } }
    : remarks.trim()
      ? { remarks: remarks.trim() }
      : {}),
};
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter ui exec tsc --noEmit
# Expected: clean
```

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/actions/action-status-updater.tsx
git commit -m "feat(ui): status-updater branches on reveal status — consent or reason, no dropdown"
```

---

### Task 13: Config — purple_dot empties `requirement_schema.properties` + adds consent texts

**Files:**
- Modify: `examples/schemas/purple_dot/network.json`

- [ ] **Step 1: For every interaction in the file**

For each interaction (search the file for `"requirement_schema"`):

1. Replace `"requirement_schema": { ... fields ... }` with `"requirement_schema": { "type": "object", "properties": {} }`.
2. Alongside `reveals_pii_on_status` (which already exists per PR #37's spec), add:

```jsonc
"consent_text_initiator": "I agree to share my contact details (name, email, phone) with this provider if they accept my request.",
"consent_text_receiver": "I agree to share my contact details (name, email, phone) with the requester."
```

- [ ] **Step 2: Validate the JSON parses + the schema accepts the document**

```bash
pnpm --filter @dpg/schemas test
# The example_network_configs.test.ts fixture will exercise the purple_dot config — expect green.
```

If the network-configs test fails because of structural validation, fix the JSON until it passes.

- [ ] **Step 3: Regenerate the bundled schema if anything depends on it**

```bash
pnpm schema:bundle && pnpm schema:bundle:check
# Expected: bundle matches; if not, commit the regenerated bundle alongside this change.
```

- [ ] **Step 4: Commit**

```bash
git add examples/schemas/purple_dot/network.json
# also any regenerated bundle file under helmcharts/dpg/charts/api/files/
git commit -m "config(purple_dot): consent-only interactions; empty requirement_schemas, add consent texts"
```

---

### Task 14: Config — blue_dot adds consent texts (keeps requirement_schema)

**Files:**
- Modify: `examples/schemas/blue_dot/network.json`

- [ ] **Step 1: For every interaction**

Add the two consent strings beside `reveals_pii_on_status`. The wording differs per action class:

- For `apply` (and any other action that collects domain data via `requirement_schema`):

```jsonc
"consent_text_initiator": "I agree to share my profile contact details with this organization if my application is accepted.",
"consent_text_receiver": "I agree to share my organisation's contact details with the applicant."
```

- For `connect` (and other PII-sharing-only actions):

```jsonc
"consent_text_initiator": "I agree to share my contact details (name, email, phone) with the selected counterparty if they accept my request.",
"consent_text_receiver": "I agree to share my contact details (name, email, phone) with the requester."
```

Do **not** empty `requirement_schema` for blue_dot — `apply` legitimately collects role/age/workExperience.

- [ ] **Step 2: Re-run schema tests + bundle check**

```bash
pnpm --filter @dpg/schemas test
pnpm schema:bundle && pnpm schema:bundle:check
# Expected: green; bundle in sync.
```

- [ ] **Step 3: Commit**

```bash
git add examples/schemas/blue_dot/network.json
# + any regenerated bundle
git commit -m "config(blue_dot): consent_text on every interaction; requirement_schemas unchanged"
```

---

### Task 15: Integration test — consent flow end-to-end

**Files:**
- Create: `apps/api/src/routes/v1/action/__tests__/consent_flow.integration.test.ts`

Requires a running DB + Redis (`docker compose up -d db redis`). Boots the real Fastify app via the existing integration-test harness (model on `get_action_contact_details.integration.test.ts` or `on_behalf_of.integration.test.ts`).

- [ ] **Step 1: Scaffold the test file**

Copy the imports + setup harness from `get_action_contact_details.integration.test.ts`. Add three test cases:

```ts
describe('consent flow integration', () => {
  it('rejects /action/perform with 403 CONSENT_REQUIRED when interaction declares consent_text_initiator and body has no consent', async () => {
    // …seed network config with consent_text_initiator on the relevant interaction…
    // POST /api/v1/action/perform with body lacking `consent`
    // expect 403, error: 'CONSENT_REQUIRED'
  });

  it('persists initiator consent snapshot in event_payload when valid', async () => {
    // POST /api/v1/action/perform with valid consent
    // expect 201
    // SELECT event_payload FROM action_events WHERE action_id = …
    // expect event_payload.consent.acknowledged === true
    // expect event_payload.consent.text === <the literal string we sent>
    // expect event_payload.consent.consented_at is a parseable ISO timestamp
  });

  it('rejects /action/update-status to accepted with 403 when receiver consent missing, then accepts with consent', async () => {
    // First call: action_status='accepted', no consent → 403
    // Second call: action_status='accepted', consent block → 200
    // assert event_payload.consent persisted
  });
});
```

- [ ] **Step 2: Run integration tests locally**

```bash
docker compose up -d db redis
pnpm --filter api test:integration
# Expected: all green (existing + 3 new)
```

If you can't run integration tests locally, mark this test in PR description as "reviewer responsibility" — the existing `get_action_contact_details.integration.test.ts` already gates the encrypted reveal flow, and the route unit tests in Tasks 6 + 8 cover the gate behaviour with mocks.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/v1/action/__tests__/consent_flow.integration.test.ts
git commit -m "test(api): integration coverage for consent gate + event snapshot persistence"
```

---

### Task 16: Final verification + PR

**Files:** none (verification + git operations)

- [ ] **Step 1: Run the full pre-PR suite**

```bash
pnpm typecheck
pnpm --filter @dpg/schemas test
pnpm --filter api test
# All three: expected green
```

- [ ] **Step 2: Manual smoke (matches spec §5)**

```bash
pnpm dev:api & pnpm dev:ui
```

In a browser session, with a purple_dot network active:

- [ ] Search → click Connect on a card → modal shows the configured consent text and a checkbox; Submit disabled. Check the box → Submit enables → click → action created → appears in My Actions.
- [ ] On a peer purple_dot user's My Actions, click Accept on the inbound card → modal shows receiver consent text + checkbox; no dropdown; Submit disabled until checked → Submit succeeds → counterparty name decrypts on the source side's My Actions card (validates wiring with PR #36 + PR #37).
- [ ] On a different inbound action, click Reject → modal shows optional reason textarea (no dropdown) → submit with empty reason succeeds → submit again with a reason persists it.
- [ ] Switch to a blue_dot session, search → click Apply → modal renders the existing role/age/workExperience form AND a consent checkbox below; Submit disabled until both the form is valid AND the checkbox is checked.

If any step fails, return to the relevant task and fix.

- [ ] **Step 3: Push + open PR**

```bash
git push
gh pr create --base feature --head feat/connect-flow-consent --title "feat: consent-checkbox flow on connect + accept; reason on reject" --body "$(cat <<'EOF'
## Summary

Replaces the schema-driven action-create form (and the receiver's status dropdown) with a single configurable consent checkbox, gated server-side, with the consent text snapshot persisted in `event_payload.consent` as audit.

Spec: `docs/superpowers/specs/2026-05-31-connect-flow-consent-design.md`
Plan: `docs/superpowers/plans/2026-05-31-connect-flow-consent.md`

## Test plan

- [x] `pnpm typecheck` — clean
- [x] `pnpm --filter @dpg/schemas test` — all green (new ConsentAckSchema + interaction-field tests)
- [x] `pnpm --filter api test` — all green (new gate tests on perform_action + update_action_status; new buildActionEventPayload tests)
- [ ] **Reviewer**: `pnpm --filter api test:integration` against real DB + Redis (covers `consent_flow.integration.test.ts`)
- [ ] **Reviewer**: manual smoke — purple_dot connect/accept/reject + blue_dot apply with consent gate (see plan Task 16 Step 2)

EOF
)"
```

- [ ] **Step 4: Update plan with PR URL**

After the PR is open, edit the spec's status line at the top of the design doc from `spec — awaiting implementation plan` to `spec — PR #<number> open` and commit:

```bash
git add docs/superpowers/specs/2026-05-31-connect-flow-consent-design.md
git commit -m "docs: link consent spec to implementation PR"
git push
```

---

## Self-review notes (post-plan)

- **Spec coverage:**
  - Section 1 (Schema additions): Tasks 2 + 3 + 4 + 5 + parts of 7.
  - Section 2 (UI): Tasks 9 + 10 + 11 + 12.
  - Section 3 (Server validation): Tasks 6 + 7 + 8.
  - Section 4 (Config migration): Tasks 13 + 14.
  - Section 5 (Testing): Unit/integration in Tasks 2-8 + 15; manual smoke in Task 16.
  - Cross-instance discussion in spec: implemented by Tasks 6 (gate at source) + 7 (mirror persists without re-gate) + 8 (gate at target for receiver).
- **No placeholders.** Each TDD step has explicit code or commands.
- **Type consistency:** `ConsentAckSchema` type name is consistent throughout. `consent_text_initiator` / `consent_text_receiver` field names match between Task 2 (schema), Tasks 6/8 (route reads), Tasks 11/12 (UI reads), and Tasks 13/14 (config writes). `body.consent` shape matches between request schema (Task 3), route reads (Tasks 6/8), and UI payload (Tasks 10/11/12).
- **TDD on UI:** apps/ui has no test infrastructure today; UI tasks (9-12) ship code + rely on manual smoke in Task 16. The spec explicitly hedged on UI tests; not adding infrastructure here keeps scope.
- **Bundle regeneration:** Tasks 13 + 14 both call out `pnpm schema:bundle:check` since the Helm chart bundles `examples/` JSON.
