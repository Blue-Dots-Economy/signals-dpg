# PII Encryption at Rest + Masking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt private item state at rest with AES-256-GCM, store type-aware masks in the public `item_state` mirror, and decrypt on self/approved reads so the UI always renders a complete-looking card.

**Architecture:** Plaintext `splitItemStateByPrivacy` still runs at create; the private half is masked (format + heuristic) and merged back into `item_state`, while the original private object is AES-256-GCM encrypted (single env-var master key) into a now-`text` `item_private_state` column. Self-owned reads and post-accept reveal reads call a new `decryptItemPrivate` helper that overwrites masked leaves with real values. The UI drops its schema-privacy filter and renders whatever `item_state` contains.

**Tech Stack:** Node `crypto` (AES-256-GCM), Drizzle ORM, Fastify + Zod, React 19 + Vite, vitest, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-05-28-pii-encryption-at-rest-design.md`

**Branch:** `pii-encryption-at-rest` (already created off `develop`, spec committed). All tasks land as commits on this branch — single rolling PR per the project's branch-per-plan workflow.

---

## File Map

**Create:**
- `packages/auth/src/pii_crypto.ts` — `encryptPiiBlob`, `decryptPiiBlob`, `PiiCryptoError`.
- `packages/auth/src/pii_key.ts` — `getPiiKey()` accessor (reads + caches the Buffer at module load).
- `packages/auth/src/__tests__/pii_crypto.test.ts` — crypto unit tests.
- `packages/auth/src/__tests__/pii_key.test.ts` — accessor tests.
- `packages/schemas/src/item_state_masking.ts` — `maskPrivateState` + `MASKING_RULES` table.
- `packages/schemas/src/__tests__/item_state_masking.test.ts` — masking unit tests.
- `apps/api/src/utils/item_decrypt.ts` — `decryptItemPrivate(row)` helper.
- `apps/api/src/utils/__tests__/item_decrypt.test.ts` — decrypt helper tests.

**Modify:**
- `packages/config/src/secrets.ts` — add `SIGNALS_PII_KEY` to `InstanceSecretsSchema` (new schema or existing — see Task 1).
- `turbo.json` — add `SIGNALS_PII_KEY` to `globalPassThroughEnv`.
- `packages/schemas/src/item_state_privacy.ts` — export `mergeMasksIntoPublic`.
- `packages/schemas/src/index.ts` — re-export `item_state_masking` symbols.
- `packages/auth/src/index.ts` — re-export pii_crypto + pii_key symbols.
- `packages/database/src/utils/sql_scripts/create_items.sql` — `item_private_state TEXT NOT NULL DEFAULT ''`, drop the GIN index.
- `packages/database/src/drizzle_ref_tables/items.ts` — Drizzle column type `text`.
- `apps/api/src/services/item_service.ts` — `createItemInternal` and `updateItemInternal` use the new flow.
- `apps/api/src/utils/item_fetch_runtime.ts` — `fetchLocalItems` decrypts when `includePrivateState`.
- `apps/api/src/utils/item_fetch_cache.ts` — verify (or fix) cache key includes `includePrivateState`.
- `apps/api/scripts/seed_purple_dot.ts` — route inserts through `createItemInternal`.
- `apps/ui/src/components/cards/card-field.tsx` — drop `privacyMode` prop + filter.
- `apps/ui/src/components/cards/domain-card.tsx` — drop `privacyMode` prop.
- `apps/ui/src/engine/types.ts` — remove `PrivacyMode`.
- UI callers passing `privacyMode={...}` — drop the prop.
- `docs/operations/secrets.md` — document `SIGNALS_PII_KEY`.
- `helmcharts/...` — provision a `pii-key` Secret (mirror the aggregator-apikey pattern).

**Delete:**
- `apps/ui/src/engine/schema/schema-privacy.ts` (and any tests).

**Generated (do not hand-edit):**
- New file under `apps/api/drizzle/` produced by `pnpm db:generate:api`.
- Helm-bundled `schema.sql` produced by `pnpm schema:bundle`.

---

## Task 1: Add `SIGNALS_PII_KEY` env var to config + turbo passthrough

**Files:**
- Modify: `packages/config/src/secrets.ts`
- Modify: `turbo.json`
- Modify: `.env.example` (if present at repo root)

- [ ] **Step 1: Add the schema entry**

Open `packages/config/src/secrets.ts`. Add this block after `AuthSecretsSchema`:

```ts
export const PiiCryptoSecretsSchema = z.object({
  SIGNALS_PII_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/=]+$/, 'SIGNALS_PII_KEY must be base64')
    .refine(
      (s) => Buffer.from(s, 'base64').length === 32,
      'SIGNALS_PII_KEY must be base64-encoded 32 bytes (AES-256)'
    ),
});
```

Then, wherever the secrets are composed into a single root schema in this file (look for a `.merge(...)` chain or a final `export const Secrets = ...`), add `.merge(PiiCryptoSecretsSchema)` in the same place existing secret schemas are merged. If no merged root exists in this file, follow the pattern used by `AuthSecretsSchema` — it is imported and merged elsewhere; do the same for the new schema.

- [ ] **Step 2: Add to `turbo.json` `globalPassThroughEnv`**

Open `turbo.json`. Find the `globalPassThroughEnv` array (around line 8). Add `"SIGNALS_PII_KEY"` to it (alphabetised next to `AUTH_SECRET`).

- [ ] **Step 3: Add to `.env.example` if it exists**

If `.env.example` exists at repo root, append:

```
# AES-256 master key for PII encryption (base64 of 32 bytes).
# Generate with: openssl rand -base64 32
SIGNALS_PII_KEY=
```

Skip this step if `.env.example` is not present.

- [ ] **Step 4: Generate a dev key for local + test use**

Run:
```bash
openssl rand -base64 32
```

Paste the output into your local `.env` as `SIGNALS_PII_KEY=...`. Do NOT commit `.env`.

- [ ] **Step 5: Verify config parses**

Run:
```bash
pnpm --filter @dpg/config build
```

Expected: success, no zod schema errors.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/secrets.ts turbo.json .env.example
git commit -m "feat(config): add SIGNALS_PII_KEY for PII encryption at rest"
```

---

## Task 2: Create `pii_crypto` module with TDD

**Files:**
- Create: `packages/auth/src/pii_crypto.ts`
- Create: `packages/auth/src/__tests__/pii_crypto.test.ts`
- Modify: `packages/auth/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/auth/src/__tests__/pii_crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encryptPiiBlob, decryptPiiBlob, PiiCryptoError } from '../pii_crypto';

const KEY = Buffer.alloc(32, 0xa1); // deterministic 32-byte key

describe('pii_crypto', () => {
  it('round-trips a string', () => {
    const ct = encryptPiiBlob('{"email":"a@b.com"}', KEY);
    expect(decryptPiiBlob(ct, KEY)).toBe('{"email":"a@b.com"}');
  });

  it('emits the v1: version prefix', () => {
    const ct = encryptPiiBlob('hello', KEY);
    expect(ct.startsWith('v1:')).toBe(true);
  });

  it('produces a different ciphertext each call (fresh IV)', () => {
    const a = encryptPiiBlob('same', KEY);
    const b = encryptPiiBlob('same', KEY);
    expect(a).not.toBe(b);
  });

  it('rejects an unknown version prefix', () => {
    expect(() => decryptPiiBlob('v9:zzz', KEY)).toThrow(PiiCryptoError);
    try {
      decryptPiiBlob('v9:zzz', KEY);
    } catch (err) {
      expect((err as PiiCryptoError).code).toBe('BAD_FORMAT');
    }
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const ct = encryptPiiBlob('hello', KEY);
    // Flip the last char before the base64 padding.
    const tampered = ct.slice(0, -2) + (ct.endsWith('A=') ? 'B=' : 'A=');
    expect(() => decryptPiiBlob(tampered, KEY)).toThrow(PiiCryptoError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encryptPiiBlob('x', Buffer.alloc(16))).toThrow(PiiCryptoError);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
pnpm --filter @dpg/auth exec vitest run src/__tests__/pii_crypto.test.ts
```

Expected: FAIL with module-not-found for `../pii_crypto`.

- [ ] **Step 3: Implement the module**

Create `packages/auth/src/pii_crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type PiiCryptoErrorCode = 'KEY_MISSING' | 'BAD_FORMAT' | 'DECRYPT_FAILED';

export class PiiCryptoError extends Error {
  readonly code: PiiCryptoErrorCode;
  constructor(code: PiiCryptoErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'PiiCryptoError';
  }
}

const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 'v1';

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new PiiCryptoError('KEY_MISSING', 'PII key must be a 32-byte Buffer');
  }
}

export function encryptPiiBlob(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, ct, tag]).toString('base64')}`;
}

export function decryptPiiBlob(blob: string, key: Buffer): string {
  assertKey(key);
  if (!blob.startsWith(`${VERSION}:`)) {
    throw new PiiCryptoError('BAD_FORMAT', 'Unknown PII blob version');
  }
  const raw = Buffer.from(blob.slice(VERSION.length + 1), 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new PiiCryptoError('BAD_FORMAT', 'PII blob is too short');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new PiiCryptoError('DECRYPT_FAILED', 'PII blob decryption failed');
  }
}
```

- [ ] **Step 4: Add the export**

Open `packages/auth/src/index.ts`. Add:

```ts
export * from './pii_crypto';
```

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
pnpm --filter @dpg/auth exec vitest run src/__tests__/pii_crypto.test.ts
```

Expected: 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/pii_crypto.ts packages/auth/src/__tests__/pii_crypto.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): AES-256-GCM PII blob encrypt/decrypt with versioned envelope"
```

---

## Task 3: Add `getPiiKey()` accessor

**Files:**
- Create: `packages/auth/src/pii_key.ts`
- Create: `packages/auth/src/__tests__/pii_key.test.ts`
- Modify: `packages/auth/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/auth/src/__tests__/pii_key.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('getPiiKey', () => {
  const original = process.env.SIGNALS_PII_KEY;

  beforeEach(() => {
    // Reset module cache so each test re-reads env.
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SIGNALS_PII_KEY;
    else process.env.SIGNALS_PII_KEY = original;
  });

  it('returns a 32-byte Buffer when env is set to base64 of 32 bytes', async () => {
    process.env.SIGNALS_PII_KEY = Buffer.alloc(32, 0xa1).toString('base64');
    const { getPiiKey } = await import('../pii_key');
    const k = getPiiKey();
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
  });

  it('throws PiiCryptoError(KEY_MISSING) when env var is absent', async () => {
    delete process.env.SIGNALS_PII_KEY;
    const { getPiiKey } = await import('../pii_key');
    const { PiiCryptoError } = await import('../pii_crypto');
    expect(() => getPiiKey()).toThrow(PiiCryptoError);
    try { getPiiKey(); } catch (err) {
      expect((err as InstanceType<typeof PiiCryptoError>).code).toBe('KEY_MISSING');
    }
  });
});
```

Add at the top of the file: `import { vi } from 'vitest';`.

- [ ] **Step 2: Run the test, confirm it fails**

```bash
pnpm --filter @dpg/auth exec vitest run src/__tests__/pii_key.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the accessor**

Create `packages/auth/src/pii_key.ts`:

```ts
import { PiiCryptoError } from './pii_crypto';

let cached: Buffer | null = null;

export function getPiiKey(): Buffer {
  if (cached) return cached;
  const raw = process.env.SIGNALS_PII_KEY;
  if (!raw) {
    throw new PiiCryptoError('KEY_MISSING', 'SIGNALS_PII_KEY is not set');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new PiiCryptoError(
      'KEY_MISSING',
      'SIGNALS_PII_KEY must decode to 32 bytes'
    );
  }
  cached = buf;
  return cached;
}

// Test-only helper. Resetting the cached key lets vitest swap env between tests.
export function _resetPiiKeyCacheForTests(): void {
  cached = null;
}
```

- [ ] **Step 4: Export it**

Add to `packages/auth/src/index.ts`:

```ts
export { getPiiKey } from './pii_key';
```

- [ ] **Step 5: Run the tests, confirm pass**

```bash
pnpm --filter @dpg/auth exec vitest run src/__tests__/pii_key.test.ts
```

Expected: 2 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/pii_key.ts packages/auth/src/__tests__/pii_key.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): cached getPiiKey accessor with strict 32-byte validation"
```

---

## Task 4: Create `maskPrivateState` masking helper

**Files:**
- Create: `packages/schemas/src/item_state_masking.ts`
- Create: `packages/schemas/src/__tests__/item_state_masking.test.ts`
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/schemas/src/__tests__/item_state_masking.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { maskPrivateState } from '../item_state_masking';

const profileSchema = {
  type: 'object',
  properties: {
    email:    { type: 'string', format: 'email',   private: true },
    phone:    { type: 'string', format: 'phone',   private: true },
    dob:      { type: 'string',                    private: true },
    name:     { type: 'string',                    private: true },
    aadhaar:  { type: 'string',                    private: true },
    bio:      { type: 'string',                    private: true },
    address: {
      type: 'object', private: true,
      properties: {
        line1: { type: 'string' },
        city:  { type: 'string' },
      },
    },
    references: {
      type: 'array', private: true,
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } },
      },
    },
  },
} as const;

describe('maskPrivateState', () => {
  it('masks an email by format', () => {
    const out = maskPrivateState(profileSchema, { email: 'aniket@example.com' });
    expect(out.email).toBe('a***@example.com');
  });

  it('masks a phone by format with last 4 visible', () => {
    const out = maskPrivateState(profileSchema, { phone: '+919876543210' });
    expect(out.phone).toBe('+91-XX-XXXX-X3210');
  });

  it('masks a dob by key-name heuristic', () => {
    const out = maskPrivateState(profileSchema, { dob: '1990-01-15' });
    expect(out.dob).toBe('XXXX-XX-XX');
  });

  it('masks a name by key-name heuristic', () => {
    const out = maskPrivateState(profileSchema, { name: 'Aniket' });
    expect(out.name).toBe('A***');
  });

  it('masks an aadhaar by key-name heuristic with last 4 visible', () => {
    const out = maskPrivateState(profileSchema, { aadhaar: '123456789012' });
    expect(out.aadhaar).toBe('XXXXXXXX9012');
  });

  it('falls back to length-preserving X for unknown fields', () => {
    const out = maskPrivateState(profileSchema, { bio: 'hello' });
    expect(out.bio).toBe('XXXXX');
  });

  it('recurses into nested object schemas', () => {
    const out = maskPrivateState(profileSchema, {
      address: { line1: '221B Baker St', city: 'London' },
    });
    expect(out.address).toEqual({
      line1: 'XXXXXXXXXXXXX',
      city:  'XXXXXX',
    });
  });

  it('recurses into arrays of objects', () => {
    const out = maskPrivateState(profileSchema, {
      references: [
        { name: 'Watson', email: 'w@x.com' },
        { name: 'Holmes', email: 'h@y.org' },
      ],
    });
    expect(out.references).toEqual([
      { name: 'W***', email: 'w***@x.com' },
      { name: 'H***', email: 'h***@y.org' },
    ]);
  });

  it('passes null and undefined through unchanged', () => {
    const out = maskPrivateState(profileSchema, { email: null, phone: undefined });
    expect(out.email).toBeNull();
    expect(out.phone).toBeUndefined();
  });

  it('stringifies non-string scalars before masking', () => {
    const schema = { type: 'object', properties: { age: { type: 'number', private: true } } };
    const out = maskPrivateState(schema, { age: 42 });
    expect(out.age).toBe('XX');
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
pnpm --filter @dpg/schemas exec vitest run src/__tests__/item_state_masking.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the masking module**

Create `packages/schemas/src/item_state_masking.ts`:

```ts
type JsonRecord = Record<string, unknown>;

interface MaskingRule {
  test: (key: string, propSchema: JsonRecord) => boolean;
  apply: (value: string) => string;
}

function lastN(s: string, n: number): string {
  return s.length <= n ? s : s.slice(-n);
}

function format(propSchema: JsonRecord): string | undefined {
  const f = propSchema.format;
  return typeof f === 'string' ? f : undefined;
}

const MASKING_RULES: MaskingRule[] = [
  {
    // email: a***@x.com
    test: (_k, p) => format(p) === 'email',
    apply: (v) => {
      const [local = '', domain = ''] = v.split('@');
      const head = local.charAt(0) || 'X';
      return `${head}***@${domain}`;
    },
  },
  {
    // phone / tel: +XX-XX-XXXX-X{last4}; preserve country code only if it
    // already starts with "+NN" where NN is 1-3 digits.
    test: (_k, p) => format(p) === 'phone' || format(p) === 'tel',
    apply: (v) => {
      const tail = lastN(v.replace(/\D/g, ''), 4).padStart(4, 'X');
      const cc = /^(\+\d{1,3})/.exec(v)?.[1];
      return cc ? `${cc}-XX-XXXX-X${tail}` : `+XX-XX-XXXX-X${tail}`;
    },
  },
  {
    // date or date-time format
    test: (_k, p) => format(p) === 'date' || format(p) === 'date-time',
    apply: () => 'XXXX-XX-XX',
  },
  {
    // uri / url: scheme://***
    test: (_k, p) => format(p) === 'uri' || format(p) === 'url',
    apply: (v) => {
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
      return `${m?.[1] ?? 'https'}://***`;
    },
  },
  {
    // dob / birth key
    test: (k) => /(^|_)(dob|birth)/i.test(k),
    apply: () => 'XXXX-XX-XX',
  },
  {
    // name-like keys: first letter + ***
    test: (k) => /(^|_)(name|first_name|last_name|full_name)$/i.test(k),
    apply: (v) => (v.length === 0 ? '' : `${v.charAt(0)}***`),
  },
  {
    // government ID keys: last 4 visible
    test: (k) => /(aadhaar|pan|ssn|national_id|passport)/i.test(k),
    apply: (v) => {
      const digits = v.replace(/\D/g, '');
      const tail = lastN(digits, 4);
      return 'X'.repeat(Math.max(v.length - tail.length, 0)) + tail;
    },
  },
];

function maskLeaf(key: string, propSchema: JsonRecord, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const str = typeof value === 'string' ? value : String(value);
  for (const rule of MASKING_RULES) {
    if (rule.test(key, propSchema)) return rule.apply(str);
  }
  // Fallback: length-preserving X.
  return 'X'.repeat(str.length);
}

function isPlainObject(input: unknown): input is JsonRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function getProperties(schema: JsonRecord): Record<string, JsonRecord> {
  return isPlainObject(schema.properties)
    ? (schema.properties as Record<string, JsonRecord>)
    : {};
}

export function maskPrivateState(
  itemSchema: JsonRecord,
  privateState: JsonRecord
): JsonRecord {
  return maskObject(itemSchema, privateState);
}

function maskObject(schema: JsonRecord, state: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  const props = getProperties(schema);

  for (const [key, value] of Object.entries(state)) {
    const propSchema = props[key] ?? {};
    if (value === null || value === undefined) {
      out[key] = value;
      continue;
    }
    if (isPlainObject(propSchema) && isPlainObject(value)) {
      out[key] = maskObject(propSchema, value);
      continue;
    }
    if (isPlainObject(propSchema) && Array.isArray(value)) {
      const itemSchema = isPlainObject(propSchema.items) ? propSchema.items : null;
      out[key] = value.map((entry) => {
        if (isPlainObject(entry) && itemSchema) return maskObject(itemSchema, entry);
        if (entry === null || entry === undefined) return entry;
        return maskLeaf(key, propSchema, entry);
      });
      continue;
    }
    out[key] = maskLeaf(key, propSchema, value);
  }
  return out;
}
```

- [ ] **Step 4: Export the symbol**

Open `packages/schemas/src/index.ts`. Add:

```ts
export * from './item_state_masking';
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
pnpm --filter @dpg/schemas exec vitest run src/__tests__/item_state_masking.test.ts
```

Expected: 10 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/item_state_masking.ts packages/schemas/src/__tests__/item_state_masking.test.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): type-aware maskPrivateState with format + key heuristics"
```

---

## Task 5: Promote `mergeMasksIntoPublic` export

**Files:**
- Modify: `packages/schemas/src/item_state_privacy.ts`

- [ ] **Step 1: Inspect the existing file**

The existing file already has an internal `mergeObjects` and an exported `mergeItemStateWithPrivate` that wraps it. We need a second exported alias named for its new role (merging mask values into public state). Re-exporting under a different name keeps callers self-documenting.

- [ ] **Step 2: Add the alias**

Open `packages/schemas/src/item_state_privacy.ts`. After the existing `mergeItemStateWithPrivate` function definition, add:

```ts
/**
 * Same merge semantics as mergeItemStateWithPrivate. Named alias for the
 * "merge mask values into the public mirror at create/update time" call site,
 * so reader intent is clear.
 */
export function mergeMasksIntoPublic(
  publicState: Record<string, unknown>,
  maskedPrivate: Record<string, unknown>
): Record<string, unknown> {
  return mergeItemStateWithPrivate(publicState, maskedPrivate);
}
```

- [ ] **Step 3: Verify the schemas package compiles**

```bash
pnpm --filter @dpg/schemas build
```

Expected: success.

- [ ] **Step 4: Verify existing privacy tests still pass**

```bash
pnpm --filter @dpg/schemas test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/item_state_privacy.ts
git commit -m "refactor(schemas): expose mergeMasksIntoPublic alias for create-time call site"
```

---

## Task 6: Change `item_private_state` column type to text

**Files:**
- Modify: `packages/database/src/utils/sql_scripts/create_items.sql`
- Modify: `packages/database/src/drizzle_ref_tables/items.ts`
- Generated: new file under `apps/api/drizzle/`
- Regenerated: Helm-bundled `schema.sql`

- [ ] **Step 1: Edit the items DDL**

Open `packages/database/src/utils/sql_scripts/create_items.sql`.

Replace the line:
```sql
item_private_state JSONB NOT NULL DEFAULT '{}'::jsonb,
```
with:
```sql
item_private_state TEXT NOT NULL DEFAULT '',
```

Delete the legacy idempotent column-add (no longer accurate type):
```sql
ALTER TABLE IF EXISTS items
ADD COLUMN IF NOT EXISTS item_private_state JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Delete the now-invalid GIN index (jsonb-only operator):
```sql
CREATE INDEX IF NOT EXISTS items_private_state_gin_idx
ON items USING GIN (item_private_state);
```

- [ ] **Step 2: Edit the Drizzle reference table**

Open `packages/database/src/drizzle_ref_tables/items.ts`.

Replace:
```ts
item_private_state: jsonb('item_private_state')
  .$type<Record<string, unknown>>()
  .notNull()
  .default(sql`'{}'::jsonb`),
```
with:
```ts
item_private_state: text('item_private_state').notNull().default(''),
```

Remove `jsonb` from the imports if it's no longer used in this file (check the remaining uses of `jsonb` in the same import block — `item_state` still needs it, so leave the import alone unless `item_state` was changed too).

- [ ] **Step 3: Re-bootstrap the DB locally**

Since we're greenfield, the cleanest reset is:

```bash
docker compose down -v
docker compose up -d db redis
pnpm --filter api exec tsx scripts/db_init.ts
```

If `db_init.ts` does not exist or works differently, follow whatever the project's documented reset path is (check `readme.md` / `docs/operations/migrations.md`).

Expected: the items table now has `item_private_state TEXT`.

- [ ] **Step 4: Verify the column type**

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d items" | grep item_private_state
```

Expected: `item_private_state | text | not null | default ''::text`.

- [ ] **Step 5: Re-bundle the Helm schema**

```bash
pnpm schema:bundle
pnpm schema:bundle:check
```

Expected: bundle regenerates without diff against itself.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: success. Most call-sites in the codebase still treat `item_private_state` as a JSON record, so expect type errors here — they will be fixed in Tasks 8-11. **If typecheck has errors only in `apps/api/src/services/item_service.ts`, `apps/api/src/utils/item_fetch_runtime.ts`, or `apps/api/src/utils/inter_instance_fetch.ts`, that's expected; proceed to the next step.** Any other type errors are a regression — investigate before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/utils/sql_scripts/create_items.sql packages/database/src/drizzle_ref_tables/items.ts apps/api/db/postgres/schema/ packages/database/
git commit -m "feat(db): item_private_state becomes text for encrypted PII blob"
```

(If `pnpm schema:bundle` writes to a file under `helmcharts/` or elsewhere, include that path in `git add` — check `git status` first.)

---

## Task 7: Create `decryptItemPrivate` helper

**Files:**
- Create: `apps/api/src/utils/item_decrypt.ts`
- Create: `apps/api/src/utils/__tests__/item_decrypt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/utils/__tests__/item_decrypt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptPiiBlob, PiiCryptoError } from '@dpg/auth';
import { decryptItemPrivate } from '../item_decrypt';
import { _resetPiiKeyCacheForTests } from '@dpg/auth/pii_key';

const KEY_B64 = Buffer.alloc(32, 0xa1).toString('base64');

describe('decryptItemPrivate', () => {
  const originalKey = process.env.SIGNALS_PII_KEY;
  beforeEach(() => {
    process.env.SIGNALS_PII_KEY = KEY_B64;
    _resetPiiKeyCacheForTests();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.SIGNALS_PII_KEY;
    else process.env.SIGNALS_PII_KEY = originalKey;
  });

  it('returns item_state unchanged when item_private_state is empty', () => {
    const out = decryptItemPrivate({
      item_state: { name: 'A***', city: 'Bangalore' },
      item_private_state: '',
    });
    expect(out.mergedState).toEqual({ name: 'A***', city: 'Bangalore' });
  });

  it('merges decrypted private values over masked ones in item_state', () => {
    const key = Buffer.from(KEY_B64, 'base64');
    const enc = encryptPiiBlob(JSON.stringify({ name: 'Aniket', email: 'a@b.com' }), key);
    const out = decryptItemPrivate({
      item_state: { name: 'A***', email: 'a***@b.com', city: 'Bangalore' },
      item_private_state: enc,
    });
    expect(out.mergedState).toEqual({
      name: 'Aniket', email: 'a@b.com', city: 'Bangalore',
    });
  });

  it('throws PiiCryptoError on a corrupt blob', () => {
    expect(() =>
      decryptItemPrivate({ item_state: {}, item_private_state: 'v1:not-base64-aaaa' })
    ).toThrow(PiiCryptoError);
  });
});
```

If the `_resetPiiKeyCacheForTests` import path doesn't resolve, replace it with a deep import that does (e.g. `'@dpg/auth/dist/pii_key'`); the helper exists as of Task 3.

- [ ] **Step 2: Run, confirm fail**

```bash
pnpm --filter api exec vitest run src/utils/__tests__/item_decrypt.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/utils/item_decrypt.ts`:

```ts
import { decryptPiiBlob, getPiiKey } from '@dpg/auth';
import { mergeItemStateWithPrivate } from '@dpg/schemas';

type JsonRecord = Record<string, unknown>;

export interface DecryptItemPrivateInput {
  item_state: JsonRecord;
  item_private_state: string;
}

export function decryptItemPrivate(
  row: DecryptItemPrivateInput
): { mergedState: JsonRecord } {
  if (!row.item_private_state) {
    return { mergedState: row.item_state };
  }
  const decryptedJson = decryptPiiBlob(row.item_private_state, getPiiKey());
  const decrypted = JSON.parse(decryptedJson) as JsonRecord;
  return { mergedState: mergeItemStateWithPrivate(row.item_state, decrypted) };
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
pnpm --filter api exec vitest run src/utils/__tests__/item_decrypt.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils/item_decrypt.ts apps/api/src/utils/__tests__/item_decrypt.test.ts
git commit -m "feat(api): decryptItemPrivate utility merges decrypted PII over masked item_state"
```

---

## Task 8: Update `createItemInternal` — mask + encrypt at write

**Files:**
- Modify: `apps/api/src/services/item_service.ts`
- Modify (or create): `apps/api/src/services/__tests__/item_service.test.ts`

- [ ] **Step 1: Locate the existing test file**

```bash
ls apps/api/src/services/__tests__/ 2>/dev/null
```

If `item_service.test.ts` exists, you'll be extending it; if not, you'll create it. Either way the test below is the one to add.

- [ ] **Step 2: Write the failing test**

Add (or create) `apps/api/src/services/__tests__/item_service.test.ts`. If creating, start with this content; if extending, paste the inside of the `describe` block into the existing file.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptPiiBlob, _resetPiiKeyCacheForTests } from '@dpg/auth';
import { createItemInternal } from '../item_service';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { eq } from 'drizzle-orm';

// NOTE: this test exercises the real DB. Run with `pnpm --filter api test:integration`
// (rename file to *.integration.test.ts) OR mock the db dependency. Choose based on
// whatever this codebase already does for createItemInternal tests.

describe('createItemInternal — masking + encryption', () => {
  beforeEach(() => {
    process.env.SIGNALS_PII_KEY = Buffer.alloc(32, 0xa1).toString('base64');
    _resetPiiKeyCacheForTests();
  });

  it('writes masked values into item_state and an encrypted blob into item_private_state', async () => {
    // Use a schema that has at least one `private: true` field; arrange via test
    // fixtures the way other item_service tests do. Pseudo-arrange below — replace
    // with the actual test fixture from this codebase.
    const created = await createItemInternal(db, {
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_state: { name: 'Aniket', email: 'aniket@example.com', city: 'Bangalore' },
      created_by: 'test-user-id',
    });

    const [row] = await db
      .select()
      .from(items)
      .where(eq(items.item_id, created.itemId))
      .limit(1);

    expect(row.item_state).toEqual({
      name: 'A***',
      email: 'a***@example.com',
      city: 'Bangalore',
    });
    expect(row.item_private_state).toMatch(/^v1:/);
    const key = Buffer.from(process.env.SIGNALS_PII_KEY!, 'base64');
    expect(JSON.parse(decryptPiiBlob(row.item_private_state, key))).toEqual({
      name: 'Aniket',
      email: 'aniket@example.com',
    });
  });

  it('stores empty item_private_state when the schema has no private fields', async () => {
    const created = await createItemInternal(db, {
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',           // adjust to a public-only schema in your fixtures
      item_state: { city: 'Bangalore' },
      created_by: 'test-user-id',
    });
    const [row] = await db
      .select()
      .from(items)
      .where(eq(items.item_id, created.itemId))
      .limit(1);
    expect(row.item_private_state).toBe('');
  });
});
```

If the existing test file uses mocked DB instead of a real DB, replicate that pattern instead of the real-DB shape above.

- [ ] **Step 3: Run, confirm fail**

```bash
pnpm --filter api exec vitest run src/services/__tests__/item_service.test.ts
```

Expected: FAIL — `item_state` still contains the raw values and `item_private_state` is `{}`.

- [ ] **Step 4: Modify `createItemInternal`**

Open `apps/api/src/services/item_service.ts`. At the top, add the imports:

```ts
import { encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { maskPrivateState, mergeMasksIntoPublic } from '@dpg/schemas';
```

Find `createItemInternal`. Replace the body after `resolveSchema(...)` so that the `.insert(items).values(...)` call uses the new shape. The block that needs to change is the one currently using `itemState.publicState` and `itemState.privateState` directly:

```ts
export async function createItemInternal(
  exec: DbOrTx,
  params: CreateItemServiceParams
) {
  const submittedItemState = params.item_state ?? {};
  const { itemSchemaUrl, itemState, itemInstanceUrl, itemSchema } = await resolveSchema({
    item_network: params.item_network,
    item_domain: params.item_domain,
    item_type: params.item_type,
    submittedItemState,
  });

  const masked = maskPrivateState(itemSchema, itemState.privateState);
  const itemStateForStorage = mergeMasksIntoPublic(itemState.publicState, masked);
  const encryptedPrivate =
    Object.keys(itemState.privateState).length === 0
      ? ''
      : encryptPiiBlob(JSON.stringify(itemState.privateState), getPiiKey());

  const result = await exec
    .insert(items)
    .values({
      item_network: params.item_network,
      item_type: params.item_type,
      item_domain: params.item_domain,
      item_instance_url: itemInstanceUrl,
      item_schema_url: itemSchemaUrl,
      item_state: itemStateForStorage,
      item_private_state: encryptedPrivate,
      item_latitude: params.item_latitude ?? null,
      item_longitude: params.item_longitude ?? null,
      created_by: params.created_by,
    })
    .onConflictDoNothing({
      target: [items.item_network, items.item_domain, items.item_type, items.item_id],
    })
    .returning({
      itemNetwork: items.item_network,
      itemDomain: items.item_domain,
      itemType: items.item_type,
      itemId: items.item_id,
    });

  if (result.length === 0) {
    throw new ItemServiceError(
      409,
      'ITEM_ALREADY_EXISTS',
      'An item with the same type and id already exists'
    );
  }
  return result[0];
}
```

For this to work, `resolveSchema` must return `itemSchema` alongside its other outputs. Edit `resolveSchema` to add `itemSchema` to its return object:

```ts
return { itemSchemaUrl, itemState, itemInstanceUrl, itemSchema };
```

(The local variable is already in scope inside `resolveSchema`.)

- [ ] **Step 5: Run tests, confirm pass**

```bash
pnpm --filter api exec vitest run src/services/__tests__/item_service.test.ts
```

Expected: 2 PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/item_service.ts apps/api/src/services/__tests__/item_service.test.ts
git commit -m "feat(api): createItemInternal masks private fields into item_state and encrypts the blob"
```

---

## Task 9: Update `updateItemInternal` — preserve encrypted state on partial updates

**Files:**
- Modify: `apps/api/src/services/item_service.ts`
- Modify: `apps/api/src/services/__tests__/item_service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing `item_service.test.ts`:

```ts
it('updateItemInternal preserves untouched private fields when only a public field changes', async () => {
  // Arrange: create an item with both public and private fields.
  const created = await createItemInternal(db, {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Aniket', email: 'aniket@example.com', city: 'Bangalore' },
    created_by: 'test-user-id',
  });

  // Act: update only the public `city` field.
  await updateItemInternal(db, created.itemId, 'test-user-id', false, {
    item_state: { city: 'Mumbai' },
  });

  // Assert: private fields still decrypt to the original values.
  const [row] = await db
    .select()
    .from(items)
    .where(eq(items.item_id, created.itemId))
    .limit(1);

  expect((row.item_state as Record<string, unknown>).city).toBe('Mumbai');
  const key = Buffer.from(process.env.SIGNALS_PII_KEY!, 'base64');
  expect(JSON.parse(decryptPiiBlob(row.item_private_state, key))).toEqual({
    name: 'Aniket',
    email: 'aniket@example.com',
  });
});

it('updateItemInternal re-masks when a private field changes', async () => {
  const created = await createItemInternal(db, {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Aniket', email: 'aniket@example.com' },
    created_by: 'test-user-id',
  });

  await updateItemInternal(db, created.itemId, 'test-user-id', false, {
    item_state: { email: 'new@example.com' },
  });

  const [row] = await db
    .select()
    .from(items)
    .where(eq(items.item_id, created.itemId))
    .limit(1);
  const key = Buffer.from(process.env.SIGNALS_PII_KEY!, 'base64');

  expect((row.item_state as Record<string, unknown>).email).toBe('n***@example.com');
  expect(JSON.parse(decryptPiiBlob(row.item_private_state, key))).toEqual({
    name: 'Aniket',
    email: 'new@example.com',
  });
});
```

Also ensure `updateItemInternal` and `decryptPiiBlob` are imported at the top of the file alongside the existing imports.

- [ ] **Step 2: Run, confirm fail**

```bash
pnpm --filter api exec vitest run src/services/__tests__/item_service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Modify `updateItemInternal`**

Open `apps/api/src/services/item_service.ts`. Find `updateItemInternal`. The current flow accepts a partial body and `.update().set(...)` it. New flow: read the row, decrypt, merge incoming changes, re-split, re-mask, re-encrypt, write.

Replace the function body:

```ts
export async function updateItemInternal(
  exec: DbOrTx,
  itemId: string,
  callerId: string,
  isAdmin: boolean,
  body: UpdateItemServiceBody
) {
  const ownershipFilter = isAdmin
    ? eq(items.item_id, itemId)
    : and(eq(items.item_id, itemId), eq(items.created_by, callerId));

  const [existing] = await exec.select().from(items).where(ownershipFilter).limit(1);
  if (!existing) {
    throw new ItemServiceError(404, 'ITEM_NOT_FOUND', 'Item not found or not owned');
  }

  let nextItemState = existing.item_state as Record<string, unknown>;
  let nextEncrypted = existing.item_private_state ?? '';

  if (body.item_state !== undefined) {
    // Decrypt the current private blob (if any) so we have the full prior state.
    const currentPrivate =
      nextEncrypted === ''
        ? {}
        : (JSON.parse(decryptPiiBlob(nextEncrypted, getPiiKey())) as Record<string, unknown>);

    // Reconstitute full prior item_state (public + real private), then layer incoming changes.
    const priorFull = mergeItemStateWithPrivate(existing.item_state as Record<string, unknown>, currentPrivate);
    const merged: Record<string, unknown> = { ...priorFull, ...body.item_state };

    // Re-resolve schema (it may have changed if item_type changed; but item_type isn't
    // in UpdateItemServiceBody, so this is purely fetching the schema for masking).
    const { itemState, itemSchema } = await resolveSchema({
      item_network: existing.item_network,
      item_domain: existing.item_domain,
      item_type: existing.item_type,
      submittedItemState: merged,
    });

    const masked = maskPrivateState(itemSchema, itemState.privateState);
    nextItemState = mergeMasksIntoPublic(itemState.publicState, masked);
    nextEncrypted =
      Object.keys(itemState.privateState).length === 0
        ? ''
        : encryptPiiBlob(JSON.stringify(itemState.privateState), getPiiKey());
  }

  const updateValues: Record<string, unknown> = {
    item_state: nextItemState,
    item_private_state: nextEncrypted,
    updated_at: sql`now()`,
  };
  if (body.item_latitude !== undefined) updateValues.item_latitude = body.item_latitude;
  if (body.item_longitude !== undefined) updateValues.item_longitude = body.item_longitude;

  await exec.update(items).set(updateValues).where(ownershipFilter);
}
```

Add the import for `decryptPiiBlob` at the top of `item_service.ts`:

```ts
import { decryptPiiBlob, encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { maskPrivateState, mergeMasksIntoPublic, mergeItemStateWithPrivate } from '@dpg/schemas';
```

Also import `and`, `eq`, `sql` from `drizzle-orm` if they aren't already imported (the original function used them).

If the existing `updateItemInternal` signature differs from what's shown above (e.g. different parameters, different return type), keep the original signature and reshape the body to fit; the key invariant is "read prior row → reconstitute → re-mask + re-encrypt → write".

- [ ] **Step 4: Run tests, confirm pass**

```bash
pnpm --filter api exec vitest run src/services/__tests__/item_service.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/item_service.ts apps/api/src/services/__tests__/item_service.test.ts
git commit -m "feat(api): updateItemInternal preserves encrypted PII via read-merge-re-encrypt"
```

---

## Task 10: Update `fetchLocalItems` — decrypt when `includePrivateState`

**Files:**
- Modify: `apps/api/src/utils/item_fetch_runtime.ts`

- [ ] **Step 1: Write a focused test inline**

In `apps/api/src/utils/__tests__/item_decrypt.test.ts`, add a small integration-shaped test for the fetch flow. If a separate `fetch_item.test.ts` already exists that exercises masked vs decrypted, extend that one instead. Pattern:

```ts
import { fetchLocalItems } from '../item_fetch_runtime';

it('fetchLocalItems with includePrivateState=false returns masked item_state', async () => {
  // Arrange via createItemInternal as in Task 8 tests.
  const created = await createItemInternal(db, /* ... profile with email */);
  const result = await fetchLocalItems({
    item_id: created.itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    limit: 1, offset: 0,
    includePrivateState: false,
  });
  expect((result.items[0]?.item_state as any).email).toBe('a***@example.com');
});

it('fetchLocalItems with includePrivateState=true returns decrypted item_state', async () => {
  const created = await createItemInternal(db, /* ... profile with email */);
  const result = await fetchLocalItems({
    item_id: created.itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    limit: 1, offset: 0,
    includePrivateState: true,
  });
  expect((result.items[0]?.item_state as any).email).toBe('aniket@example.com');
});

it('fetchLocalItems never returns item_private_state in the response', async () => {
  const created = await createItemInternal(db, /* ... */);
  const result = await fetchLocalItems({
    item_id: created.itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    limit: 1, offset: 0,
    includePrivateState: true,
  });
  expect((result.items[0] as any).item_private_state).toBeUndefined();
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
pnpm --filter api exec vitest run src/utils/__tests__/item_decrypt.test.ts
```

Expected: FAIL — current `fetchLocalItems` calls `mergeItemStateWithPrivate` on a string `item_private_state`, which will produce wrong / NaN output.

- [ ] **Step 3: Update the runtime**

Open `apps/api/src/utils/item_fetch_runtime.ts`. Replace the trailing `.map(...)` in `fetchLocalItems` with:

```ts
items: result.map((item) => {
  const { item_private_state, ...responseItem } = item;
  if (!filters.includePrivateState) {
    return responseItem;
  }
  return {
    ...responseItem,
    item_state: decryptItemPrivate({
      item_state: item.item_state,
      item_private_state: item_private_state ?? '',
    }).mergedState,
  };
}),
```

And replace the top-of-file import:

```ts
import { mergeItemStateWithPrivate } from '@dpg/schemas';
```

with:

```ts
import { decryptItemPrivate } from './item_decrypt';
```

(If `mergeItemStateWithPrivate` is still used elsewhere in this file, keep the import.)

Add a one-line comment on the `ItemFetchFilters` type:

```ts
/**
 * When true, the encrypted item_private_state blob is decrypted and merged
 * over item_state. Callers MUST verify ownership/authorization before passing
 * true — the cache key already includes this flag (see item_fetch_cache.ts).
 */
includePrivateState?: boolean;
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
pnpm --filter api exec vitest run src/utils/__tests__/item_decrypt.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Run the full api test suite**

```bash
pnpm --filter api test
```

Expected: green. Existing fetch / contact-details tests may need fixture updates — fix them inline if so (they're closely related to this change).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/item_fetch_runtime.ts apps/api/src/utils/__tests__/item_decrypt.test.ts
git commit -m "feat(api): fetchLocalItems decrypts item_private_state when includePrivateState=true"
```

---

## Task 11: Verify (and if necessary fix) the fetch cache key

**Files:**
- Read: `apps/api/src/utils/item_fetch_cache.ts`
- Modify: same file, only if the cache key does not currently include `includePrivateState`

- [ ] **Step 1: Inspect the cache key**

```bash
sed -n '1,120p' apps/api/src/utils/item_fetch_cache.ts
```

Look for the function that produces the Redis cache key. Confirm whether `includePrivateState` is part of the key.

- [ ] **Step 2: Fix if missing**

If `includePrivateState` is **not** included in the key, edit the key-builder function to add it. Typical shape:

```ts
const key = `item_fetch:${filters.item_network}:${filters.item_domain}:${filters.item_type ?? '*'}:${filters.item_id ?? '*'}:...:include_private=${filters.includePrivateState ? '1' : '0'}`;
```

Add a comment explaining why the flag is part of the key:

```ts
// includePrivateState is part of the cache key: a self-owned hit (decrypted)
// must never be served to a stranger reading the same item via the network path.
```

- [ ] **Step 3: Write or extend a test**

If a cache test file exists (`item_fetch_cache.test.ts`), add a test that two consecutive `getCachedLocalItemFetch` calls with `includePrivateState=true` and `=false` for the same row don't cross-contaminate. If no test file exists, create one with that single assertion.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter api test
```

Expected: green.

- [ ] **Step 5: Commit (if changes were made)**

```bash
git add apps/api/src/utils/item_fetch_cache.ts apps/api/src/utils/__tests__/item_fetch_cache.test.ts
git commit -m "fix(api): include includePrivateState in fetch cache key"
```

If no changes were needed, **skip the commit** and add a comment to your PR description noting that the cache key was already correct.

---

## Task 12: Drop UI schema-privacy filter + `privacyMode` prop

**Files:**
- Delete: `apps/ui/src/engine/schema/schema-privacy.ts`
- Delete: `apps/ui/src/engine/schema/__tests__/schema-privacy.test.ts` (if it exists)
- Modify: `apps/ui/src/components/cards/card-field.tsx`
- Modify: `apps/ui/src/components/cards/domain-card.tsx`
- Modify: `apps/ui/src/engine/types.ts`

- [ ] **Step 1: Locate all callers of `privacyMode`**

```bash
grep -rn "privacyMode" apps/ui/src
```

You'll need to remove the prop from every call site in subsequent steps. List them now so you don't miss any.

- [ ] **Step 2: Delete the schema-privacy module**

```bash
git rm apps/ui/src/engine/schema/schema-privacy.ts
# if a test file exists:
git rm apps/ui/src/engine/schema/__tests__/schema-privacy.test.ts 2>/dev/null || true
```

- [ ] **Step 3: Remove the `PrivacyMode` type**

Open `apps/ui/src/engine/types.ts`. Delete the `PrivacyMode` export (search for `PrivacyMode` and remove the type declaration). Also remove any re-export of it.

- [ ] **Step 4: Simplify `card-field.tsx`**

Open `apps/ui/src/components/cards/card-field.tsx`. Remove the `privacyMode` prop from `CardFieldsFromSchemaProps` and the `CardFieldsFromSchema` function signature. Delete the inline `Object.fromEntries(Object.entries(schema.properties ?? {}).filter(...))` block that strips private fields; pass `schema` straight through to the render path.

Specifically, replace the body of `CardFieldsFromSchema` so that it uses `schema` directly without privacy filtering. The function should render every property in `schema.properties` against the corresponding key in `data`, using the existing `isEmptyValue` and `CardField` logic.

- [ ] **Step 5: Simplify `domain-card.tsx`**

Open `apps/ui/src/components/cards/domain-card.tsx`. Remove `privacyMode` from `DomainCardProps` and from the destructured props. Remove it from the `CardFieldsFromSchema` call inside the render.

- [ ] **Step 6: Strip `privacyMode` from every caller you listed in Step 1**

For each file in the Step 1 list, remove the `privacyMode={...}` attribute. There's no replacement; the UI now renders everything in `item_state`.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @dpg/ui typecheck
```

Expected: success. If you missed a caller, the type error will point you to it.

- [ ] **Step 8: Run UI tests**

```bash
pnpm --filter @dpg/ui test
```

Expected: green. Tests that asserted "private fields are hidden" need updating — change their assertions to "private fields render with masked values" (the values come from `item_state` directly in test fixtures; just put the mask string there).

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src
git commit -m "feat(ui): render full item_state; drop privacyMode and schema-privacy filter"
```

---

## Task 13: Route seed scripts through `createItemInternal`

**Files:**
- Modify: `apps/api/scripts/seed_purple_dot.ts`

- [ ] **Step 1: Inspect current insert path**

```bash
grep -n "items\|insert" apps/api/scripts/seed_purple_dot.ts | head -30
```

If the script already calls `createItemInternal` (or a service that wraps it), no change needed — skip to Step 4.

- [ ] **Step 2: Replace any raw `db.insert(items).values(...)` calls**

Where the script currently does:

```ts
await db.insert(items).values({
  item_network: 'purple_dot',
  // ...
  item_state: {...},
  item_private_state: {...},
});
```

Replace with:

```ts
await createItemInternal(db, {
  item_network: 'purple_dot',
  item_domain: ...,
  item_type: ...,
  item_state: { /* full state — service splits + masks + encrypts */ },
  created_by: ...,
});
```

Pass the **combined** state (public + private) — the service will split using the schema. Do not pre-split in the seed script.

- [ ] **Step 3: Add the import**

```ts
import { createItemInternal } from '@/services/item_service';
```

- [ ] **Step 4: Run the seed against a fresh DB**

```bash
docker compose down -v
docker compose up -d db redis
pnpm --filter api exec tsx scripts/db_init.ts        # or whatever this project's reset is
pnpm --filter api exec tsx scripts/seed_purple_dot.ts
```

Expected: no errors. Spot-check one row in the DB:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT item_id, left(item_private_state, 12) AS pii_head FROM items LIMIT 3;"
```

The `pii_head` column should show `v1:` prefixed values where private fields exist, and empty strings where they don't.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/seed_purple_dot.ts
git commit -m "chore(seed): route purple_dot seed through createItemInternal for encryption coverage"
```

---

## Task 14: Add / update integration tests for the end-to-end flow

**Files:**
- Modify: `apps/api/src/routes/v1/item/__tests__/fetch_item.integration.test.ts` (create if absent)
- Modify: `apps/api/src/routes/v1/action/__tests__/get_action_contact_details.integration.test.ts`

- [ ] **Step 1: Ensure deterministic test key**

Open the project's vitest setup (look for `vitest.setup.ts`, `vitest.config.ts`, or a `globalSetup` in `apps/api/vitest.config.ts`). Add:

```ts
process.env.SIGNALS_PII_KEY ??= Buffer.alloc(32, 0xa1).toString('base64');
```

This guarantees integration tests can encrypt/decrypt without depending on a developer's `.env`.

- [ ] **Step 2: Extend `fetch_item.integration.test.ts`**

If the file does not exist, create it under `apps/api/src/routes/v1/item/__tests__/`. Add this scenario (or rewrite an existing scenario to match):

```ts
it('returns masked item_state to a stranger and decrypted item_state to the owner', async () => {
  const owner = await createTestUser('owner');
  const stranger = await createTestUser('stranger');

  const itemId = await postItemAsUser(owner, {
    item_state: { name: 'Aniket', email: 'aniket@example.com', city: 'Bangalore' },
  });

  // Owner fetch: decrypted.
  const ownerView = await getItemFetch(owner, { item_id: itemId, /* ... */ });
  expect(ownerView.items[0].item_state.email).toBe('aniket@example.com');

  // Stranger fetch via /network/item/fetch: masked.
  const strangerView = await getNetworkItemFetch(stranger, { item_id: itemId, /* ... */ });
  expect(strangerView.items[0].item_state.email).toBe('a***@example.com');

  // Neither response includes item_private_state.
  expect(ownerView.items[0].item_private_state).toBeUndefined();
  expect(strangerView.items[0].item_private_state).toBeUndefined();
});
```

Replace `createTestUser`, `postItemAsUser`, `getItemFetch`, `getNetworkItemFetch` with whatever helper functions this project's other integration tests use. Match the existing test style.

- [ ] **Step 3: Update `get_action_contact_details.integration.test.ts`**

The existing test creates two items, performs an action, transitions to `accepted`, and asserts the reveal endpoint returns merged state. After this change, the merged state must include real (decrypted) values for previously-private fields.

Update fixtures so the source/target items go in with private fields populated, then assert on real values in the reveal response:

```ts
expect(response.other_actor.item.item_state.email).toBe('aniket@example.com');
expect(response.other_actor.item.item_state.email).not.toMatch(/\*\*\*/);
```

- [ ] **Step 4: Run integration tests**

```bash
docker compose up -d db redis
pnpm --filter api test:integration
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/item/__tests__/fetch_item.integration.test.ts apps/api/src/routes/v1/action/__tests__/get_action_contact_details.integration.test.ts apps/api/vitest.setup.ts apps/api/vitest.config.ts
git commit -m "test(api): end-to-end coverage for masked-stranger / decrypted-owner reads"
```

Only include files that actually changed.

---

## Task 15: Ops docs + Helm Secret + `.env.example`

**Files:**
- Modify: `docs/operations/secrets.md`
- Modify: `helmcharts/...` (the Signals chart's Secret definitions)

- [ ] **Step 1: Document the env var**

Open `docs/operations/secrets.md`. Add a section:

```markdown
## SIGNALS_PII_KEY

AES-256 master key used to encrypt the `item_private_state` blob at rest.

- **Format:** base64-encoded 32 bytes.
- **Generate:** `openssl rand -base64 32`
- **Provisioning:** the `pii-key` Kubernetes Secret (Helm chart `templates/secret-pii-key.yaml`).
- **Rotation:** there is no in-place key rotation in this iteration. To rotate,
  re-encrypt every existing row with the new key (Drizzle script — out of scope here)
  and then update the Secret. The encrypted envelope carries a `v1:` prefix so a
  future `v2:` rotation path can coexist.
- **Compromise:** treat as equivalent to a full PII leak. Rotate the key and
  re-encrypt all rows.
```

- [ ] **Step 2: Provision the Helm Secret**

Look at the existing aggregator API key Secret template for the pattern:

```bash
ls helmcharts/
grep -rn "apikey\|aggregator" helmcharts/ | head -10
```

Mirror that pattern with a new template (e.g. `helmcharts/<chart>/templates/secret-pii-key.yaml`) that creates a Secret named `pii-key` with a single key `SIGNALS_PII_KEY`, value sourced from `.Values.pii.key` (or whatever naming convention the chart uses for other secrets).

Add to `helmcharts/<chart>/values.yaml`:

```yaml
pii:
  key: ""   # base64-encoded 32-byte AES key; required at install
```

And to the API Deployment's env block:

```yaml
- name: SIGNALS_PII_KEY
  valueFrom:
    secretKeyRef:
      name: pii-key
      key: SIGNALS_PII_KEY
```

- [ ] **Step 3: Helm-lint the chart**

```bash
helm lint helmcharts/<chart>
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
git add docs/operations/secrets.md helmcharts/
git commit -m "ops: provision pii-key Secret and document SIGNALS_PII_KEY"
```

---

## Task 16: Final verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

```bash
pnpm typecheck
```

Expected: success.

- [ ] **Step 2: Full unit test suite**

```bash
pnpm --filter api test
pnpm --filter @dpg/ui test
pnpm --filter @dpg/schemas test
pnpm --filter @dpg/auth test
```

Expected: green.

- [ ] **Step 3: Integration tests**

```bash
docker compose up -d db redis
pnpm --filter api test:integration
```

Expected: green.

- [ ] **Step 4: Schema bundle check**

```bash
pnpm schema:bundle:check
```

Expected: success.

- [ ] **Step 5: Codacy MCP check (per CLAUDE.md)**

After all edits, run the Codacy CLI analyse step that the `.cursor/rules/codacy.mdc` rule requires.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin pii-encryption-at-rest
gh pr create --base develop --title "feat: PII encryption at rest + type-aware masking" --body "$(cat <<'EOF'
## Summary
- AES-256-GCM encryption of `item_private_state` (column type now `text`)
- Type-aware masking (`maskPrivateState`) mirrored into `item_state` so cards always render
- Self-owned and post-accept reveal reads decrypt and overwrite masked values
- UI drops `privacyMode` and the schema-privacy filter; renders `item_state` as-is

## Test plan
- [ ] `pnpm typecheck`
- [ ] `pnpm --filter api test`
- [ ] `pnpm --filter api test:integration`
- [ ] `pnpm --filter @dpg/ui test`
- [ ] Spot-check seeded purple_dot items in DB show `v1:` envelope
- [ ] Manual: owner sees real email; stranger sees masked email

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** crypto module (§1) → Tasks 2-3. Schema/masking + create/update (§2) → Tasks 4-9. Read paths (§3) → Tasks 7, 10, 11. UI changes (§4) → Task 12. Testing + non-goals + ops (§5) → Tasks 14-16. Seed scripts → Task 13. DB type change → Task 6. Env var + Helm → Tasks 1, 15.
- **Placeholders:** Task 8/9 tests reference test fixtures that may not exist verbatim ("profile_1.0" with these fields) — the plan calls this out and tells the engineer to match the project's existing test style. This is intentional, not a TBD.
- **Type consistency:** `decryptItemPrivate(row).mergedState` is the only public surface name used across Tasks 7 and 10. `getPiiKey()` is used identically in Tasks 7-10. `maskPrivateState(itemSchema, privateState)` signature matches across Tasks 4, 8, 9.
