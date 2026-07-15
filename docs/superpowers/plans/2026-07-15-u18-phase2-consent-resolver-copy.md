# U18 Phase 2 — Consent Resolver Variant + U18 Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the consent stack about minors — add a `u18` document variant and a `guardian_declaration` category to the consent-config schema and the server-side version resolver, and seed distinct U18 copy in `consent.json` — so later phases can record guardian/ward consent at the correct version chosen server-side by `is_minor`.

**Architecture:** `consent.json` gains an optional `u18_documents` block (its own `terms`/`privacy`/`profile_creation` + a new `guardian_declaration` statement) that mirrors the existing adult `documents` block but is **never aliased** to it (spec D9). `resolveConsentVersion` gains a `variant: 'adult' | 'u18'` dimension (default `'adult'`) and the `guardian_declaration` category; when `variant === 'u18'` it reads from `u18_documents`. Callers pass `variant` based on `isMinor` in a later phase — Phase 2 only adds the capability + copy.

**Tech Stack:** TypeScript (ESM, strict), Zod (`@dpg/schemas`), Vitest.

## Global Constraints

- ESM only, strict TS, no `any`; `import type` for type-only imports.
- Reuse the shipped `consent_record` ledger + `consent.json`/`resolveConsentVersion` — **no new consent tables** (spec D4).
- U18 documents are their **own** versioned entries — **not** aliased to the adult copy (spec D9). Copy is placeholder-but-distinct now; legal finalizes wording later.
- `variant` defaults to `'adult'`; `guardian_declaration` is valid **only** under the `u18` variant.
- Version is always derived server-side; never trust a client version (existing invariant).
- Run one API test file: `pnpm --filter api exec vitest run <path>`. Run one schemas test: `pnpm --filter schemas exec vitest run <path>` (package name is `schemas`).

---

### Task 1: `u18_documents` in the consent-config schema

**Files:**
- Modify: `packages/schemas/src/consent_config.ts`
- Test: `packages/schemas/src/__tests__/consent_config.test.ts` (append)

**Interfaces:**
- Consumes: existing `ContentDocument`, `StatementDocument`, `documentWith(...)` builders in `consent_config.ts`.
- Produces: `ConsentConfigSchema` and `PartialConsentConfigSchema` now accept an optional `u18_documents` object with keys `terms` (Content), `privacy` (Content), `profile_creation` (Statement), `guardian_declaration` (Statement). Type `ConsentConfigDocument` gains `u18_documents?`.

- [ ] **Step 1: Add the U18 documents schema + wire it into both config schemas**

In `packages/schemas/src/consent_config.ts`, immediately **before** `export const ConsentConfigSchema = ...`, add:

```ts
// U18 (minor) document set — spec D9. Own versioned entries, never aliased to
// the adult `documents`. guardian_declaration is the ward's attestation that
// the named guardian is genuine (D12); it exists only in the U18 set.
const U18Documents = z.object({
  terms: ContentDocument,
  privacy: ContentDocument,
  profile_creation: StatementDocument,
  guardian_declaration: StatementDocument,
});

// Brand override: every U18 document optional (mirrors the adult partial).
const PartialU18Documents = z.object({
  terms: ContentDocument.optional(),
  privacy: ContentDocument.optional(),
  profile_creation: StatementDocument.optional(),
  guardian_declaration: StatementDocument.optional(),
});
```

Then add `u18_documents` to `ConsentConfigSchema` (after the `actions` line, still inside the `z.object({ ... })`):

```ts
  u18_documents: U18Documents.optional(),
```

And to `PartialConsentConfigSchema` (after its `actions` line):

```ts
  u18_documents: PartialU18Documents.optional(),
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/schemas/src/__tests__/consent_config.test.ts`:

```ts
describe('u18_documents', () => {
  const u18 = {
    terms: {
      current_version: 1,
      versions: [{ version: 1, title: 'U18 T', content: '# u18 terms', effective_from: '2026-07-01' }],
    },
    privacy: {
      current_version: 1,
      versions: [{ version: 1, title: 'U18 P', content: '# u18 privacy', effective_from: '2026-07-01' }],
    },
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'Guardian agrees to profile creation', effective_from: '2026-07-01' }],
    },
    guardian_declaration: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I confirm the named guardian is my parent/guardian', effective_from: '2026-07-01' }],
    },
  };

  it('accepts a config with a full u18_documents block', () => {
    const parsed = parseConsentConfigDocument({ ...valid, u18_documents: u18 });
    expect(parsed.u18_documents?.guardian_declaration.current_version).toBe(1);
  });

  it('still accepts a config with NO u18_documents (optional)', () => {
    const parsed = parseConsentConfigDocument(valid);
    expect(parsed.u18_documents).toBeUndefined();
  });

  it('rejects a u18_documents block missing guardian_declaration', () => {
    const { guardian_declaration: _drop, ...noDecl } = u18;
    expect(() => parseConsentConfigDocument({ ...valid, u18_documents: noDecl })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter schemas exec vitest run src/__tests__/consent_config.test.ts`

Expected: the new "u18_documents" tests fail (schema doesn't know the field yet — the "missing guardian_declaration" test would wrongly pass since unknown keys are ignored, and the `.guardian_declaration.current_version` access is `undefined`).

- [ ] **Step 4: (implementation already added in Step 1) Run tests to verify they pass**

Run: `pnpm --filter schemas exec vitest run src/__tests__/consent_config.test.ts`
Expected: all tests pass, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/consent_config.ts packages/schemas/src/__tests__/consent_config.test.ts
git commit -m "feat(u18): add u18_documents (incl. guardian_declaration) to consent-config schema"
```

---

### Task 2: `resolveConsentVersion` — `variant` + `guardian_declaration`

**Files:**
- Modify: `apps/api/src/services/consent_version.ts`
- Test: `apps/api/src/services/__tests__/consent_version.test.ts` (create)

**Interfaces:**
- Consumes: `getConfiguredNetworkSchemas` from `@/network_schema_cache` (returns entries with `kind: 'consent_config'`, `network`, `brand`, `schema`).
- Produces: `resolveConsentVersion(input)` where `input` gains `variant?: 'adult' | 'u18'` (default `'adult'`) and `category` now also accepts `'guardian_declaration'`. `ConsentDocumentCategory` exported type gains `'guardian_declaration'`.

- [ ] **Step 1: Extend the resolver**

In `apps/api/src/services/consent_version.ts`:

(a) Extend the category type:
```ts
/** User-level + item-level document categories with a versioned document. */
export type ConsentDocumentCategory =
  | 'terms'
  | 'privacy'
  | 'profile_creation'
  | 'guardian_declaration';
```

(b) Extend `ConsentConfigLike` to know the U18 block:
```ts
interface ConsentConfigLike {
  documents?: Partial<Record<ConsentDocumentCategory, DocLike>>;
  u18_documents?: Partial<Record<ConsentDocumentCategory, DocLike>>;
  actions?: Record<string, Partial<Record<ActionStage, DocLike>>>;
}
```

(c) Add `variant` to the input:
```ts
export interface ResolveConsentVersionInput {
  network: string;
  brand?: string | null;
  category: ConsentDocumentCategory | 'action';
  actionType?: string;
  stage?: ActionStage;
  /** Which document set applies. Defaults to the adult set. */
  variant?: 'adult' | 'u18';
}
```

(d) Replace the document-resolution tail of `resolveConsentVersion` (the part after the `if (input.category === 'action') { ... }` block) with variant-aware lookup:
```ts
  const variant = input.variant ?? 'adult';

  // guardian_declaration exists only in the U18 set.
  if (input.category === 'guardian_declaration' && variant !== 'u18') {
    return null;
  }

  const pick = (cfg: ConsentConfigLike | undefined) =>
    variant === 'u18' ? cfg?.u18_documents : cfg?.documents;

  const doc =
    pick(brand)?.[input.category] ?? pick(def)?.[input.category];
  return typeof doc?.current_version === 'number' ? doc.current_version : null;
```
(Leave the `action` branch above it unchanged — action statements are not variant-split in this phase.)

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/services/__tests__/consent_version.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfiguredNetworkSchemas = vi.fn();
vi.mock('@/network_schema_cache', () => ({
  getConfiguredNetworkSchemas: () => getConfiguredNetworkSchemas(),
}));

import { resolveConsentVersion } from '@/services/consent_version';

const consentConfig = {
  documents: {
    terms: { current_version: 3 },
    privacy: { current_version: 1 },
    profile_creation: { current_version: 1 },
  },
  u18_documents: {
    terms: { current_version: 5 },
    privacy: { current_version: 2 },
    profile_creation: { current_version: 1 },
    guardian_declaration: { current_version: 1 },
  },
};

beforeEach(() => {
  getConfiguredNetworkSchemas.mockResolvedValue([
    { kind: 'consent_config', network: 'blue_dot', brand: null, schema: consentConfig },
  ]);
});

describe('resolveConsentVersion variant', () => {
  it('defaults to the adult document set', async () => {
    expect(await resolveConsentVersion({ network: 'blue_dot', category: 'terms' })).toBe(3);
  });

  it('reads the u18 set when variant is u18', async () => {
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'terms', variant: 'u18' }),
    ).toBe(5);
  });

  it('resolves guardian_declaration only under the u18 variant', async () => {
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'guardian_declaration', variant: 'u18' }),
    ).toBe(1);
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'guardian_declaration', variant: 'adult' }),
    ).toBeNull();
  });

  it('returns null when the u18 set is not configured', async () => {
    getConfiguredNetworkSchemas.mockResolvedValue([
      { kind: 'consent_config', network: 'blue_dot', brand: null, schema: { documents: consentConfig.documents } },
    ]);
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'terms', variant: 'u18' }),
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/consent_version.test.ts`
Expected: FAIL — before Step 1's edit is in place, `variant`/`guardian_declaration` aren't handled (u18 lookups return the adult value or throw on the type). If Step 1 was already applied, run the test first against a stashed copy, or trust the red→green ordering by writing the test before editing. If you applied Step 1 already, proceed to Step 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/consent_version.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0. (Confirms no caller breaks on the widened `ConsentDocumentCategory`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/consent_version.ts apps/api/src/services/__tests__/consent_version.test.ts
git commit -m "feat(u18): resolveConsentVersion variant (adult|u18) + guardian_declaration"
```

---

### Task 3: Seed distinct U18 copy in `consent.json`

**Files:**
- Modify: `examples/schemas/blue_dot/consent.json`
- Modify: `examples/schemas/purple_dot/consent.json`
- Test: `apps/api/src/services/__tests__/u18_consent_copy.test.ts` (create)

> **Fixture vs canonical:** `examples/schemas/*` are the local dev/test fixtures the loader reads. The canonical copies live in the `bluedots-allusecase-schemas` repo and get the same `u18_documents` block in a follow-up PR there. This task seeds the fixtures only. Copy is **placeholder-but-distinct** (clearly U18 wording); legal finalizes later (spec D9, open Q4).

**Interfaces:**
- Consumes: `parseConsentConfigDocument` from `@dpg/schemas` (Task 1's extended schema).
- Produces: both fixtures carry a valid `u18_documents` block with `guardian_declaration`.

- [ ] **Step 1: Add `u18_documents` to `examples/schemas/blue_dot/consent.json`**

Add this key as a sibling of the existing `documents` and `actions` keys (i.e. a new top-level `"u18_documents"` object):

```json
"u18_documents": {
  "terms": {
    "current_version": 1,
    "versions": [
      {
        "version": 1,
        "title": "Terms of Use (Under 18)",
        "content": "These terms are agreed to by the parent or guardian of a user under 18. The guardian accepts responsibility for the minor's use of this service. [Placeholder — pending legal.]",
        "effective_from": "2026-07-01"
      }
    ]
  },
  "privacy": {
    "current_version": 1,
    "versions": [
      {
        "version": 1,
        "title": "Privacy Notice (Under 18)",
        "content": "This notice explains how a minor's data is handled, agreed to by their parent or guardian. [Placeholder — pending legal.]",
        "effective_from": "2026-07-01"
      }
    ]
  },
  "profile_creation": {
    "current_version": 1,
    "versions": [
      {
        "version": 1,
        "statement": "As the parent/guardian, I consent to creating and listing this profile on behalf of the minor.",
        "effective_from": "2026-07-01"
      }
    ]
  },
  "guardian_declaration": {
    "current_version": 1,
    "versions": [
      {
        "version": 1,
        "statement": "I confirm I am the parent/legal guardian of this user and the contact details provided are mine.",
        "effective_from": "2026-07-01"
      }
    ]
  }
}
```

- [ ] **Step 2: Add the identical `u18_documents` block to `examples/schemas/purple_dot/consent.json`**

Add the same `"u18_documents"` object (verbatim as Step 1) as a top-level sibling of `documents`/`actions` in `examples/schemas/purple_dot/consent.json`.

- [ ] **Step 3: Write the failing test**

Create `apps/api/src/services/__tests__/u18_consent_copy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConsentConfigDocument } from '@dpg/schemas';

// Repo-root-relative to this test file: __tests__ → services → src → api → apps → root.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));

const dots = ['blue_dot', 'purple_dot'] as const;

describe('U18 consent copy fixtures', () => {
  for (const dot of dots) {
    it(`${dot}/consent.json parses with a distinct u18_documents block`, () => {
      const raw = JSON.parse(
        readFileSync(`${root}examples/schemas/${dot}/consent.json`, 'utf8'),
      );
      const parsed = parseConsentConfigDocument(raw);
      expect(parsed.u18_documents?.guardian_declaration.current_version).toBe(1);
      // Distinct from adult (not aliased): U18 profile_creation statement differs.
      expect(parsed.u18_documents?.profile_creation.versions[0].statement).not.toBe(
        parsed.documents.profile_creation.versions[0].statement,
      );
    });
  }
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/u18_consent_copy.test.ts`
Expected: FAIL before Steps 1–2 are saved (no `u18_documents` → `undefined.guardian_declaration`). After Steps 1–2, it should pass — if you edited the JSON first, this step confirms green instead.

- [ ] **Step 5: Confirm the whole consent-config test surface is green**

Run: `pnpm --filter api exec vitest run src/services/__tests__/u18_consent_copy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add examples/schemas/blue_dot/consent.json examples/schemas/purple_dot/consent.json apps/api/src/services/__tests__/u18_consent_copy.test.ts
git commit -m "feat(u18): seed distinct U18 consent copy for blue_dot + purple_dot fixtures"
```

---

## Phase 2 exit criteria

- `consent.json` schema accepts an optional `u18_documents` block (terms/privacy/profile_creation/guardian_declaration); a present block missing `guardian_declaration` is rejected.
- `resolveConsentVersion({ variant: 'u18' })` reads the U18 set; default stays adult; `guardian_declaration` resolves only under `u18`; missing U18 set → `null`.
- `blue_dot` + `purple_dot` fixtures carry valid, distinct U18 copy that parses.
- `pnpm --filter api exec tsc --noEmit` clean.

## Self-review notes

- **Spec coverage:** §4 resolver extension (u18 variant + guardian_declaration) → Tasks 1+2; D9 distinct U18 copy → Task 3. Wiring callers to pass `variant` from `isMinor` is **Phase 4/5** (guardian capture + gates), not here — Phase 2 only adds the capability + copy. Action-statement variant is intentionally out of scope (guardian accepts the existing action statements; note if product later wants U18 action copy).
- **No placeholders:** all code/JSON/commands are concrete. The consent *content strings* are deliberately marked "[Placeholder — pending legal]" per D9/open-Q4 — this is spec-mandated content, not a plan gap.
- **Type consistency:** `variant: 'adult' | 'u18'`, category `'guardian_declaration'`, and the `u18_documents` key are spelled identically across schema (Task 1), resolver (Task 2), and fixtures/tests (Task 3).
