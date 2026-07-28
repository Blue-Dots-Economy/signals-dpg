# Participant Consent — Activation, Multi-profile & Read-status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the extension deltas to `/admin/participant` — consent-payload validation, DOB-on-update + promote-all-eligible-drafts, user-level consent dedupe, `item_id`-targets routing, and GET consent-status — on top of the base compliance-recording already on the branch.

**Architecture:** Handler-level validation for machine-readable error codes; DOB persistence + a `promoteEligibleDraftsForUser` helper reusing the shared `promoteItemOnProfileConsent`/guardian gate; a resolver tweak so `item_id` targets an existing profile without `item_state`; GET consent-status computed from the `consent_record` ledger + `user.date_of_birth`.

**Tech Stack:** TypeScript (ESM, strict), Fastify + `fastify-type-provider-zod`, Zod (`@dpg/schemas`), Drizzle ORM, PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-participant-consent-activation-readstatus-design.md`.

## Global Constraints

- Routes never throw — return `reply.code(N).send({ error, message })` with a machine-readable `error` code; log with `request.log.error({ err, ... }, 'msg')`. Never surface raw DB error text (it can contain participant PII).
- ESM only, strict TS, no `any`; `import type` for type-only imports; files snake_case; Zod schemas PascalCase.
- **Version is derived server-side** (`resolveConsentVersion`), never from client.
- **`source` for participant-recorded rows:** `'signup'` (user-level), `'profile'` (item-level) — never `'guardian'`.
- **No DB migration; do NOT run `pnpm schema:bundle`** (no columns added).
- Error codes (exact): `CONSENT_DECLINED`, `USER_LEVEL_INCOMPLETE`, `DOB_REQUIRED`.
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Unit: `pnpm --filter api test`. Integration: `docker compose up -d db redis` then `pnpm --filter api exec vitest run --config vitest.integration.config.ts <path>`. Typecheck: `pnpm typecheck`.
- **Deferred / NOT in scope:** rejecting U18 at the API (added only after the DOB→age migration).

---

## File Structure

- **Modify** `apps/api/src/routes/v1/admin/participant.ts` — add validation block + imports (Task 1); DOB persistence + `promoteEligibleDraftsForUser` calls + conditional `item_state` update (Tasks 2, 3).
- **Modify** `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts` — `item_id` → `update_item` regardless of `item_state` (Task 2).
- **Modify** `apps/api/src/services/participant_consent.ts` — add `promoteEligibleDraftsForUser` (Task 3); dedupe user-level insert (Task 4).
- **Modify** `packages/schemas/src/admin/participant.ts` — `GetParticipantResponse.user_consent` + `ParticipantItemSnapshot.profile_consent_accepted` (Task 5).
- **Modify** `apps/api/src/routes/v1/admin/participant_read.ts` — populate consent status + `lifecycle_status` (Task 5).
- **Modify** tests: `participant.test.ts`, `participant.integration.test.ts`, `resolve_upsert_action.test.ts`, `participant_consent.test.ts`.
- **Modify** docs: `docs/operations/integrating-dpgs.md`, `.claude/rules/consent-v1.md` (Task 6).

---

## Task 1: Consent-payload validation (Delta 0)

**Files:**
- Modify: `apps/api/src/routes/v1/admin/participant.ts`
- Test: `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` (unit — accept-only + pair), `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts` (gated-DOB)

**Interfaces:**
- Produces: three early `400` guards in `participant_handler` — `CONSENT_DECLINED` (any `compliance.value===false`), `USER_LEVEL_INCOMPLETE` (`user_terms` xor `user_privacy`), `DOB_REQUIRED` (pair present + gated domain + no `date_of_birth`).

> Design note: the spec suggested schema-level `superRefine` for accept-only/pair. We implement all three **in the handler** so every rejection returns the repo-standard `{ error: <CODE>, message }` shape (there is no Zod→error-code formatter in this app; a `superRefine` failure would surface as Fastify's generic validation error, not `CONSENT_DECLINED`).

- [ ] **Step 1: Write the failing unit tests**

Add to `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` inside the top-level `describe` (these return before any DB access, so no `dbState` setup is needed):

```ts
  it('rejects any compliance entry with value:false → 400 CONSENT_DECLINED', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        compliance: [{ key: 'user_terms', value: false }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CONSENT_DECLINED');
  });

  it('rejects a broken user-consent pair → 400 USER_LEVEL_INCOMPLETE', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        compliance: [{ key: 'user_terms', value: true }], // no user_privacy
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('USER_LEVEL_INCOMPLETE');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts -t "CONSENT_DECLINED|USER_LEVEL_INCOMPLETE"`
Expected: FAIL (currently these bodies flow past validation — the false/partial bundle isn't checked yet).

- [ ] **Step 3: Add imports + validation block to the handler**

In `apps/api/src/routes/v1/admin/participant.ts`, add two imports after the `recordParticipantConsent` import (line ~23):

```ts
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired } from '@/services/minor';
```

In `participant_handler`, immediately after the existing defensive identity check (the `if (!email_norm && !phone_norm) { return reply.code(400)... }` block), insert:

```ts
  // --- Consent-payload validation (#309) ---
  const compliance = body.compliance ?? [];
  // Accept-only: any entry sent as false rejects the whole request.
  if (compliance.some((c) => c.value === false)) {
    return reply.code(400).send({
      error: 'CONSENT_DECLINED',
      message: 'consent cannot be declined — omit a key to skip it',
    });
  }
  // user_terms + user_privacy are a both-or-none pair.
  const hasUserTerms = compliance.some((c) => c.key === 'user_terms' && c.value === true);
  const hasUserPrivacy = compliance.some((c) => c.key === 'user_privacy' && c.value === true);
  if (hasUserTerms !== hasUserPrivacy) {
    return reply.code(400).send({
      error: 'USER_LEVEL_INCOMPLETE',
      message: 'user_terms and user_privacy must be sent together',
    });
  }
  // On guardian-gated domains, recording user consent requires date_of_birth.
  if (hasUserTerms && hasUserPrivacy && !body.date_of_birth) {
    const gate_network = body.network ?? 'blue_dot';
    const gate_domain = body.domain ?? 'seeker';
    let gated = false;
    try {
      gated = guardianConsentRequired(await getNetworkConfigById(gate_network), gate_domain);
    } catch (err) {
      // Unknown network → downstream item write will reject it; don't block here.
      request.log.error({ err, network: gate_network }, 'network config load failed during DOB gate check');
    }
    if (gated) {
      return reply.code(400).send({
        error: 'DOB_REQUIRED',
        message: 'date_of_birth is required with consent on this domain',
      });
    }
  }
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts`
Expected: PASS (new tests green; existing tests unaffected — they send no `false`/partial pairs).

- [ ] **Step 5: Add the gated-DOB integration test**

In `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`, add (uses the existing `ns` service key + `primary` binding; imports `guardianConsentRequired`/`getNetworkConfigById` are already present from the base branch):

```ts
  it('gated domain: user consent without date_of_birth → 400 DOB_REQUIRED', async () => {
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: `int_dobreq_${randomUUID().slice(0, 6)}@a.test`,
        name: 'DOB Required',
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    if (gated) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('DOB_REQUIRED');
    } else {
      // non-gated served domain: consent without DOB is allowed
      expect(res.statusCode).toBe(200);
      onboarded_user_ids.push(res.json().user_id);
    }
  });
```

- [ ] **Step 6: Run integration + typecheck + commit**

Run: `docker compose up -d db redis && pnpm --filter api exec vitest run --config vitest.integration.config.ts src/routes/v1/admin/__tests__/participant.integration.test.ts`
Expected: PASS (the served domain `blue_dot/seeker` is gated → the `DOB_REQUIRED` branch runs).
Run: `pnpm typecheck` → clean.

```bash
git add apps/api/src/routes/v1/admin/participant.ts \
  apps/api/src/routes/v1/admin/__tests__/participant.test.ts \
  apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(participant): consent-payload validation — CONSENT_DECLINED / USER_LEVEL_INCOMPLETE / DOB_REQUIRED (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Routing refinement — `item_id` targets an existing profile (Delta 4)

**Files:**
- Modify: `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts`
- Modify: `apps/api/src/routes/v1/admin/participant.ts` (update_item branch — make `item_state` update conditional)
- Test: `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`

**Interfaces:**
- Produces: `resolve_upsert_action` returns `update_item{item_id}` whenever `item_id_in_body` is set (for an authorized existing user), regardless of `has_item_state`.

- [ ] **Step 1: Write the failing resolver test**

Add to `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`:

```ts
  it('item_id without item_state → update_item (consent/DOB-only target)', () => {
    const input = {
      acting_org: { org_id: 'o', org_type: 'network_service' as const, service_user_id: 's' },
      user_exists: true,
      item_id_in_body: '11111111-1111-4111-8111-111111111111',
      has_item_state: false,
      aggregator_owns_user: false,
    };
    expect(resolve_upsert_action(input)).toEqual({
      kind: 'update_item',
      item_id: '11111111-1111-4111-8111-111111111111',
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts -t "consent/DOB-only target"`
Expected: FAIL — currently returns `account_only` (item_id needs item_state today).

- [ ] **Step 3: Change the resolver tail**

In `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts`, replace the final two lines of `resolve_upsert_action`:

```ts
  if (item_id_in_body && has_item_state) return { kind: 'update_item', item_id: item_id_in_body };
  if (has_item_state) return { kind: 'insert_item' };
  return { kind: 'account_only' };
```

with:

```ts
  // item_id targets an existing profile — with or without item_state (#309):
  // a consent-only / DOB-only activation can update that profile without
  // re-sending its fields. item_state without item_id is still a new insert.
  if (item_id_in_body) return { kind: 'update_item', item_id: item_id_in_body };
  if (has_item_state) return { kind: 'insert_item' };
  return { kind: 'account_only' };
```

Also update the doc-comment "Tail logic" line in that file from `item_id_in_body && has_item_state → update_item{item_id_in_body}` to `item_id_in_body → update_item{item_id_in_body}` (with or without item_state).

- [ ] **Step 4: Make the handler's `update_item` tolerate a missing `item_state`**

In `apps/api/src/routes/v1/admin/participant.ts`, in the `update_item` branch, replace the `db.transaction` body so the field update only runs when `item_state` is present, and `publishItemEvent` only fires when the item was actually updated. Replace from `let updateResult:` through the `publishItemEvent(...)` call with:

```ts
    const hasItemState = Boolean(
      body.item_state && Object.keys(body.item_state).length > 0,
    );
    let updateResult:
      | {
          row: {
            item_network: string;
            item_domain: string;
            item_type: string;
            item_id: string;
          };
        }
      | undefined;
    try {
      await db.transaction(async (tx) => {
        if (hasItemState) {
          updateResult = await updateItemInternal(
            tx,
            verdict.item_id,
            existing!.id,
            true, // isAdmin — ownership already verified above
            { item_state: body.item_state ?? {} },
          );
        }
        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: existing!.id,
          itemId: verdict.item_id,
          network: body.network ?? 'blue_dot',
          brand: null,
          channel: body.channel,
          acceptedAt: new Date(),
        });
        consent_recorded = consent.recorded;
      });
    } catch (err) {
      const e = err as { statusCode?: number; errorCode?: string };
      const isClientError =
        typeof e.statusCode === 'number' &&
        e.statusCode >= 400 &&
        e.statusCode < 500;
      const logger = isClientError ? request.log.warn : request.log.error;
      logger.call(
        request.log,
        { err, item_id: verdict.item_id },
        'updateItemInternal failed',
      );
      return reply.code(e.statusCode ?? 500).send({
        error: e.errorCode ?? 'UPDATE_FAILED',
        // Only surface a curated ItemServiceError message (errorCode set). A raw
        // DB error's message includes the failed SQL + bound params — never return it.
        message: e.errorCode ? (err as Error).message : 'item update failed',
      });
    }

    if (updateResult) {
      await publishItemEvent(
        {
          item_network: updateResult.row.item_network,
          item_domain: updateResult.row.item_domain,
          item_type: updateResult.row.item_type,
          item_id: updateResult.row.item_id,
          op: 'upsert',
        },
        request.log,
      );
    }
```

(The DOB persist + `promoteEligibleDraftsForUser` calls are added to this same transaction in Task 3.)

- [ ] **Step 5: Run resolver + unit tests + typecheck**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts src/routes/v1/admin/__tests__/participant.test.ts`
Expected: PASS. If any existing resolver test asserted `item_id`-without-`item_state` → `account_only`, update it to `update_item` (grep: `grep -n "account_only" src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`).
Run: `pnpm typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/admin/_resolve_upsert_action.ts \
  apps/api/src/routes/v1/admin/participant.ts \
  apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts
git commit -m "$(cat <<'EOF'
feat(participant): item_id targets an existing profile without item_state (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Persist DOB on update + promote-all-eligible-drafts (Deltas 1 & 2)

**Files:**
- Modify: `apps/api/src/services/participant_consent.ts` (add `promoteEligibleDraftsForUser`)
- Modify: `apps/api/src/routes/v1/admin/participant.ts` (`update_item` + `account_only`-existing branches)
- Test: `apps/api/src/services/__tests__/participant_consent.test.ts`, `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`

**Interfaces:**
- Produces: `promoteEligibleDraftsForUser(tx: DbOrTx, userId: string): Promise<number>` — promotes every `draft` item owned by `userId` that already has a `profile_creation` row; returns the count promoted.
- Consumes: `promoteItemOnProfileConsent`, `hasAcceptedProfileConsent`, `items` table.

- [ ] **Step 1: Write the failing unit test for the helper**

Add to `apps/api/src/services/__tests__/participant_consent.test.ts`. First extend the mocks at the top of the file — the helper reads the `items` table via `tx.select(...).from(items).where(...)`, and calls `hasAcceptedProfileConsent` + `promoteItemOnProfileConsent` (both already mocked). Add an `items` mock and make the fake `tx` support a `select` chain returning a controllable draft list:

```ts
vi.mock('@dpg/database', () => ({ items: { __table: 'items' } }));

// helper to build a tx whose select().from().where() resolves to `draftRows`
function makeSelectTx(draftRows: Array<{ item_id: string }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => draftRows),
      })),
    })),
  };
}
```

Then the test:

```ts
  it('promoteEligibleDraftsForUser promotes only drafts that have profile_creation consent', async () => {
    hasAcceptedProfileConsent.mockImplementation(async (_tx: unknown, itemId: string) => itemId === 'has-consent');
    promoteItemOnProfileConsent.mockResolvedValue(true);
    const tx = makeSelectTx([{ item_id: 'has-consent' }, { item_id: 'no-consent' }]);
    const { promoteEligibleDraftsForUser } = await import('@/services/participant_consent');
    const n = await promoteEligibleDraftsForUser(tx as never, 'u1');
    expect(n).toBe(1);
    expect(promoteItemOnProfileConsent).toHaveBeenCalledWith(tx, 'has-consent');
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalledWith(tx, 'no-consent');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/participant_consent.test.ts -t "promoteEligibleDraftsForUser"`
Expected: FAIL — `promoteEligibleDraftsForUser` is not exported yet.

- [ ] **Step 3: Add the helper to `participant_consent.ts`**

In `apps/api/src/services/participant_consent.ts`, update the drizzle + database imports and append the helper. Change the top import line `import { sql } from 'drizzle-orm';` to:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { items } from '@dpg/database';
```

Append at the end of the file:

```ts
/**
 * Promotes every `draft` item owned by `userId` that already has a
 * `profile_creation` consent row. Because `date_of_birth` is user-level,
 * persisting it can unblock several of the user's profiles at once — call this
 * after a DOB write. Idempotent: `promoteItemOnProfileConsent` no-ops on items
 * that are not `draft` or that the guardian/completeness gate still blocks.
 * Returns the number actually flipped to `live`.
 */
export async function promoteEligibleDraftsForUser(
  tx: DbOrTx,
  userId: string,
): Promise<number> {
  const drafts = await tx
    .select({ item_id: items.item_id })
    .from(items)
    .where(and(eq(items.created_by, userId), eq(items.lifecycle_status, 'draft')));
  let promoted = 0;
  for (const d of drafts) {
    if (await hasAcceptedProfileConsent(tx, d.item_id)) {
      if (await promoteItemOnProfileConsent(tx, d.item_id)) promoted += 1;
    }
  }
  return promoted;
}
```

- [ ] **Step 4: Run the unit test to verify pass**

Run: `pnpm --filter api exec vitest run src/services/__tests__/participant_consent.test.ts`
Expected: PASS (all, incl. the new helper test).

- [ ] **Step 5: Wire DOB persist + promote into the handler branches**

In `apps/api/src/routes/v1/admin/participant.ts`:

Add the helper to the existing import from `participant_consent`:
```ts
import {
  recordParticipantConsent,
  promoteEligibleDraftsForUser,
} from '@/services/participant_consent';
```

**`update_item` branch** — inside the `db.transaction` from Task 2, add the DOB write before `recordParticipantConsent`, and the promote-all after it. The transaction body becomes:

```ts
      await db.transaction(async (tx) => {
        if (hasItemState) {
          updateResult = await updateItemInternal(
            tx,
            verdict.item_id,
            existing!.id,
            true,
            { item_state: body.item_state ?? {} },
          );
        }
        if (body.date_of_birth) {
          await tx
            .update(user)
            .set({ dateOfBirth: new Date(body.date_of_birth), updatedAt: new Date() })
            .where(eq(user.id, existing!.id));
        }
        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: existing!.id,
          itemId: verdict.item_id,
          network: body.network ?? 'blue_dot',
          brand: null,
          channel: body.channel,
          acceptedAt: new Date(),
        });
        consent_recorded = consent.recorded;
        if (body.date_of_birth) {
          await promoteEligibleDraftsForUser(tx, existing!.id);
        }
      });
```

**`account_only`-existing branch** — replace the current `if (body.compliance && body.compliance.length > 0) { try { db.transaction(...) } catch ... }` block with one that also handles a DOB-only call and promotes eligible drafts:

```ts
    // Existing user, no item_state — persist DOB / record user-level consent,
    // then promote any drafts the new DOB unblocks.
    const hasCompliance = Boolean(body.compliance && body.compliance.length > 0);
    if (hasCompliance || body.date_of_birth) {
      const network = body.network ?? 'blue_dot';
      try {
        await db.transaction(async (tx) => {
          if (body.date_of_birth) {
            await tx
              .update(user)
              .set({ dateOfBirth: new Date(body.date_of_birth), updatedAt: new Date() })
              .where(eq(user.id, existing!.id));
          }
          if (hasCompliance) {
            const consent = await recordParticipantConsent(tx, {
              compliance: body.compliance,
              userId: existing!.id,
              network,
              brand: null,
              channel: body.channel,
              acceptedAt: new Date(),
            });
            consent_recorded = consent.recorded;
          }
          if (body.date_of_birth) {
            await promoteEligibleDraftsForUser(tx, existing!.id);
          }
        });
      } catch (err) {
        request.log.error(
          { err },
          'participant existing-user consent/DOB update failed',
        );
        return reply.code(500).send({
          error: 'CONSENT_WRITE_FAILED',
          message: 'failed to record consent',
        });
      }
    }
```

- [ ] **Step 6: Add the activation integration test**

In `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`, add a test proving the bulk-draft→activate-with-DOB flow. It creates a gated-domain draft with consent but no DOB (which stays draft), then activates it by sending `item_id` + `date_of_birth` and asserts it goes live:

```ts
  it('activates a gated draft by later supplying date_of_birth via item_id', async () => {
    const email = `int_activate_${randomUUID().slice(0, 6)}@a.test`;
    // 1) create WITH consent but NO dob on a gated domain → stays draft
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    if (!gated) return; // this scenario only applies on a gated served domain
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Activate Later', channel: 'voice', date_of_birth: undefined,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        // gated + consent + no DOB would 400 (DOB_REQUIRED); so create with NO
        // consent first (bulk-style draft), then add consent+DOB on activation.
      },
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json();
    onboarded_user_ids.push(created.user_id);
    const itemId = created.items[0].item_id as string;
    expect(created.items[0].lifecycle_status).toBe('draft');

    // 2) activate: item_id + full consent + adult DOB → live
    const actRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Activate Later', channel: 'voice',
        item_id: itemId, date_of_birth: '1990-01-01',
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(actRes.statusCode).toBe(200);
    const activated = actRes.json();
    const row = activated.items.find((i: { item_id: string }) => i.item_id === itemId);
    expect(row.lifecycle_status).toBe('live');
  });
```

- [ ] **Step 7: Run integration + full unit suite + typecheck + commit**

Run: `pnpm --filter api exec vitest run --config vitest.integration.config.ts src/routes/v1/admin/__tests__/participant.integration.test.ts`
Run: `pnpm --filter api test && pnpm typecheck`
Expected: all PASS.

```bash
git add apps/api/src/services/participant_consent.ts \
  apps/api/src/services/__tests__/participant_consent.test.ts \
  apps/api/src/routes/v1/admin/participant.ts \
  apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(participant): persist DOB on update + promote all eligible drafts (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Dedupe user-level consent (Delta 3)

**Files:**
- Modify: `apps/api/src/services/participant_consent.ts`
- Test: `apps/api/src/services/__tests__/participant_consent.test.ts`

**Interfaces:**
- Changes `recordParticipantConsent`: a user-level `terms`/`privacy` row is inserted only if no row already exists for `(userId, network, category, documentVersion)`.

- [ ] **Step 1: Write the failing unit test**

Add to `participant_consent.test.ts`. The dedupe adds a `SELECT` before the user-level insert; extend the fake `tx` so `select()` used inside `recordParticipantConsent` can return an "already exists" row for a chosen category. Add a test that builds a tx whose user-level existence check returns a row for `terms` (dedupe skips it) and empty for `privacy` (inserts it):

```ts
  it('skips a user-level insert already recorded at the current version', async () => {
    resolveConsentVersion.mockResolvedValue(1);
    const inserted: Array<Record<string, unknown>> = [];
    // select() → returns [{id}] for terms (exists), [] for privacy (absent)
    let call = 0;
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => (call++ === 0 ? [{ id: 'x' }] : [])),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async (row: Record<string, unknown>) => { inserted.push(row); }) })),
    };
    const { recordParticipantConsent } = await import('@/services/participant_consent');
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(1); // terms deduped, privacy inserted
    expect(inserted.map((r) => r.consentCategory)).toEqual(['privacy']);
  });
```

> Note: this test needs its own local `tx` (the shared `makeTx` doesn't model `select`). Keep the existing tests using `makeTx` unchanged — they don't record user-level rows through the dedupe branch in a way that needs `select` (verify when running; if an existing test now calls the new `select`, give its `makeTx` a `select` stub returning `{ from:()=>({ where:()=>({ limit: async()=>[] }) }) }` so dedupe finds nothing and behaves as before).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/participant_consent.test.ts -t "already recorded at the current version"`
Expected: FAIL — currently both rows insert (recorded === 2).

- [ ] **Step 3: Add the dedupe check**

In `apps/api/src/services/participant_consent.ts`, in the user-level loop, add an existence check before the insert. Also add `eq`/`and` to the drizzle import if not already present (Task 3 added `and, eq, sql`). The loop body becomes:

```ts
  for (const [key, category] of Object.entries(USER_LEVEL_KEYS)) {
    if (!accepted.has(key)) continue;
    const version = await resolveConsentVersion({ network, brand, category });
    if (version === null) continue; // category not configured — skip, do not fail onboarding
    // Dedupe: skip if this user already has this category recorded at the
    // current version (avoids duplicate user-level rows across a user's
    // multiple profiles). A version bump writes a fresh row.
    const [existingUserRow] = await tx
      .select({ id: consent_record.id })
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, userId),
          eq(consent_record.level, 'user'),
          eq(consent_record.consentCategory, category),
          eq(consent_record.network, network),
          eq(consent_record.documentVersion, version),
        ),
      )
      .limit(1);
    if (existingUserRow) continue;
    await tx.insert(consent_record).values({
      level: 'user',
      consentCategory: category,
      userId,
      network,
      brand,
      documentVersion: version,
      source: 'signup',
      acceptedAt,
      metadata: { channel, via: 'admin_participant', key },
    });
    recorded += 1;
  }
```

- [ ] **Step 4: Run the full service test file**

Run: `pnpm --filter api exec vitest run src/services/__tests__/participant_consent.test.ts`
Expected: PASS. If any pre-existing test breaks because its `makeTx` now receives a `select` call, add the `select` stub described in Step 1's note so it returns no existing row.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → clean.

```bash
git add apps/api/src/services/participant_consent.ts \
  apps/api/src/services/__tests__/participant_consent.test.ts
git commit -m "$(cat <<'EOF'
feat(consent): dedupe user-level terms/privacy at current version (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: GET `/admin/participant` consent-status (Delta 5)

**Files:**
- Modify: `packages/schemas/src/admin/participant.ts`
- Modify: `apps/api/src/routes/v1/admin/participant_read.ts`
- Test: `apps/api/src/routes/v1/admin/__tests__/participant_read.integration.test.ts`

**Interfaces:**
- Produces: `GetParticipantResponse` gains `user_consent: { terms_accepted: boolean; privacy_accepted: boolean; has_date_of_birth: boolean }`; `ParticipantItemSnapshot` gains optional `profile_consent_accepted: boolean`; the GET items now include `lifecycle_status`.

- [ ] **Step 1: Extend the schemas**

In `packages/schemas/src/admin/participant.ts`:

Add `profile_consent_accepted` to `ParticipantItemSnapshot` (after `lifecycle_status`):
```ts
  lifecycle_status: z.string().optional(),
  // Whether this specific profile has profile_creation consent recorded.
  // Optional because the upsert response doesn't populate it (only GET does).
  profile_consent_accepted: z.boolean().optional(),
```

Add `user_consent` to `GetParticipantResponse`:
```ts
export const GetParticipantResponse = z.object({
  user_id: z.string().nullable(),
  user_consent: z.object({
    terms_accepted: z.boolean(),
    privacy_accepted: z.boolean(),
    has_date_of_birth: z.boolean(),
  }),
  items: z.array(ParticipantItemSnapshot),
});
```

- [ ] **Step 2: Write the failing integration test**

In `apps/api/src/routes/v1/admin/__tests__/participant_read.integration.test.ts` (create following the existing participant integration test's `beforeAll`/seed shape if the file is thin — model the setup on `participant.integration.test.ts`), add:

```ts
  it('GET returns user_consent + per-item profile_consent_accepted', async () => {
    const email = `int_read_${randomUUID().slice(0, 6)}@a.test`;
    // create a live profile with full consent + adult DOB on a gated domain
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Read Status', channel: 'voice', date_of_birth: '1990-01-01',
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(createRes.statusCode).toBe(200);
    onboarded_user_ids.push(createRes.json().user_id);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.user_consent).toMatchObject({
      terms_accepted: true,
      privacy_accepted: true,
      has_date_of_birth: true,
    });
    expect(body.items[0].profile_consent_accepted).toBe(true);
    expect(body.items[0].lifecycle_status).toBe('live');
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose up -d db redis && pnpm --filter api exec vitest run --config vitest.integration.config.ts src/routes/v1/admin/__tests__/participant_read.integration.test.ts`
Expected: FAIL — `user_consent` / `profile_consent_accepted` are undefined (not yet returned).

- [ ] **Step 4: Populate consent status in the read handler**

In `apps/api/src/routes/v1/admin/participant_read.ts`:

Add the import for `consent_record`:
```ts
import { consent_record } from '@api/db/postgres/schema';
```

Add `lifecycle_status` to this file's `readItemsForUser` select (after `item_type: items.item_type,`):
```ts
      item_type: items.item_type,
      lifecycle_status: items.lifecycle_status,
      item_state: items.item_state,
```

Add two helpers below `readItemsForUser`:
```ts
async function readUserConsent(userId: string): Promise<{
  terms_accepted: boolean;
  privacy_accepted: boolean;
  has_date_of_birth: boolean;
}> {
  const rows = await db
    .select({ category: consent_record.consentCategory })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.userId, userId),
        eq(consent_record.level, 'user'),
        inArray(consent_record.consentCategory, ['terms', 'privacy']),
      ),
    );
  const cats = new Set(rows.map((r) => r.category));
  const [urow] = await db
    .select({ dob: user.dateOfBirth })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return {
    terms_accepted: cats.has('terms'),
    privacy_accepted: cats.has('privacy'),
    has_date_of_birth: Boolean(urow?.dob),
  };
}

async function readProfileConsentedItemIds(itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ itemId: consent_record.itemId })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.level, 'item'),
        eq(consent_record.consentCategory, 'profile_creation'),
        inArray(consent_record.itemId, itemIds),
      ),
    );
  return new Set(rows.map((r) => r.itemId as string));
}

const EMPTY_USER_CONSENT = {
  terms_accepted: false,
  privacy_accepted: false,
  has_date_of_birth: false,
};
```

Rewrite the handler's response construction. Replace the not-found return, and the final ownership-based return, so all three response paths include `user_consent`:

Not-found:
```ts
  if (!existing) {
    return reply.code(200).send({
      user_id: null,
      user_consent: EMPTY_USER_CONSENT,
      items: [],
    });
  }
```

Owned / network_service path — after computing `itemsList`, decorate items and load consent. Replace the final block (from `const acting_org_id = ...` through the final `reply.code(200).send({ user_id: existing.id, items: itemsList })`) with:

```ts
  const acting_org_id = request.acting_org.org_id;
  let itemsList: Awaited<ReturnType<typeof readItemsForUser>> = [];
  let disclose = false;

  if (request.acting_org.org_type === 'aggregator') {
    disclose = existing.onboardedByOrgId === acting_org_id;
  } else {
    disclose = true; // network_service can always read
  }

  if (!disclose) {
    // Aggregator that did not onboard this user — no consent disclosure.
    return reply.code(200).send({
      user_id: existing.id,
      user_consent: EMPTY_USER_CONSENT,
      items: [],
    });
  }

  itemsList = await readItemsForUser(existing.id);
  const consentedItemIds = await readProfileConsentedItemIds(
    itemsList.map((i) => i.item_id),
  );
  const items = itemsList.map((i) => ({
    ...i,
    profile_consent_accepted: consentedItemIds.has(i.item_id),
  }));
  const user_consent = await readUserConsent(existing.id);

  return reply.code(200).send({
    user_id: existing.id,
    user_consent,
    items,
  });
```

- [ ] **Step 5: Run integration + full unit suite + typecheck**

Run: `pnpm --filter api exec vitest run --config vitest.integration.config.ts src/routes/v1/admin/__tests__/participant_read.integration.test.ts`
Run: `pnpm --filter api test && pnpm typecheck`
Expected: all PASS. (The aggregator-dpg writer already tolerates extra response fields — verified in the spec's backward-compat section — so this is additive.)

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/admin/participant.ts \
  apps/api/src/routes/v1/admin/participant_read.ts \
  apps/api/src/routes/v1/admin/__tests__/participant_read.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(participant): GET returns consent status (user_consent + profile_consent_accepted) (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/operations/integrating-dpgs.md`
- Modify: `.claude/rules/consent-v1.md`

- [ ] **Step 1: Update `integrating-dpgs.md`**

In the `## Upserting a participant` section, add a subsection documenting the consent rules + activation, mirroring the spec:

```md
### Consent (`compliance`), DOB, and activation

- `compliance` is an optional array of `{ key, value }`. Recognised keys:
  `user_terms`, `user_privacy` (user-level), `profile_creation` (item-level).
- **Accept-only:** any key sent as `false` → `400 CONSENT_DECLINED`; omit a key
  to skip it.
- **`user_terms` + `user_privacy` are a both-or-none pair** → one without the
  other is `400 USER_LEVEL_INCOMPLETE`.
- **On guardian-gated domains** (e.g. `seeker`), sending the consent pair
  requires `date_of_birth` → else `400 DOB_REQUIRED`. Non-gated domains don't
  require it.
- **Activation:** target an existing profile with `item_id` (no `item_state`
  needed) to add `profile_creation` and/or DOB and promote it. A user-level
  call with DOB and no item promotes all the user's eligible drafts.
- The legacy `terms_accepted` / `privacy_accepted` booleans are accepted but
  ignored (deprecated, #309).
- `GET /admin/participant` returns `user_consent { terms_accepted,
  privacy_accepted, has_date_of_birth }` and per-item `profile_consent_accepted`
  + `lifecycle_status` so callers can see what's outstanding and which profile
  is usable.
```

- [ ] **Step 2: Update `.claude/rules/consent-v1.md`**

Append to the paragraph about the participant endpoint (added in the base work):

```md
The participant endpoint validates consent payloads: any `compliance` value
`false` → `CONSENT_DECLINED`; `user_terms`/`user_privacy` are a both-or-none
pair (`USER_LEVEL_INCOMPLETE`); on guardian-gated domains the pair requires
`date_of_birth` (`DOB_REQUIRED`, handler-level via `guardianConsentRequired`).
Persisting DOB re-promotes all the user's eligible drafts
(`promoteEligibleDraftsForUser`). `GET /admin/participant` surfaces consent
status. It never records `source='guardian'` — U18 promotion still requires the
guardian OTP flow.
```

- [ ] **Step 3: Commit**

```bash
git add docs/operations/integrating-dpgs.md .claude/rules/consent-v1.md
git commit -m "$(cat <<'EOF'
docs(consent): document participant validation, activation & read-status (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Delta 0 validation (accept-only / pair / gated-DOB) → Task 1. ✅
- Delta 1 (persist DOB on update) → Task 3 (update_item + account_only-existing). ✅
- Delta 2 (promote-all-eligible-drafts) → Task 3 (`promoteEligibleDraftsForUser`). ✅
- Delta 3 (dedupe user-level) → Task 4. ✅
- Delta 4 (item_id targets without item_state) → Task 2. ✅
- Delta 5 (GET consent-status) → Task 5. ✅
- Docs → Task 6. ✅
- Deferred U18-rejection → explicitly out of scope (Global Constraints). ✅

**2. Placeholder scan:** every code step has complete code; no TBD/TODO.

**3. Type consistency:** `promoteEligibleDraftsForUser(tx, userId): Promise<number>` used identically in Task 3 def + handler calls. `user_consent` shape identical in schema (Task 5) and the read handler helpers. Error codes (`CONSENT_DECLINED`/`USER_LEVEL_INCOMPLETE`/`DOB_REQUIRED`) consistent across Task 1 + docs.

**Deviation from spec (noted in Task 1):** accept-only + pair are implemented handler-level (not Zod `superRefine`) so all three validations return the repo-standard `{ error: <CODE> }` shape.

**Known verification dependency:** the participant.test.ts db mock and participant_consent.test.ts `makeTx` may need a `select` stub once dedupe (Task 4) and the helper (Task 3) add `select` calls — each task's steps flag this; run the full file after each and add the stub if a pre-existing test trips.
