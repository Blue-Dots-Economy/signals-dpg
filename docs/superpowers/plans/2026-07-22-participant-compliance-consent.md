# Participant API Compliance Consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record `terms` / `privacy` / `profile_creation` consent sent by external channels through the `/admin/participant` `compliance` array into the `consent_record` ledger, and promote the created profile to `live` on the same call.

**Architecture:** A dedicated `participant_consent` service (Approach 2) owns all consent-recording logic. The participant handler calls it once per verdict branch, inside the transaction that writes the user/item, so recording + promotion are atomic. It reuses the existing shared `resolveConsentVersion` and `promoteItemOnProfileConsent` (the guardian/age gate lives inside the latter). The deprecated `terms_accepted`/`privacy_accepted` booleans become optional-and-ignored; the stale user-table columns stop being written.

**Tech Stack:** TypeScript (ESM, strict), Fastify + `fastify-type-provider-zod`, Zod (`@dpg/schemas`), Drizzle ORM, PostgreSQL, Vitest. Monorepo: pnpm + Turborepo. Alias `@` → `apps/api/src`, `@api` → `apps/api`, `@dpg/*` → `packages/*/src`.

## Global Constraints

- **Files are snake_case.** Route handler exports are snake_case; internal functions camelCase; Zod schemas PascalCase; DB columns snake_case.
- **Routes never throw** — return `reply.code(N).send({ error, message })` with a machine-readable `error`. Handle PG `23505`/`23503` explicitly where relevant.
- **ESM only, strict TS, no `any`.** Use `import type` for type-only imports.
- **No `console.log`** in library packages; use `request.log` in app code. **No `// TODO`** comments.
- **Version derived server-side.** Never trust a client-supplied consent version. Always call `resolveConsentVersion`.
- **`profile_creation` recorded via participant uses `source='profile'`** — never `'guardian'` (that would wrongly promote a minor).
- **No DB migration / no schema bundle.** This change adds no columns (`consent_record` and `items` are unchanged; `items.lifecycle_status` already exists). Do NOT run `pnpm schema:bundle`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Node `>=24`, `pnpm@11.1.2`.** Unit tests: `pnpm --filter api test` (no DB). Integration: `docker compose up -d db redis && pnpm --filter api test:integration`.

---

## File Structure

- **Create** `apps/api/src/services/participant_consent.ts` — the consent-recording helper. One responsibility: map a `compliance` array to ledger rows, insert them, and promote the item. Consumes `resolveConsentVersion`, `hasAcceptedTermsAndPrivacy`, `hasAcceptedProfileConsent`, `promoteItemOnProfileConsent`.
- **Create** `apps/api/src/services/__tests__/participant_consent.test.ts` — unit tests (mocked deps).
- **Modify** `packages/schemas/src/admin/participant.ts` — add `compliance`; relax the two booleans to optional; add `lifecycle_status` (item snapshot) and `consent_recorded` (response), both optional.
- **Modify** `apps/api/src/routes/v1/admin/participant.ts` — call the service per branch inside transactions; stop writing the stale booleans; expose `lifecycle_status`; thread `consent_recorded`.
- **Modify** `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` — mock the new service; drop the `termsAccepted`/`privacyAccepted` assertion; add a "booleans now optional" test.
- **Modify** `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts` — end-to-end consent-ledger + `lifecycle_status` assertions.
- **Modify** `docs/operations/integrating-dpgs.md` and `.claude/rules/consent-v1.md` — document the new contract.

---

## Task 1: Schema — add `compliance`, relax booleans, add response fields

**Files:**
- Modify: `packages/schemas/src/admin/participant.ts`
- Test: `apps/api/src/routes/v1/admin/__tests__/participant.test.ts`

**Interfaces:**
- Produces: `UpsertParticipantRequest` now has optional `compliance: { key: string; value: boolean }[]` and optional `terms_accepted`/`privacy_accepted`; `ParticipantItemSnapshot` has optional `lifecycle_status: string`; `UpsertParticipantResponse` has optional `consent_recorded: number`.

- [ ] **Step 1: Write the failing test** (proves the `must-be-true` refine is gone)

Add to `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` inside the top-level `describe` (after the account-only test, ~line 483):

```ts
  it('accepts a request with terms_accepted/privacy_accepted omitted (now optional) → 200', async () => {
    dbState.signUpUserId = 'usr_new_optional';
    lastQueriedUserId = 'usr_new_optional';
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: {
        email: 'optional@example.com',
        name: 'Opt',
        channel: 'bulk',
        item_state: { whoIAm: { education: 'XII' } },
      },
    });
    expect(res.statusCode).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts -t "now optional"`
Expected: FAIL — status 400 (Zod rejects the missing required `terms_accepted`/`privacy_accepted`).

- [ ] **Step 3: Edit the schema**

In `packages/schemas/src/admin/participant.ts`, replace the two refined booleans (currently:)

```ts
    terms_accepted: z
      .boolean()
      .refine((v) => v === true, 'terms_accepted must be true'),
    privacy_accepted: z
      .boolean()
      .refine((v) => v === true, 'privacy_accepted must be true'),
```

with:

```ts
    // Deprecated (#309): accepted for backward compatibility with existing
    // callers (aggregator-dpg / bulk) but IGNORED. Consent is recorded via
    // `compliance`. Remove in a later cleanup ticket.
    terms_accepted: z.boolean().optional(),
    privacy_accepted: z.boolean().optional(),
    // Consent captured by an external channel (voice/aggregator/bulk). Each
    // entry names a consent the user accepted/declined on the channel; only
    // `value: true` is recorded (append-only ledger). Recognised keys:
    // `user_terms`, `user_privacy`, `profile_creation`. Unknown keys (e.g. a
    // future action/connect key) are ignored. Versions are derived server-side.
    compliance: z
      .array(z.object({ key: z.string().min(1), value: z.boolean() }))
      .optional(),
```

In the same file, add `lifecycle_status` to `ParticipantItemSnapshot` (after the `item_type` line):

```ts
export const ParticipantItemSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  // Present on the upsert response so callers can tell live vs draft. Optional
  // because sibling readers (participant_read) do not populate it.
  lifecycle_status: z.string().optional(),
  item_state: z.record(z.string(), z.unknown()),
  item_locations: ItemLocationsArray,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
```

And add `consent_recorded` to `UpsertParticipantResponse`:

```ts
export const UpsertParticipantResponse = z.object({
  user_id: z.string(),
  user_existed: z.boolean(),
  owned_elsewhere: z.boolean(),
  onboarded_at: z.iso.datetime().nullable(),
  items: z.array(ParticipantItemSnapshot),
  // Number of consent_record rows written this call (#309). Optional so the
  // rejected / owned-elsewhere branches can omit it.
  consent_recorded: z.number().int().optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts -t "now optional"`
Expected: PASS.

- [ ] **Step 5: Guard against a stale refine assertion**

Run: `grep -n "terms_accepted\|privacy_accepted\|must be true" apps/api/src/routes/v1/admin/__tests__/participant.test.ts`
If any test asserts a `400`/validation failure caused by `terms_accepted`/`privacy_accepted` being `false` or missing, update it to expect `200` (these fields are now optional). If none exists, no change.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: passes (no errors).

```bash
git add packages/schemas/src/admin/participant.ts apps/api/src/routes/v1/admin/__tests__/participant.test.ts
git commit -m "$(cat <<'EOF'
feat(participant): accept compliance array; deprecate consent booleans (#309)

Add optional `compliance` to the participant request, relax
terms_accepted/privacy_accepted to optional-and-ignored, and add
lifecycle_status / consent_recorded to the response.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `participant_consent` service

**Files:**
- Create: `apps/api/src/services/participant_consent.ts`
- Test: `apps/api/src/services/__tests__/participant_consent.test.ts`

**Interfaces:**
- Consumes: `resolveConsentVersion` (`@/services/consent_version`), `hasAcceptedTermsAndPrivacy` + `hasAcceptedProfileConsent` (`@/services/consent_acceptance`), `promoteItemOnProfileConsent` + `DbOrTx` (`@/services/item_service`), `consent_record` (`@api/db/postgres/schema`).
- Produces: `recordParticipantConsent(tx: DbOrTx, args): Promise<{ recorded: number; promoted: boolean }>` where `args = { compliance?: { key: string; value: boolean }[]; userId: string; itemId?: string; network: string; brand?: string | null; channel: 'bulk'|'link'|'voice'|'self'; acceptedAt: Date }`. Also exports `ComplianceEntry` and `RecordParticipantConsentArgs` types.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/__tests__/participant_consent.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const resolveConsentVersion = vi.fn();
const hasAcceptedTermsAndPrivacy = vi.fn();
const hasAcceptedProfileConsent = vi.fn();
const promoteItemOnProfileConsent = vi.fn();

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: (...a: unknown[]) => resolveConsentVersion(...a),
}));
vi.mock('@/services/consent_acceptance', () => ({
  hasAcceptedTermsAndPrivacy: (...a: unknown[]) => hasAcceptedTermsAndPrivacy(...a),
  hasAcceptedProfileConsent: (...a: unknown[]) => hasAcceptedProfileConsent(...a),
}));
vi.mock('@/services/item_service', () => ({
  promoteItemOnProfileConsent: (...a: unknown[]) => promoteItemOnProfileConsent(...a),
}));
vi.mock('@api/db/postgres/schema', () => ({
  consent_record: { __table: 'consent_record' },
}));

import { recordParticipantConsent } from '@/services/participant_consent';

type InsertedRow = Record<string, unknown>;

function makeTx() {
  const inserted: InsertedRow[] = [];
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: InsertedRow) => {
        inserted.push(row);
      }),
    })),
  };
  return { tx, inserted };
}

describe('recordParticipantConsent', () => {
  beforeEach(() => {
    resolveConsentVersion.mockReset();
    hasAcceptedTermsAndPrivacy.mockReset();
    hasAcceptedProfileConsent.mockReset();
    promoteItemOnProfileConsent.mockReset();
    resolveConsentVersion.mockResolvedValue(1);
    hasAcceptedTermsAndPrivacy.mockResolvedValue(true);
    hasAcceptedProfileConsent.mockResolvedValue(false);
    promoteItemOnProfileConsent.mockResolvedValue(true);
  });

  it('returns zero when compliance is absent', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res).toEqual({ recorded: 0, promoted: false });
    expect(inserted).toHaveLength(0);
  });

  it('records terms + privacy as user-level rows with source=signup and metadata', async () => {
    const { tx, inserted } = makeTx();
    const acceptedAt = new Date('2026-07-22T00:00:00.000Z');
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt,
    });
    expect(res.recorded).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      level: 'user', consentCategory: 'terms', userId: 'u1', network: 'blue_dot',
      documentVersion: 1, source: 'signup', acceptedAt,
      metadata: { channel: 'voice', via: 'admin_participant', key: 'user_terms' },
    });
    expect(inserted[1]).toMatchObject({ consentCategory: 'privacy', source: 'signup' });
  });

  it('skips value:false and unknown keys', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: false },
        { key: 'something_else', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'bulk', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('skips a category whose version is unconfigured', async () => {
    resolveConsentVersion.mockResolvedValue(null);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'user_terms', value: true }],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('records profile_creation and promotes when prerequisites met and item present', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(3);
    expect(res.promoted).toBe(true);
    expect(promoteItemOnProfileConsent).toHaveBeenCalledWith(tx, 'item-1');
    const profileRow = inserted.find((r) => r.consentCategory === 'profile_creation');
    expect(profileRow).toMatchObject({
      level: 'item', itemId: 'item-1', source: 'profile',
      metadata: { channel: 'voice', via: 'admin_participant', key: 'profile_creation' },
    });
  });

  it('skips profile_creation when no item is present', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(2);
    expect(res.promoted).toBe(false);
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalled();
    expect(inserted.find((r) => r.consentCategory === 'profile_creation')).toBeUndefined();
  });

  it('skips profile_creation when terms/privacy prerequisite is missing', async () => {
    hasAcceptedTermsAndPrivacy.mockResolvedValue(false);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'profile_creation', value: true }],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(res.promoted).toBe(false);
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('does not re-insert profile_creation when already recorded but still promotes', async () => {
    hasAcceptedProfileConsent.mockResolvedValue(true);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'profile_creation', value: true }],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(res.promoted).toBe(true);
    expect(inserted.find((r) => r.consentCategory === 'profile_creation')).toBeUndefined();
    expect(promoteItemOnProfileConsent).toHaveBeenCalledWith(tx, 'item-1');
  });

  it('reports promoted:false when the item does not go live (e.g. minor gate)', async () => {
    promoteItemOnProfileConsent.mockResolvedValue(false);
    const { tx } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.promoted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/participant_consent.test.ts`
Expected: FAIL — cannot import `recordParticipantConsent` (module does not exist).

- [ ] **Step 3: Create the service**

Create `apps/api/src/services/participant_consent.ts`:

```ts
import { resolveConsentVersion } from '@/services/consent_version';
import {
  hasAcceptedProfileConsent,
  hasAcceptedTermsAndPrivacy,
} from '@/services/consent_acceptance';
import {
  promoteItemOnProfileConsent,
  type DbOrTx,
} from '@/services/item_service';
import { consent_record } from '@api/db/postgres/schema';

/** One entry of the participant API `compliance` array. */
export interface ComplianceEntry {
  key: string;
  value: boolean;
}

export interface RecordParticipantConsentArgs {
  compliance?: ComplianceEntry[];
  userId: string;
  /** Present when a profile item was created/targeted this call. */
  itemId?: string;
  network: string;
  brand?: string | null;
  channel: 'bulk' | 'link' | 'voice' | 'self';
  acceptedAt: Date;
}

/** External compliance keys → user-level ledger categories. */
const USER_LEVEL_KEYS: Record<string, 'terms' | 'privacy'> = {
  user_terms: 'terms',
  user_privacy: 'privacy',
};
const PROFILE_CREATION_KEY = 'profile_creation';

/**
 * Records terms / privacy / profile_creation consent sent by an external
 * channel (voice / aggregator / bulk) through the `/admin/participant`
 * `compliance` array into the consent_record ledger, and promotes the profile
 * item to `live` when profile_creation consent is accepted.
 *
 * Accept-only: only entries with `value === true` are recorded; `false`,
 * absent, and unknown keys are ignored. The document version is derived
 * server-side (never trusted from the client). Call this inside the same
 * transaction as the user/item write so recording + promotion are atomic; a
 * failure rolls the whole write back.
 *
 * `source` is `'signup'` for user-level rows and `'profile'` for the item-level
 * `profile_creation` row — deliberately never `'guardian'`, so a minor's
 * profile stays draft under `guardianGateBlocksGoLive` inside
 * `promoteItemOnProfileConsent`.
 */
export async function recordParticipantConsent(
  tx: DbOrTx,
  args: RecordParticipantConsentArgs,
): Promise<{ recorded: number; promoted: boolean }> {
  const { compliance, userId, itemId, network, channel, acceptedAt } = args;
  const brand = args.brand ?? null;

  if (!compliance || compliance.length === 0) {
    return { recorded: 0, promoted: false };
  }

  const accepted = new Set(
    compliance.filter((c) => c.value === true).map((c) => c.key),
  );

  let recorded = 0;
  let promoted = false;

  // 1. User-level terms / privacy.
  for (const [key, category] of Object.entries(USER_LEVEL_KEYS)) {
    if (!accepted.has(key)) continue;
    const version = await resolveConsentVersion({ network, brand, category });
    if (version === null) continue; // category not configured — skip, do not fail onboarding
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

  // 2. Item-level profile_creation — needs an item AND the terms/privacy
  //    prerequisite (mirrors accept_profile_consent). Pre-check presence to
  //    stay idempotent without relying on a 23505 inside the transaction
  //    (which would abort it).
  if (accepted.has(PROFILE_CREATION_KEY) && itemId) {
    const prereqMet = await hasAcceptedTermsAndPrivacy(tx, userId, network);
    if (prereqMet) {
      const alreadyRecorded = await hasAcceptedProfileConsent(tx, itemId);
      if (!alreadyRecorded) {
        const version = await resolveConsentVersion({
          network,
          brand,
          category: 'profile_creation',
        });
        if (version !== null) {
          await tx.insert(consent_record).values({
            level: 'item',
            consentCategory: 'profile_creation',
            userId,
            itemId,
            network,
            brand,
            documentVersion: version,
            source: 'profile',
            acceptedAt,
            metadata: { channel, via: 'admin_participant', key: PROFILE_CREATION_KEY },
          });
          recorded += 1;
        }
      }
      // Promote whenever profile_creation consent is present (new or existing).
      promoted = await promoteItemOnProfileConsent(tx, itemId);
    }
  }

  return { recorded, promoted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/participant_consent.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`
Expected: passes.

```bash
git add apps/api/src/services/participant_consent.ts apps/api/src/services/__tests__/participant_consent.test.ts
git commit -m "$(cat <<'EOF'
feat(consent): add participant_consent service (#309)

Maps the participant compliance array to consent_record ledger rows
(terms/privacy user-level, profile_creation item-level) and promotes the
profile via the shared promoteItemOnProfileConsent path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire the service into the handler

**Files:**
- Modify: `apps/api/src/routes/v1/admin/participant.ts`
- Test: `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` (unit), `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts` (integration)

**Interfaces:**
- Consumes: `recordParticipantConsent` from Task 2; `promoteItemOnProfileConsent` is invoked transitively.
- Produces: the endpoint records consent + promotes, returns `lifecycle_status` per item and `consent_recorded` on the body.

- [ ] **Step 1: Update the unit test — mock the service and drop the stale-boolean assertion**

In `apps/api/src/routes/v1/admin/__tests__/participant.test.ts`, add a mock alongside the other `vi.mock` calls (after the `publish_item_event` mock, ~line 87):

```ts
// --- mock the consent service: it is unit-tested separately; here we only
//     assert the route calls it with the right args and stays green.
vi.mock('@/services/participant_consent', () => ({
  recordParticipantConsent: vi.fn(async () => ({ recorded: 0, promoted: false })),
}));
```

Change the account-only assertion (currently at ~lines 476-482) from:

```ts
    expect(dbState.updates[0].set).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedVia: 'bulk',
      termsAccepted: true,
      privacyAccepted: true,
    });
```

to (the stale booleans are no longer written):

```ts
    expect(dbState.updates[0].set).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedVia: 'bulk',
    });
    expect(dbState.updates[0].set).not.toHaveProperty('termsAccepted');
    expect(dbState.updates[0].set).not.toHaveProperty('privacyAccepted');
```

- [ ] **Step 2: Run the unit test to verify the assertion now fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts -t "account_only"`
Expected: FAIL — `dbState.updates[0].set` still contains `termsAccepted`/`privacyAccepted` (handler not yet edited).

- [ ] **Step 3: Edit `participant.ts` — import + drop stale booleans + counter**

Add the import (after the `resolve_upsert_action` import, ~line 22):

```ts
import { recordParticipantConsent } from '@/services/participant_consent';
```

Remove the two stale lines from `buildOnboardingSet` so it reads:

```ts
const buildOnboardingSet = (f: OnboardingFields) => ({
  phoneNumber: f.phone_norm,
  phoneNumberVerified: false,
  dateOfBirth: f.date_of_birth ? new Date(f.date_of_birth) : null,
  onboardedByOrgId: f.acting_org_id,
  onboardedVia: f.channel,
  onboardedSourceId: f.source_id ?? null,
  onboardedAt: f.now,
  updatedAt: f.now,
});
```

At the top of `participant_handler`, right after `const body = request.body;`, add:

```ts
  let consent_recorded = 0;
```

- [ ] **Step 4: Edit the `account_only` branch (new + existing user)**

Replace the new-user `updateExecutor` (the plain `db.update(...)`) with a transaction that also records consent. The new-user block becomes:

```ts
  if (verdict.kind === 'account_only') {
    if (!user_exists) {
      const acting_org_id = request.acting_org!.org_id;
      const network = body.network ?? 'blue_dot';
      const now = new Date();
      const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;

      const fields: OnboardingFields = {
        phone_norm,
        date_of_birth: body.date_of_birth,
        acting_org_id,
        channel: body.channel,
        source_id: body.source_id,
        now,
      };

      const result = await signUpAndOnboardUser({
        email_for_signup,
        name: body.name,
        fields,
        log: request.log,
        updateExecutor: async (user_id) => {
          await db.transaction(async (tx) => {
            await tx
              .update(user)
              .set(buildOnboardingSet(fields))
              .where(eq(user.id, user_id));
            const consent = await recordParticipantConsent(tx, {
              compliance: body.compliance,
              userId: user_id,
              network,
              brand: null,
              channel: body.channel,
              acceptedAt: now,
            });
            consent_recorded = consent.recorded;
          });
        },
      });

      if (!result.ok) {
        return reply.code(result.statusCode).send({
          error: result.error,
          message: result.message,
        });
      }

      return reply.code(200).send({
        user_id: result.user_id,
        user_existed: false,
        owned_elsewhere: false,
        onboarded_at: now.toISOString(),
        items: [],
        consent_recorded,
      });
    }

    // Existing user, no item_state — record any user-level consent, then read.
    if (body.compliance && body.compliance.length > 0) {
      const network = body.network ?? 'blue_dot';
      await db.transaction(async (tx) => {
        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: existing!.id,
          network,
          brand: null,
          channel: body.channel,
          acceptedAt: new Date(),
        });
        consent_recorded = consent.recorded;
      });
    }

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
      onboarded_at: null,
      items: itemsList,
      consent_recorded,
    });
  }
```

- [ ] **Step 5: Edit the `update_item` branch**

Wrap the update + consent in a transaction. Replace the `updateResult` declaration + `try { updateResult = await updateItemInternal(db, ...) }` block with:

```ts
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
        updateResult = await updateItemInternal(
          tx,
          verdict.item_id,
          existing!.id,
          true, // isAdmin — ownership already verified above
          { item_state: body.item_state ?? {} },
        );
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
        message: e.errorCode ? (err as Error).message : 'item update failed',
      });
    }
```

Then add `consent_recorded` to this branch's success `reply.code(200).send({ ... })` (the object that ends with `items: itemsList,`):

```ts
      items: itemsList,
      consent_recorded,
    });
```

> Verification note before editing: confirm `updateItemInternal`'s first parameter accepts `DbOrTx` (it is called as `updateItemInternal(db, ...)` today). Run `grep -n "export.*updateItemInternal" apps/api/src/services/item_service.ts` and read the signature. It takes the executor first, so passing `tx` is correct.

- [ ] **Step 6: Edit the `insert_item` branch**

Wrap `create_profile_item` + consent in a transaction. Replace the `let insertedItemId ... try { const { item_id } = await create_profile_item({ tx: db, ... }); insertedItemId = item_id; } catch ...` block with:

```ts
    let insertedItemId: string | undefined;
    try {
      await db.transaction(async (tx) => {
        const { item_id } = await create_profile_item({
          tx,
          user_id: existing!.id,
          network,
          domain,
          item_type,
          payload: body.item_state ?? {},
        });
        insertedItemId = item_id;
        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: existing!.id,
          itemId: item_id,
          network,
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
      logger.call(request.log, { err }, 'insert_item failed');
      return reply.code(e.statusCode ?? 500).send({
        error: e.errorCode ?? 'INSERT_ITEM_FAILED',
        message: e.errorCode ? (err as Error).message : 'item insert failed',
      });
    }
```

Add `consent_recorded` to this branch's success send (the object ending with `items: itemsList,`):

```ts
      items: itemsList,
      consent_recorded,
    });
```

- [ ] **Step 7: Edit the `create_new_user` branch**

Inside the existing `updateExecutor`'s `db.transaction`, after `onboarded_item_id = item_id;`, add the consent call. The `updateExecutor` becomes:

```ts
    updateExecutor: async (user_id) => {
      await db.transaction(async (tx) => {
        await tx
          .update(user)
          .set(buildOnboardingSet(fields))
          .where(eq(user.id, user_id));

        const { item_id } = await create_profile_item({
          tx,
          user_id,
          network,
          domain,
          item_type,
          payload: body.item_state ?? {},
        });
        onboarded_item_id = item_id;

        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: user_id,
          itemId: item_id,
          network,
          brand: null,
          channel: body.channel,
          acceptedAt: now,
        });
        consent_recorded = consent.recorded;
      });
    },
```

Add `consent_recorded` to this branch's final success send (the object ending with `items: itemsList,`):

```ts
    items: itemsList,
    consent_recorded,
  });
```

- [ ] **Step 8: Expose `lifecycle_status` in `readItemsForUser`**

In `readItemsForUser`, add `lifecycle_status` to the select (after `item_type: items.item_type,`):

```ts
      item_type: items.item_type,
      lifecycle_status: items.lifecycle_status,
      item_state: items.item_state,
```

No change to the `.map(...)` is needed — `lifecycle_status` flows through the `...rest` spread automatically.

- [ ] **Step 9: Run the unit tests**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts`
Expected: PASS (all tests, including the updated account-only assertion and the Task 1 "now optional" test).

- [ ] **Step 10: Add the failing integration test**

In `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`:

Declare a table handle near the other module-level `let`s (with `db`, `authSchema`, `itemsTable`):

```ts
  let consentRecordTable: typeof import('@api/db/postgres/schema')['consent_record'];
```

In `beforeAll`, after `itemsTable = database_pkg.items;`, add:

```ts
    const schema_mod = await import('@api/db/postgres/schema');
    consentRecordTable = schema_mod.consent_record;
```

In `afterAll`, before the users are deleted, add (uses the already-imported `inArray`):

```ts
    try {
      if (onboarded_user_ids.length > 0) {
        await db
          .delete(consentRecordTable)
          .where(inArray(consentRecordTable.userId, onboarded_user_ids));
      }
    } catch {
      /* swallow cleanup errors */
    }
```

Add these three tests inside the `describeIf` block:

```ts
  it('records compliance consent and promotes an adult profile to live', async () => {
    const email = `int_c_compliance_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Compliance Adult',
        date_of_birth: '1990-01-01',
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    onboarded_user_ids.push(body.user_id);
    expect(body.consent_recorded).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].lifecycle_status).toBe('live');

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, body.user_id));
    const cats = rows.map((r) => r.consentCategory).sort();
    expect(cats).toEqual(['privacy', 'profile_creation', 'terms']);
    const profileRow = rows.find((r) => r.consentCategory === 'profile_creation');
    expect(profileRow?.source).toBe('profile');
    expect(profileRow?.metadata).toMatchObject({
      channel: 'voice',
      via: 'admin_participant',
    });
  });

  it('ignores deprecated terms_accepted/privacy_accepted and records no consent', async () => {
    const email = `int_c_legacy_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Legacy Booleans',
        channel: 'bulk',
        terms_accepted: true,
        privacy_accepted: true,
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    onboarded_user_ids.push(body.user_id);
    expect(body.consent_recorded ?? 0).toBe(0);
    expect(body.items[0].lifecycle_status).toBe('draft');

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, body.user_id));
    expect(rows).toHaveLength(0);
  });

  it('does not record profile_creation without the terms+privacy prerequisite', async () => {
    const email = `int_c_prereq_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Prereq Missing',
        date_of_birth: '1990-01-01',
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
        compliance: [{ key: 'profile_creation', value: true }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    onboarded_user_ids.push(body.user_id);
    expect(body.consent_recorded ?? 0).toBe(0);
    expect(body.items[0].lifecycle_status).toBe('draft');

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, body.user_id));
    expect(rows).toHaveLength(0);
  });
```

- [ ] **Step 11: Run the integration tests**

Run: `docker compose up -d db redis && pnpm --filter api test:integration -- src/routes/v1/admin/__tests__/participant.integration.test.ts`
Expected: PASS. (If `POSTGRES_URL`/`POSTGRES_USER` are unset the suite self-skips — set them / use the dev `.env`.)

- [ ] **Step 12: Typecheck + full unit suite + commit**

Run: `pnpm typecheck && pnpm --filter api test`
Expected: both pass.

```bash
git add apps/api/src/routes/v1/admin/participant.ts \
  apps/api/src/routes/v1/admin/__tests__/participant.test.ts \
  apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(participant): record compliance consent + promote on onboard (#309)

Wire recordParticipantConsent into every verdict branch inside its
transaction, stop writing the stale terms/privacy user columns, and expose
lifecycle_status + consent_recorded on the response.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Documentation

**Files:**
- Modify: `docs/operations/integrating-dpgs.md`
- Modify: `.claude/rules/consent-v1.md`

- [ ] **Step 1: Update `integrating-dpgs.md`**

In the `## Upserting a participant (tier-aware)` → `### Request` example, replace the two boolean lines with the compliance array and note the deprecation. Change the JSON body to:

```jsonc
{
  "email": "user@example.com",
  "name": "Asha P",
  "date_of_birth": "1990-01-01",
  "compliance": [
    { "key": "user_terms", "value": true },
    { "key": "user_privacy", "value": true },
    { "key": "profile_creation", "value": true }
  ],
  "channel": "voice",
  "item_state": { }, // item-schema-validated payload
  "network": "blue_dot",
  "domain": "seeker",
  "item_type": "profile_1.0"
}
```

Add a paragraph below the request:

> **Consent (`compliance`).** Each entry names a consent the channel captured
> from the user; only `value: true` is recorded, into the `consent_record`
> ledger. Recognised keys: `user_terms`, `user_privacy` (user-level) and
> `profile_creation` (item-level). Unknown keys are ignored. Versions are
> derived server-side. When `profile_creation` is accepted (and `user_terms` +
> `user_privacy` are present), the profile is promoted to `live` on this call —
> except on guardian-gated domains for a minor / missing DOB, where it stays
> `draft` until the guardian OTP flow completes in the web UI. The legacy
> `terms_accepted` / `privacy_accepted` booleans are still accepted for
> backward compatibility but **ignored** (deprecated, #309).

In the `### Response` example, add `"lifecycle_status": "live"` to the item object and `"consent_recorded": 3` at the top level, with a note that `lifecycle_status` tells the caller whether the profile is usable.

- [ ] **Step 2: Update `.claude/rules/consent-v1.md`**

Append to the paragraph describing `create_item`'s consent block (after the sentence ending "...consent atomically with the profile."):

> The `/admin/participant` endpoint also records the ledger for external
> channels: its `compliance` array maps to user-level `terms`/`privacy`
> (`source='signup'`) and item-level `profile_creation` (`source='profile'`),
> then promotes via `promoteItemOnProfileConsent`. The channel is captured in
> each row's `metadata.channel`. It never records guardian consent (that
> requires the OTP flow).

- [ ] **Step 3: Commit**

```bash
git add docs/operations/integrating-dpgs.md .claude/rules/consent-v1.md
git commit -m "$(cat <<'EOF'
docs(consent): document participant compliance consent contract (#309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Schema (A): Task 1. Service (B): Task 2. Handler wiring per branch (C): Task 3 steps 4-7. Edge cases (D): Task 2 tests (unknown/false skip, version-null skip, no-item skip, prerequisite gate, idempotent-but-promote, promoted:false) + atomic transactions in Task 3. `lifecycle_status` + `consent_recorded` response: Task 1 (schema) + Task 3 step 8 (populate). Testing (E): Task 2 unit + Task 3 integration. Docs (F): Task 4. Rollout (deprecate-and-ignore booleans, stop writing stale columns): Task 1 + Task 3 step 3. account_only records for new AND existing users: Task 3 step 4.

**2. Placeholder scan** — no `TBD`/`TODO`/"handle edge cases"; every code step shows complete code.

**3. Type consistency** — `recordParticipantConsent(tx, args)` signature is identical across Task 2 (definition), its tests, and all Task 3 call sites; `args` fields (`compliance`, `userId`, `itemId`, `network`, `brand`, `channel`, `acceptedAt`) match everywhere; `{ recorded, promoted }` return is consumed consistently (`consent.recorded` → `consent_recorded`). Schema field names (`compliance`, `lifecycle_status`, `consent_recorded`) match between Task 1 and Task 3.

**Open external items (do not block implementation):** final key strings (`user_terms`/`user_privacy`/`profile_creation`) to be confirmed with the voice-dpg team — the schema tolerates any string, so a rename is a one-line map change in `participant_consent.ts`; voice U18 handling is a product decision that does not change this code; Legal deliberation affects `consent.json` copy, not this endpoint.
