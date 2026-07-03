# Consent v1 — Phase 1: Schema + Config Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `consent_record` ledger table and the `consent.json` config layer (loaded per-network with brand-scoped entries) served through the existing schema pipeline — the foundation the terms/privacy, profile, and action phases build on.

**Architecture:** UI-merge + backend-ledger (spec §1.1). The backend loads `consent.json` alongside `network.json`, caches it as a `consent_config` schema entry (network-default + brand-scoped), and serves it via `GET /api/v1/network/schemas`. This phase adds **no consumer changes** — the existing `network.json` consent fields stay in place (removed in Phase 4), so nothing breaks.

**Tech Stack:** Fastify + Zod (`fastify-type-provider-zod`), Drizzle ORM + `drizzle-zod`, Postgres, Node ≥24, pnpm workspace (`@dpg/*`), vitest.

## Global Constraints

- Files are **snake_case**; route handler exports snake_case, internal fns camelCase; Zod schemas PascalCase; **DB columns snake_case**.
- **ESM only**, strict TS, **no `any`**; use `import type` for type-only imports.
- **No `// TODO`** comments; **no `console.log`** in library packages.
- **Never hand-edit migration files** — regenerate via `pnpm db:generate:api`.
- New env vars require **two edits together**: the Zod schema in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv`.
- Routes never throw across boundaries — return `reply.code(N).send({ error, message })`.
- The API process runs from `apps/api/`; local config paths are relative to that (`../../examples/...`).
- After editing files, the repo's Codacy rule expects `codacy_cli_analyze` on changed files (skip complexity/coverage).

---

## File Structure

- **Create** `apps/api/db/postgres/schema/consent_record.ts` — the ledger table (app-local, not a `@dpg/database` ref table).
- **Modify** `apps/api/db/postgres/schema/index.ts` — export the new table.
- **Create** `packages/schemas/src/consent_config.ts` — `ConsentConfigSchema` (Zod) + `parseConsentConfigDocument` + types.
- **Modify** `packages/schemas/src/index.ts` — re-export consent-config symbols.
- **Create** `packages/schemas/src/__tests__/consent_config.test.ts` — schema validation tests.
- **Create** `packages/config/src/consent_config_loader.ts` — `loadConsentConfigs` (network-default + brand-scoped, local + remote).
- **Modify** `packages/config/src/index.ts` — export the loader.
- **Create** `packages/config/src/__tests__/consent_config_loader.test.ts` — loader tests (local mode, brand scan).
- **Modify** `packages/config/src/secrets.ts` — `CONSENT_CONFIG_*` env.
- **Modify** `turbo.json` — pass through `CONSENT_CONFIG_*`.
- **Modify** `apps/api/src/config.ts` — surface consent config on `apiConfig`.
- **Create** `apps/api/src/consent_configs.ts` — `getConsentConfigs()` accessor (mirrors `network_configs.ts`).
- **Modify** `apps/api/src/network_schema_cache.ts` — add `consent_config` kind + `brand` field; cache & serve consent configs.
- **Create** seed files: `examples/schemas/blue_dot/consent.json`, `examples/schemas/blue_dot/upsdm/consent.json`, `examples/schemas/purple_dot/consent.json`, `examples/schemas/yellow_dot/consent.json`.

---

## Task 1: `consent_record` ledger table

**Files:**
- Create: `apps/api/db/postgres/schema/consent_record.ts`
- Modify: `apps/api/db/postgres/schema/index.ts`
- Verify: migration output + typecheck

**Interfaces:**
- Produces: the `consent_record` Drizzle table with columns `id, seq, level, consent_category, action_type, action_stage, user_id, item_id, action_id, network, brand, document_version, source, accepted_at, created_at, metadata`. Later phases import `consent_record` from `@api/db/postgres/schema`.

- [ ] **Step 1: Write the table schema file**

Create `apps/api/db/postgres/schema/consent_record.ts`, following the `pii_reveal_audit.ts` pattern:

```typescript
import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  bigserial,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Append-only consent ledger (spec 2026-06-30 minimal v1). One row per consent
 * event. Latest event per (subject, type) wins by `seq`, never by timestamp.
 *
 * Levels: `user` (terms/privacy — keyed on user_id) and `item`
 * (profile_creation + action — keyed on item_id, plus action_id for actions).
 * No FK to items/item_actions — both are partitioned; app-level integrity only.
 * Content is NOT stored; it is resolved from consent.json by (type, version).
 */
export const consent_record = pgTable(
  'consent_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    level: text('level').notNull(), // 'user' | 'item'
    consentCategory: text('consent_category').notNull(), // terms|privacy|profile_creation|action
    actionType: text('action_type'), // only for 'action' (e.g. connect, apply)
    actionStage: text('action_stage'), // only for 'action': 'initiate' | 'accept'
    userId: text('user_id').notNull(),
    itemId: uuid('item_id'), // set for item-level rows
    actionId: uuid('action_id'), // set for action rows
    network: text('network').notNull(),
    brand: text('brand'), // which brand variant applied (client-supplied)
    documentVersion: integer('document_version').notNull(),
    source: text('source').notNull(), // signup|login|profile|action
    acceptedAt: timestamp('accepted_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('consent_record_user_idx').on(
      table.userId,
      table.consentCategory,
      table.actionType,
      table.actionStage,
      table.seq
    ),
    index('consent_record_item_idx').on(table.itemId, table.consentCategory),
    index('consent_record_action_idx').on(table.actionId),
  ]
);
```

- [ ] **Step 2: Export the table**

Modify `apps/api/db/postgres/schema/index.ts` — add the line after the existing exports:

```typescript
export * from './auth';
export * from './metrics';
export * from './pii_reveal_audit';
export * from './consent_record';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS (no errors referencing `consent_record`).

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate:api`
Expected: a new migration file appears under `apps/api/drizzle/` containing `CREATE TABLE "consent_record"` with the columns and three indexes above. (Migrations are gitignored — this verifies Drizzle accepts the schema; do not hand-edit it.)

- [ ] **Step 5: Apply and smoke-test against a running DB (integration)**

Run:
```bash
docker compose up -d db redis
pnpm db:push:api
```
Then create `apps/api/src/__tests__/consent_record.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { eq } from 'drizzle-orm';

describe('consent_record table', () => {
  it('inserts and reads a user-level row', async () => {
    const userId = `test-user-${Date.now()}`;
    await db.insert(consent_record).values({
      level: 'user',
      consentCategory: 'terms',
      userId,
      network: 'blue_dot',
      documentVersion: 1,
      source: 'signup',
      acceptedAt: new Date(),
    });
    const rows = await db
      .select()
      .from(consent_record)
      .where(eq(consent_record.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].consentCategory).toBe('terms');
    expect(rows[0].seq).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run the integration test**

Run: `pnpm --filter api test:integration consent_record`
Expected: PASS (row inserted, `seq` auto-populated).

- [ ] **Step 7: Commit**

```bash
git add apps/api/db/postgres/schema/consent_record.ts apps/api/db/postgres/schema/index.ts apps/api/src/__tests__/consent_record.integration.test.ts
git commit -m "feat(db): consent_record ledger table (#99)"
```

---

## Task 2: `ConsentConfigSchema` (Zod) in `@dpg/schemas`

**Files:**
- Create: `packages/schemas/src/consent_config.ts`
- Modify: `packages/schemas/src/index.ts`
- Test: `packages/schemas/src/__tests__/consent_config.test.ts`

**Interfaces:**
- Produces: `ConsentConfigSchema`, `PartialConsentConfigSchema` (for brand overrides), `parseConsentConfigDocument(input: unknown): ConsentConfigDocument`, and types `ConsentConfigDocument`, `PartialConsentConfig`, `ConsentDocumentVersions`. Enforces: `current_version` must exist in `versions`; `version` ints unique & ≥1 within a document; `documents.terms/privacy` use `content`, `profile_creation` and action stages use `statement`.
- **Zod 4 note:** this repo is on Zod 4 (`z.uuid()`/`z.url()` are v4). `.deepPartial()` does **not** exist in v4 — the brand-override partial is built explicitly below, not derived.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/__tests__/consent_config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseConsentConfigDocument } from '../consent_config';

const valid = {
  documents: {
    terms: {
      current_version: 2,
      versions: [
        { version: 1, title: 'T', content: '# v1', effective_from: '2026-06-01' },
        { version: 2, title: 'T', content: '# v2', effective_from: '2026-07-01' },
      ],
    },
    privacy: {
      current_version: 1,
      versions: [{ version: 1, title: 'P', content: '# p', effective_from: '2026-06-01' }],
    },
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I agree', effective_from: '2026-06-01' }],
    },
  },
  actions: {
    connect: {
      initiate: { current_version: 1, versions: [{ version: 1, statement: 'init', effective_from: '2026-06-01' }] },
      accept: { current_version: 1, versions: [{ version: 1, statement: 'acc', effective_from: '2026-06-01' }] },
    },
  },
};

describe('parseConsentConfigDocument', () => {
  it('accepts a valid config', () => {
    const parsed = parseConsentConfigDocument(valid);
    expect(parsed.documents.terms.current_version).toBe(2);
    expect(parsed.actions?.connect?.initiate.versions).toHaveLength(1);
  });

  it('rejects current_version not present in versions', () => {
    const bad = structuredClone(valid);
    bad.documents.terms.current_version = 99;
    expect(() => parseConsentConfigDocument(bad)).toThrow();
  });

  it('rejects duplicate version ints in one document', () => {
    const bad = structuredClone(valid);
    bad.documents.privacy.versions.push({ version: 1, title: 'P', content: 'dup', effective_from: '2026-08-01' });
    expect(() => parseConsentConfigDocument(bad)).toThrow();
  });

  it('allows actions to be omitted (network with no actions)', () => {
    const noActions = structuredClone(valid);
    delete (noActions as { actions?: unknown }).actions;
    expect(() => parseConsentConfigDocument(noActions)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/consent_config.test.ts`
Expected: FAIL with "Cannot find module '../consent_config'".

- [ ] **Step 3: Write the schema**

Create `packages/schemas/src/consent_config.ts`:

```typescript
import z from 'zod';

const EffectiveFrom = z.string().min(1); // ISO date string; content, not validated as date in v1

const ContentVersion = z.object({
  version: z.number().int().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  effective_from: EffectiveFrom,
});

const StatementVersion = z.object({
  version: z.number().int().min(1),
  statement: z.string().trim().min(1).max(1000),
  effective_from: EffectiveFrom,
});

function documentWith<T extends z.ZodTypeAny>(versionSchema: T) {
  return z
    .object({
      current_version: z.number().int().min(1),
      versions: z.array(versionSchema).min(1),
    })
    .superRefine((doc, ctx) => {
      const nums = doc.versions.map((v) => (v as { version: number }).version);
      if (new Set(nums).size !== nums.length) {
        ctx.addIssue({ code: 'custom', message: 'version ints must be unique within a document' });
      }
      if (!nums.includes(doc.current_version)) {
        ctx.addIssue({ code: 'custom', message: `current_version ${doc.current_version} is not present in versions` });
      }
    });
}

const ContentDocument = documentWith(ContentVersion);
const StatementDocument = documentWith(StatementVersion);

const ActionStages = z.object({
  initiate: StatementDocument,
  accept: StatementDocument,
});

export const ConsentConfigSchema = z.object({
  documents: z.object({
    terms: ContentDocument,
    privacy: ContentDocument,
    profile_creation: StatementDocument,
  }),
  actions: z.record(z.string().min(1), ActionStages).optional(),
});

// Brand overrides are a partial document set — each document is optional. Built
// explicitly because Zod 4 has no `.deepPartial()`.
export const PartialConsentConfigSchema = z.object({
  documents: z
    .object({
      terms: ContentDocument.optional(),
      privacy: ContentDocument.optional(),
      profile_creation: StatementDocument.optional(),
    })
    .optional(),
  actions: z.record(z.string().min(1), ActionStages).optional(),
});

export type ConsentConfigDocument = z.infer<typeof ConsentConfigSchema>;
export type PartialConsentConfig = z.infer<typeof PartialConsentConfigSchema>;
export type ConsentDocumentVersions = z.infer<typeof ContentDocument>;

export function parseConsentConfigDocument(input: unknown): ConsentConfigDocument {
  return ConsentConfigSchema.parse(input);
}
```

- [ ] **Step 4: Re-export from the package index**

Modify `packages/schemas/src/index.ts` — add after the `api/*` exports (e.g. after line 5):

```typescript
export * from './consent_config';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/consent_config.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/consent_config.ts packages/schemas/src/index.ts packages/schemas/src/__tests__/consent_config.test.ts
git commit -m "feat(schemas): ConsentConfigSchema with version-history validation (#99)"
```

---

## Task 3: Seed `consent.json` files

**Files:**
- Create: `examples/schemas/blue_dot/consent.json`
- Create: `examples/schemas/blue_dot/upsdm/consent.json`
- Create: `examples/schemas/purple_dot/consent.json`
- Create: `examples/schemas/yellow_dot/consent.json`

**Interfaces:**
- Consumes: `ConsentConfigSchema` (Task 2) — every seed must parse clean.
- Produces: on-disk configs the loader (Task 4) reads. `blue_dot` has `connect` + `apply`; `purple_dot`/`yellow_dot` have `connect` only; `upsdm` overrides only `privacy`.

- [ ] **Step 1: Write `blue_dot` default**

Create `examples/schemas/blue_dot/consent.json` (statements copied from the current `network.json` intent — see spec §2). Full content:

```json
{
  "documents": {
    "terms": {
      "current_version": 1,
      "versions": [
        { "version": 1, "title": "Terms of Service", "content": "# Terms of Service\n\nBy using Blue Dots you agree to these terms.", "effective_from": "2026-06-01" }
      ]
    },
    "privacy": {
      "current_version": 1,
      "versions": [
        { "version": 1, "title": "Privacy Policy", "content": "# Privacy Policy\n\nWe process your data to match you with services and opportunities.", "effective_from": "2026-06-01" }
      ]
    },
    "profile_creation": {
      "current_version": 1,
      "versions": [
        { "version": 1, "statement": "The information collected will be used to match you with services and opportunities. You can opt out anytime by pausing, or deleting your profile in the portal. Tap \"I agree to continue\".", "effective_from": "2026-06-01" }
      ]
    }
  },
  "actions": {
    "connect": {
      "initiate": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my organisation's contact details with this organisation if they accept my request. The request may be cancelled at any time.", "effective_from": "2026-06-01" } ] },
      "accept": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my organisation's contact details with the requester.", "effective_from": "2026-06-01" } ] }
    },
    "apply": {
      "initiate": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my profile contact details with this organization if my application is accepted.", "effective_from": "2026-06-01" } ] },
      "accept": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my organisation's contact details with the applicant.", "effective_from": "2026-06-01" } ] }
    }
  }
}
```

- [ ] **Step 2: Write the `upsdm` brand override (privacy only)**

Create `examples/schemas/blue_dot/upsdm/consent.json`:

```json
{
  "documents": {
    "privacy": {
      "current_version": 1,
      "versions": [
        { "version": 1, "title": "UPSDM Privacy Policy", "content": "# UPSDM Privacy Policy\n\nUP Skill Development Mission processes your data to match you with opportunities.", "effective_from": "2026-06-15" }
      ]
    }
  }
}
```

Note: a brand override is a **partial** document set (only the documents it changes). The full `ConsentConfigSchema` requires all three documents, so the loader validates brand overrides with a **partial** schema (Task 4), not `ConsentConfigSchema`.

- [ ] **Step 3: Write `purple_dot` (connect only) and `yellow_dot` (connect only)**

Create `examples/schemas/purple_dot/consent.json`:

```json
{
  "documents": {
    "terms": { "current_version": 1, "versions": [ { "version": 1, "title": "Terms of Service", "content": "# Terms of Service", "effective_from": "2026-06-01" } ] },
    "privacy": { "current_version": 1, "versions": [ { "version": 1, "title": "Privacy Policy", "content": "# Privacy Policy", "effective_from": "2026-06-01" } ] },
    "profile_creation": { "current_version": 1, "versions": [ { "version": 1, "statement": "The information collected will be used to match you with services and opportunities. You can opt out anytime by pausing, or deleting your profile in the portal. Tap \"I agree to continue\".", "effective_from": "2026-06-01" } ] }
  },
  "actions": {
    "connect": {
      "initiate": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider if they accept my request. The request may be cancelled at any time.", "effective_from": "2026-06-01" } ] },
      "accept": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider.", "effective_from": "2026-06-01" } ] }
    }
  }
}
```

Create `examples/schemas/yellow_dot/consent.json` — same shape as `purple_dot` (yellow_dot has `connect` with no PII today, but seed the statements so the config is complete; required-ness stays governed by `reveals_pii_on_status` in `network.json`):

```json
{
  "documents": {
    "terms": { "current_version": 1, "versions": [ { "version": 1, "title": "Terms of Service", "content": "# Terms of Service", "effective_from": "2026-06-01" } ] },
    "privacy": { "current_version": 1, "versions": [ { "version": 1, "title": "Privacy Policy", "content": "# Privacy Policy", "effective_from": "2026-06-01" } ] },
    "profile_creation": { "current_version": 1, "versions": [ { "version": 1, "statement": "The information collected will be used to match you with services and opportunities. You can opt out anytime by pausing, or deleting your profile in the portal. Tap \"I agree to continue\".", "effective_from": "2026-06-01" } ] }
  },
  "actions": {
    "connect": {
      "initiate": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my contact details with this connection if they accept my request.", "effective_from": "2026-06-01" } ] },
      "accept": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my contact details with this connection.", "effective_from": "2026-06-01" } ] }
    }
  }
}
```

(`orange_dot` has no actions and no consent flow wired; skip a seed there — the loader treats a missing file as "no consent config for this network".)

- [ ] **Step 4: Validate every seed against the schema**

Create a throwaway check (run, then delete it — do not commit):

```bash
node --input-type=module -e "
import { parseConsentConfigDocument } from './packages/schemas/src/consent_config.ts';
import { readFileSync } from 'node:fs';
for (const f of ['blue_dot','purple_dot','yellow_dot']) {
  parseConsentConfigDocument(JSON.parse(readFileSync('examples/schemas/'+f+'/consent.json','utf8')));
  console.log(f, 'OK');
}
"
```

Expected: `blue_dot OK`, `purple_dot OK`, `yellow_dot OK`. (If your Node cannot import `.ts` directly, validate instead via a temporary vitest in `packages/schemas`.)

- [ ] **Step 5: Commit**

```bash
git add examples/schemas/blue_dot/consent.json examples/schemas/blue_dot/upsdm/consent.json examples/schemas/purple_dot/consent.json examples/schemas/yellow_dot/consent.json
git commit -m "feat(config): seed per-network consent.json + upsdm brand override (#99)"
```

---

## Task 4: Consent config loader in `@dpg/config`

**Files:**
- Create: `packages/config/src/consent_config_loader.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/secrets.ts`
- Modify: `turbo.json`
- Test: `packages/config/src/__tests__/consent_config_loader.test.ts`

**Interfaces:**
- Consumes: `parseConsentConfigDocument`, `ConsentConfigSchema` (Task 2).
- Produces:
  - `type LoadedConsentConfig = { network: string; brand: string | null; config: ConsentConfigDocument | PartialConsentConfig }`
  - `async function loadConsentConfigs(opts: { source: 'local' | 'remote'; networkLocalFile: string; networks: string[] }): Promise<LoadedConsentConfig[]>`
  - Local mode: reads `<dir(networkLocalFile)>/consent.json` (network default, full schema) and scans immediate sub-folders `<dir>/<brand>/consent.json` (brand overrides, partial schema). A missing default file yields no entries for that network.

- [ ] **Step 1: Write the failing test**

Create `packages/config/src/__tests__/consent_config_loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConsentConfigs } from '../consent_config_loader';

// examples/ lives at repo root; tests run from packages/config, so go up two levels.
const blueNetworkFile = resolve(__dirname, '../../../../examples/schemas/blue_dot/network.json');

describe('loadConsentConfigs (local)', () => {
  it('loads the network default and the upsdm brand override for blue_dot', async () => {
    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: blueNetworkFile,
      networks: ['blue_dot'],
    });

    const def = loaded.find((e) => e.network === 'blue_dot' && e.brand === null);
    expect(def).toBeDefined();
    expect(def!.config.documents.terms.current_version).toBe(1);

    const upsdm = loaded.find((e) => e.network === 'blue_dot' && e.brand === 'upsdm');
    expect(upsdm).toBeDefined();
    // brand override is partial — only privacy present
    expect(upsdm!.config.documents.privacy).toBeDefined();
    expect(upsdm!.config.documents.terms).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/consent_config_loader.test.ts`
Expected: FAIL with "Cannot find module '../consent_config_loader'".

- [ ] **Step 3: Write the loader**

Create `packages/config/src/consent_config_loader.ts`:

```typescript
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  PartialConsentConfigSchema,
  parseConsentConfigDocument,
  type ConsentConfigDocument,
  type PartialConsentConfig,
} from '@dpg/schemas';

// A brand override is a partial document set (each top-level document optional);
// the UI merges it over the network default. PartialConsentConfigSchema is defined
// in @dpg/schemas (Zod 4 has no `.deepPartial()`).

export type LoadedConsentConfig = {
  network: string;
  brand: string | null;
  config: ConsentConfigDocument | PartialConsentConfig;
};

type LoadConsentConfigOptions = {
  source: 'local' | 'remote';
  networkLocalFile: string;
  networks: string[];
};

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Local mode: the network default consent.json sits beside network.json; brand
 * overrides live in immediate sub-folders named for the brand id.
 *
 * Remote mode: v1 supports the network default only, derived by swapping the
 * network config URL's filename to consent.json. Brand-scoped remote delivery is
 * a documented follow-up (spec §1.1 / Phase 1 notes) and returns [] for brands.
 */
export async function loadConsentConfigs(
  opts: LoadConsentConfigOptions
): Promise<LoadedConsentConfig[]> {
  if (opts.source !== 'local') {
    // Remote handling is out of scope for this task's local-dev path; return [].
    // (Implemented alongside remote network-config delivery in a follow-up.)
    return [];
  }

  const baseDir = dirname(resolve(process.cwd(), opts.networkLocalFile));
  const results: LoadedConsentConfig[] = [];

  for (const network of opts.networks) {
    const defaultRaw = await readJsonIfExists(join(baseDir, 'consent.json'));
    if (!defaultRaw) continue; // no consent config for this network

    results.push({
      network,
      brand: null,
      config: parseConsentConfigDocument(defaultRaw),
    });

    for (const brand of await listSubdirectories(baseDir)) {
      const brandRaw = await readJsonIfExists(join(baseDir, brand, 'consent.json'));
      if (!brandRaw) continue;
      results.push({
        network,
        brand,
        config: PartialConsentConfigSchema.parse(brandRaw),
      });
    }
  }

  return results;
}
```

Note: local mode loads relative to the single `networkLocalFile` directory, matching how `network_config_loader` treats local mode as one network. `opts.networks` is the served network id(s) used to tag entries.

- [ ] **Step 4: Export from the package index**

Modify `packages/config/src/index.ts` — add:

```typescript
export * from './consent_config_loader';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/consent_config_loader.test.ts`
Expected: PASS.

- [ ] **Step 6: Add env vars (schema + turbo together)**

Modify `packages/config/src/secrets.ts` — inside `NetworkRuntimeSecretsSchema`, add after `NETWORK_CONFIG_URLS`:

```typescript
  CONSENT_CONFIG_SOURCE: z.enum(['local', 'remote']).default('local'),
```

Modify `turbo.json` `globalPassThroughEnv` — the existing `"NETWORK_CONFIG_*"` glob does **not** cover `CONSENT_CONFIG_*`, so add a line near it:

```json
    "CONSENT_CONFIG_*",
```

(Consent local paths are derived from `NETWORK_CONFIG_LOCAL_FILE`'s directory, so no separate local-file env is needed in v1.)

- [ ] **Step 7: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/config/src/consent_config_loader.ts packages/config/src/index.ts packages/config/src/secrets.ts packages/config/src/__tests__/consent_config_loader.test.ts turbo.json
git commit -m "feat(config): consent.json loader (local default + brand scan) (#99)"
```

---

## Task 5: Serve consent config through the schema pipeline

**Files:**
- Create: `apps/api/src/consent_configs.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/network_schema_cache.ts`
- Test: `apps/api/src/__tests__/consent_config_serving.integration.test.ts`

**Interfaces:**
- Consumes: `loadConsentConfigs`, `LoadedConsentConfig` (Task 4); `apiConfig` (existing).
- Produces: cached schema entries with `kind: 'consent_config'` and an optional `brand` field, returned by `GET /api/v1/network/schemas?network=`. Network default → `brand` absent; brand override → `brand` set.

- [ ] **Step 1: Add the consent-config accessor (mirrors `network_configs.ts`)**

Create `apps/api/src/consent_configs.ts`:

```typescript
import { loadConsentConfigs, type LoadedConsentConfig } from '@dpg/config';
import { apiConfig } from '@/config';

let consentConfigsPromise: Promise<LoadedConsentConfig[]> | null = null;

function loadAll(): Promise<LoadedConsentConfig[]> {
  const networks = [
    ...new Set(apiConfig.served_domains.map((binding) => binding.network)),
  ];
  return loadConsentConfigs({
    source: apiConfig.consent_config_source,
    networkLocalFile: apiConfig.network_config_local_file,
    networks,
  });
}

export async function getConsentConfigs(): Promise<LoadedConsentConfig[]> {
  if (!consentConfigsPromise) {
    consentConfigsPromise = loadAll();
  }
  return consentConfigsPromise;
}

export async function refreshConsentConfigs(): Promise<LoadedConsentConfig[]> {
  consentConfigsPromise = loadAll();
  return consentConfigsPromise;
}
```

- [ ] **Step 2: Surface the source flag on `apiConfig`**

Modify `apps/api/src/config.ts` — add to the `apiConfig` object (after `network_config_urls`):

```typescript
  consent_config_source: networkRuntime.CONSENT_CONFIG_SOURCE,
```

- [ ] **Step 3: Extend the cache to know the `consent_config` kind + `brand`**

Modify `apps/api/src/network_schema_cache.ts`:

3a. Add `'consent_config'` to the `CachedSchemaKind` union:

```typescript
type CachedSchemaKind =
  | 'network_config'
  | 'domain_item_schema'
  | 'instance_custom_item_schema'
  | 'item_schema_url'
  | 'consent_config';
```

3b. Add an optional `brand` field to `CachedSchemaIndexEntry`:

```typescript
type CachedSchemaIndexEntry = {
  cache_key: string;
  kind: CachedSchemaKind;
  network?: string;
  brand?: string;
  domain?: string;
  item_type?: string;
  instance_url?: string;
  schema_url?: string;
  source: 'inline' | 'remote';
  cached_at: string;
  file_name: string;
};
```

3c. Add a caching function (place near `cacheNetworkConfigSchemas`), and import the accessor at the top:

```typescript
import { refreshConsentConfigs } from '@/consent_configs';
```

```typescript
async function cacheConsentConfigs() {
  const consentConfigs = await refreshConsentConfigs();
  for (const entry of consentConfigs) {
    await cacheSchemaDocument(
      {
        cache_key: createCacheKey([
          'consent_config',
          entry.network,
          entry.brand ?? undefined,
        ]),
        kind: 'consent_config',
        network: entry.network,
        brand: entry.brand ?? undefined,
        source: 'inline',
      },
      entry.config as Record<string, unknown>
    );
  }
}
```

- [ ] **Step 4: Wire it into refresh + first-load paths**

Modify `apps/api/src/network_schema_cache.ts`:

4a. In `refreshConsumedSchemas`, after the network-config loop, add:

```typescript
  await cacheConsentConfigs();
```

4b. In `getConfiguredNetworkSchemas`, the lazy build path (the `for (const networkConfig ...)` loop when cache is empty) — add after that loop:

```typescript
  await cacheConsentConfigs();
```

(Both changes ensure `consent_config` entries exist whether the cache is warmed lazily or via explicit refetch.)

- [ ] **Step 5: Write the integration test**

Create `apps/api/src/__tests__/consent_config_serving.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { refreshConsumedSchemas, getCachedSchemas } from '@/network_schema_cache';

// Requires SERVED_DOMAINS to include blue_dot and NETWORK_CONFIG_LOCAL_FILE
// pointing at examples/schemas/blue_dot/network.json for this test env.
describe('consent config serving', () => {
  beforeAll(async () => {
    await refreshConsumedSchemas();
  });

  it('caches a network-default consent_config entry for blue_dot', async () => {
    const all = await getCachedSchemas({ network: 'blue_dot' });
    const consent = all.filter((e) => e.kind === 'consent_config');
    expect(consent.some((e) => !e.brand)).toBe(true);
  });

  it('caches the upsdm brand-scoped consent_config entry', async () => {
    const all = await getCachedSchemas({ network: 'blue_dot' });
    const upsdm = all.find((e) => e.kind === 'consent_config' && e.brand === 'upsdm');
    expect(upsdm).toBeDefined();
    expect((upsdm!.schema as { documents?: { privacy?: unknown } }).documents?.privacy).toBeDefined();
  });
});
```

- [ ] **Step 6: Run the integration test**

Run:
```bash
docker compose up -d db redis
NETWORK_CONFIG_LOCAL_FILE=../../examples/schemas/blue_dot/network.json \
SERVED_DOMAINS=blue_dot:provider:default \
pnpm --filter api test:integration consent_config_serving
```
Expected: PASS — both a network-default and a `upsdm` brand-scoped `consent_config` entry are cached. (Adjust `SERVED_DOMAINS` to a real blue_dot binding from `.env` if the domain differs.)

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/consent_configs.ts apps/api/src/config.ts apps/api/src/network_schema_cache.ts apps/api/src/__tests__/consent_config_serving.integration.test.ts
git commit -m "feat(api): serve network-default + brand-scoped consent_config via schema pipeline (#99)"
```

---

## Phase 1 Done — Definition & Verification

After Task 5, run the full gates:

```bash
pnpm typecheck
pnpm --filter @dpg/schemas exec vitest run src/__tests__/consent_config.test.ts
pnpm --filter @dpg/config exec vitest run src/__tests__/consent_config_loader.test.ts
docker compose up -d db redis && pnpm --filter api test:integration consent
```

**Deliverable:** `consent_record` table exists and is migratable; `consent.json` is validated, seeded per served network with a brand override, loaded, and served to the UI as `kind: 'consent_config'` entries (network-default + brand-scoped). No existing consumer changed — the `network.json` consent fields remain in place for the current action flow (removed in Phase 4).

## Known follow-ups (tracked, not in this phase)

- **Remote-mode consent delivery.** `loadConsentConfigs` returns `[]` for `source: 'remote'` in v1. When network config is served from the schema registry, wire consent.json (network default via source-URL filename swap, and brand-scoped URLs) the same way. Log-and-skip is acceptable until then; this is called out so it is not mistaken for "remote is covered."
- Phases 2–4 (terms/privacy, profile creation, connect/apply) each get their own plan and depend on this foundation.
