# U18 Phase 1 — Data & Detection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the U18 foundation — the `minor_guardian` table, the derived `is_minor` rule, and the per-domain `guardian_consent_required` flag — so later phases (OTP, guardian capture, gates, UI) have their data + detection primitives.

**Architecture:** Birth data is stored as plaintext `birth_year` + `birth_month` (no day) on a new `minor_guardian` table keyed on the better-auth `user_id`. Minor status is **derived** from that at read time by a pure helper (`isMinor`), never persisted. Whether a domain requires the guardian flow is a `guardian_consent_required` boolean on the domain in `network.json`, read server-side via an accessor.

**Tech Stack:** TypeScript (ESM, strict), Drizzle ORM + Postgres, Zod (`@dpg/schemas`), Vitest.

## Global Constraints

- ESM only, strict TS, no `any`; use `import type` for type-only imports (from `AGENTS.md`/CLAUDE.md).
- Files are snake_case; DB columns snake_case; Zod schemas PascalCase; internal functions camelCase.
- **Never hand-edit Drizzle migration files** — regenerate via `pnpm db:generate:api`.
- Birth data = **year + month only, plaintext, no exact day** (spec D3).
- `is_minor` is **derived, never a column** (spec D2). Conservative rounding: minor through the whole birth-month of the 18th year, adult from the 1st of the next month.
- `guardian_consent_required` is server-read config, **not** a client-trusted value (spec D8).
- Run one API test file: `pnpm --filter api exec vitest run <path>`.

---

### Task 1: `isMinor` derivation helper

**Files:**
- Create: `apps/api/src/services/minor.ts`
- Test: `apps/api/src/services/__tests__/minor.test.ts`

**Interfaces:**
- Produces: `isMinor(birthYear: number, birthMonth: number, now?: Date): boolean` — `birthMonth` is 1–12. Returns `true` while the person is under 18 under conservative month-boundary rounding.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/__tests__/minor.test.ts
import { describe, it, expect } from 'vitest';
import { isMinor } from '@api/services/minor';

// Fixed reference "today" so the assertions are deterministic.
const NOW = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15

describe('isMinor', () => {
  it('is true for a clear minor (age ~16)', () => {
    expect(isMinor(2010, 1, NOW)).toBe(true);
  });

  it('stays minor through the entire birth-month of the 18th year', () => {
    // Turns 18 in July 2026 → still minor until Aug 1 2026.
    expect(isMinor(2008, 7, NOW)).toBe(true);
  });

  it('is adult once past the 1st of the month after the 18th-year birth-month', () => {
    // 18th-year birth-month June 2026 → adult from Jul 1 2026.
    expect(isMinor(2008, 6, NOW)).toBe(false);
  });

  it('handles December births (month wraps to January next year)', () => {
    // 18th-year birth-month Dec 2026 → adult from Jan 1 2027 → still minor now.
    expect(isMinor(2008, 12, NOW)).toBe(true);
  });

  it('is adult for someone well over 18', () => {
    expect(isMinor(2000, 5, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/minor.test.ts`
Expected: FAIL — cannot resolve `@api/services/minor` / `isMinor` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/services/minor.ts

/**
 * Derived under-18 check (U18 spec D2/D3). Birth data is year+month only.
 * Conservative rounding: a ward is a minor through the WHOLE birth-month of
 * their 18th year, becoming an adult on the 1st of the following month
 * ("keep-minor-longer" — never treat a real minor as an adult). `is_minor`
 * is never stored; recompute from the stored year+month on every read.
 */
export function isMinor(
  birthYear: number,
  birthMonth: number, // 1-12
  now: Date = new Date(),
): boolean {
  let adultYear = birthYear + 18;
  let adultMonth = birthMonth + 1; // 1-12 → may be 13
  if (adultMonth > 12) {
    adultMonth = 1;
    adultYear += 1;
  }
  // First instant of the month the ward becomes an adult (UTC, day 1).
  const adultThreshold = Date.UTC(adultYear, adultMonth - 1, 1);
  return now.getTime() < adultThreshold;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/minor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/minor.ts apps/api/src/services/__tests__/minor.test.ts
git commit -m "feat(u18): add isMinor derivation helper (year+month, conservative rounding)"
```

---

### Task 2: `minor_guardian` table + migration

**Files:**
- Create: `apps/api/db/postgres/schema/minor_guardian.ts`
- Modify: `apps/api/db/postgres/schema/index.ts` (add the re-export)
- Generated: `apps/api/drizzle/*` (via `pnpm db:generate:api` — do not hand-edit)
- Generated: `apps/api/db/postgres/schema.sql` (via `pnpm schema:bundle`)

**Interfaces:**
- Produces: Drizzle table `minor_guardian` with columns `user_id` (PK), `birth_year`, `birth_month`, `guardian_name`, `guardian_contact`, `guardian_contact_type`, `guardian_verified`, `created_at`, `updated_at`. Later phases import `{ minor_guardian }` from the schema barrel.

- [ ] **Step 1: Write the table schema**

```ts
// apps/api/db/postgres/schema/minor_guardian.ts
import { pgTable, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * U18 guardian-consent record — one row per ward, keyed on the better-auth
 * user_id (U18 spec §4). birth_year/birth_month are plaintext (data
 * minimization: no exact day). `is_minor` is DERIVED at read time
 * (services/minor.ts), never a column. guardian_name / guardian_contact hold
 * PII and are encrypted at the write path in a later phase (columns stay
 * text). Guardian approvals + the ward attestation live in `consent_record`,
 * not here.
 */
export const minor_guardian = pgTable('minor_guardian', {
  userId: text('user_id').primaryKey(),
  birthYear: integer('birth_year').notNull(),
  birthMonth: integer('birth_month').notNull(),
  guardianName: text('guardian_name'),
  guardianContact: text('guardian_contact'),
  guardianContactType: text('guardian_contact_type'), // 'phone' | 'email'
  guardianVerified: boolean('guardian_verified').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

- [ ] **Step 2: Register it in the schema barrel**

Add this line to `apps/api/db/postgres/schema/index.ts` (alongside the other `export *` lines):

```ts
export * from './minor_guardian';
```

- [ ] **Step 3: Typecheck to confirm the table + barrel compile**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate:api`
Expected: a new file under `apps/api/drizzle/` creating `minor_guardian` (a `CREATE TABLE "minor_guardian" (...)`). Do not edit it by hand.

- [ ] **Step 5: Regenerate the deploy schema bundle**

Run: `pnpm schema:bundle`
Then verify it matches: `pnpm schema:bundle:check`
Expected: `schema.sql` now contains `minor_guardian`; the check passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/db/postgres/schema/minor_guardian.ts apps/api/db/postgres/schema/index.ts apps/api/drizzle apps/api/db/postgres/schema.sql
git commit -m "feat(u18): add minor_guardian table + migration"
```

---

### Task 3: `guardian_consent_required` domain flag + accessor

**Files:**
- Modify: `packages/schemas/src/network_workflow.ts` (add the field to `NetworkDomainSchema`)
- Modify: `apps/api/src/services/minor.ts` (add the accessor)
- Test: `apps/api/src/services/__tests__/minor.test.ts` (extend)

**Interfaces:**
- Consumes: `NetworkConfigDocument` from `@dpg/schemas` (each `domains[]` entry now carries optional `guardian_consent_required: boolean`, default `false`).
- Produces: `guardianConsentRequired(networkConfig: NetworkConfigDocument, domainId: string): boolean`.

- [ ] **Step 1: Add the flag to the domain schema**

In `packages/schemas/src/network_workflow.ts`, inside the `NetworkDomainSchema = z.object({ ... })` field list (e.g. right after `minimum_cache_ttl_seconds`), add:

```ts
  // U18 spec D8: when true, this domain routes minors' consent through a
  // guardian. Server-read only; never trusted from the client. Defaults off.
  guardian_consent_required: z.boolean().optional().default(false),
```

- [ ] **Step 2: Write the failing accessor test**

Append to `apps/api/src/services/__tests__/minor.test.ts`:

```ts
import { guardianConsentRequired } from '@api/services/minor';
import type { NetworkConfigDocument } from '@dpg/schemas';

const cfg = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
    { id: 'legacy' }, // flag absent → default false
  ],
} as unknown as NetworkConfigDocument;

describe('guardianConsentRequired', () => {
  it('is true when the domain opts in', () => {
    expect(guardianConsentRequired(cfg, 'seeker')).toBe(true);
  });

  it('is false when the domain opts out', () => {
    expect(guardianConsentRequired(cfg, 'provider')).toBe(false);
  });

  it('is false when the flag is absent', () => {
    expect(guardianConsentRequired(cfg, 'legacy')).toBe(false);
  });

  it('is false for an unknown domain', () => {
    expect(guardianConsentRequired(cfg, 'nope')).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/minor.test.ts`
Expected: FAIL — `guardianConsentRequired` is not exported.

- [ ] **Step 4: Add the accessor**

Append to `apps/api/src/services/minor.ts`:

```ts
import type { NetworkConfigDocument } from '@dpg/schemas';

/**
 * Whether a served domain routes minors through the guardian flow (U18 D8).
 * Read server-side at the gate; never trust a client-supplied value.
 */
export function guardianConsentRequired(
  networkConfig: NetworkConfigDocument,
  domainId: string,
): boolean {
  const domain = networkConfig.domains.find((entry) => entry.id === domainId);
  return domain?.guardian_consent_required ?? false;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/minor.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 6: Typecheck the whole API (confirms the schema field is typed through)**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src/network_workflow.ts apps/api/src/services/minor.ts apps/api/src/services/__tests__/minor.test.ts
git commit -m "feat(u18): add guardian_consent_required domain flag + accessor"
```

---

## Phase 1 exit criteria

- `isMinor` + `guardianConsentRequired` unit-tested and green.
- `minor_guardian` table migrated; deploy bundle regenerated and `schema:bundle:check` passes.
- `guardian_consent_required` parses on domains (default false) and is typed on `NetworkConfigDocument`.
- Full `pnpm --filter api exec tsc --noEmit` clean.

## Self-review notes

- **Spec coverage:** D2 (derived is_minor) → Task 1; §4 `minor_guardian` shape → Task 2; D8 flag → Task 3. Guardian PII **encryption**, `consent_record` writes, OTP, gates, and UI are **out of Phase 1** (later phases) — Task 2 stores guardian columns as plaintext `text` deliberately; encryption wraps them at the write path in the guardian-capture phase.
- **No placeholders:** every step has concrete code/commands.
- **Type consistency:** `isMinor(birthYear, birthMonth, now?)` and `guardianConsentRequired(networkConfig, domainId)` names/signatures are used identically in tests and impl; table column camelCase↔snake_case pairs match Drizzle convention.
