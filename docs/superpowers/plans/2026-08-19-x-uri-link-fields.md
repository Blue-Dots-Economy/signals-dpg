# `x-uri` Link Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `"x-uri": true` per-field marker to `network.json` item schemas so those fields render as clickable links in cards and reject non-URL input in the profile form and on the API.

**Architecture:** A dependency-free shared module `packages/schemas/src/uri_fields.ts` owns the marker name, the single `URL_PATTERN`, and a schema transform that injects that pattern wherever the marker appears. The API calls the transform inside `validateAgainstJsonSchema`; the UI calls it before handing the schema to RJSF/ajv — identical rules on both sides from one source. On the render side, `resolveCardFields` carries an `isUri` flag onto each `CardRow`, and a shared `UriValue` component turns flagged values into safe `<a>` elements on both card surfaces (`ItemCard`'s `FieldRow` and the public `/p/` page).

**Tech Stack:** TypeScript, React 19, RJSF v6 (`@rjsf/shadcn` + `@rjsf/validator-ajv8`), ajv 8 / Ajv2020, Vitest + Testing Library, pnpm workspaces + Turbo, Vite.

**Spec:** `docs/superpowers/specs/2026-08-19-x-uri-link-fields-design.md`

**Issue:** [signals-dpg#565](https://github.com/Blue-Dots-Economy/signals-dpg/issues/565)

## Global Constraints

- **Marker name is exactly `x-uri`,** value exactly boolean `true`. Any other value is ignored (not an error).
- **`URL_PATTERN` is defined once,** in `packages/schemas/src/uri_fields.ts`. Never re-declare or inline this regex anywhere else. Its exact value is:
  ```
  ^\s*$|^\s*(https?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(:\d{1,5})?(\/[^\s]*)?\s*$
  ```
  That is the *regex*. In the TypeScript source it is a **string literal**, so every backslash is doubled — copy the escaped form from Task 1 Step 3 verbatim, do not retype it. It has been verified against both `new RegExp(p, 'u')` and `new Ajv2020({strict:false})`.
- **`packages/schemas/src/uri_fields.ts` must import nothing.** The `@dpg/schemas` barrel pulls in `@dpg/database` → `pg` and breaks the browser build; the UI reaches this module only via the deep alias `@dpg/schemas/uri_fields`.
- **An author-supplied `pattern` always wins.** `applyUriPatterns` never overwrites an existing `pattern` on a marked field.
- **No `network.json` under `examples/schemas/` is modified by this plan.** No field is flagged in this pass (explicit product decision). Nothing changes in `bluedots-schemas` or `bluedots-automation`.
- **A masked value must never become a link.** Any value containing `***` renders as plain text.
- **Every new user-facing string gets a key in all three locale files:** `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`.
- **Commit style:** describe *what changed*, never "review fixes". Conventional-commit prefix (`feat:` / `test:` / `docs:`).
- Branch is `feat/565-x-uri-link-fields`, already created off `origin/feature` at the worktree `/Users/srivastha/KKB/Github/Signals-DPG.worktrees/565-x-uri`. **Never commit or push to `feature` or `develop`.**

---

## Task 0: Worktree setup

**Files:** none (environment only)

- [ ] **Step 1: Install dependencies**

The worktree is fresh and has no `node_modules`.

Run from the worktree root:
```bash
pnpm install
```
Expected: install completes; `apps/ui/node_modules` and `packages/schemas/node_modules` exist.

- [ ] **Step 2: Confirm the baseline test suites are green before changing anything**

```bash
pnpm --filter schemas exec vitest run
pnpm --filter ui exec vitest run src/components/cards src/components/forms
```
Expected: PASS. If anything already fails on `origin/feature`, note it and do not try to fix it in this branch.

---

## Task 1: Shared `uri_fields` module in `@dpg/schemas`

**Files:**
- Create: `packages/schemas/src/uri_fields.ts`
- Create: `packages/schemas/src/__tests__/uri_fields.test.ts`
- Modify: `packages/schemas/src/index.ts` (add a re-export next to the other `export *` lines)
- Modify: `apps/ui/vite.config.ts:349-360` (add a deep alias before the generic `@dpg/*` entry)
- Modify: `apps/ui/tsconfig.json:23-33` (add the matching `paths` entry)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const URI_FIELD_MARKER: 'x-uri'`
  - `const URL_PATTERN: string`
  - `function isUriField(propSchema: unknown): boolean`
  - `function applyUriPatterns<T>(schema: T): T`
  - `function collectUriFieldKeys(schema: unknown): string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/__tests__/uri_fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  URI_FIELD_MARKER,
  URL_PATTERN,
  isUriField,
  applyUriPatterns,
  collectUriFieldKeys,
} from '../uri_fields';

const re = new RegExp(URL_PATTERN, 'u');

describe('URL_PATTERN', () => {
  it.each([
    'example.com',
    'www.example.com',
    'my-site.org',
    'https://example.com',
    'http://sub.domain.co.uk/a/b?q=1#f',
    'https://example.com:8443/x',
    '  https://example.com  ',
    'EXAMPLE.COM',
    '',
    '   ',
  ])('accepts %j', (value) => {
    expect(re.test(value)).toBe(true);
  });

  it.each([
    'companyabc',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.com',
    'http://localhost:3000',
    'http://192.168.1.1',
    'a@b.com',
    'foo bar',
    'https://',
  ])('rejects %j', (value) => {
    expect(re.test(value)).toBe(false);
  });

  it('is enforced by the API ajv config (strict:false, no ajv-formats)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile({
      type: 'object',
      properties: { site: { type: 'string', pattern: URL_PATTERN } },
    });
    expect(validate({ site: 'companyabc' })).toBe(false);
    expect(validate({ site: 'example.com' })).toBe(true);
  });
});

describe('isUriField', () => {
  it('is true only for the exact boolean marker', () => {
    expect(isUriField({ [URI_FIELD_MARKER]: true })).toBe(true);
    expect(isUriField({ [URI_FIELD_MARKER]: 'true' })).toBe(false);
    expect(isUriField({ [URI_FIELD_MARKER]: false })).toBe(false);
    expect(isUriField({})).toBe(false);
    expect(isUriField(null)).toBe(false);
    expect(isUriField('x')).toBe(false);
  });
});

describe('applyUriPatterns', () => {
  it('injects the pattern on a marked string property', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: { site: { type: 'string', 'x-uri': true } },
    }) as any;
    expect(out.properties.site.pattern).toBe(URL_PATTERN);
  });

  it('leaves unmarked properties untouched', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: { name: { type: 'string' } },
    }) as any;
    expect(out.properties.name.pattern).toBeUndefined();
  });

  it('never overwrites an author-supplied pattern', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: { site: { type: 'string', 'x-uri': true, pattern: '^custom$' } },
    }) as any;
    expect(out.properties.site.pattern).toBe('^custom$');
  });

  it('injects into items for a marked array-of-strings', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: {
        links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
      },
    }) as any;
    expect(out.properties.links.items.pattern).toBe(URL_PATTERN);
    expect(out.properties.links.pattern).toBeUndefined();
  });

  it('recurses into nested object properties', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: {
        org: {
          type: 'object',
          properties: { site: { type: 'string', 'x-uri': true } },
        },
      },
    }) as any;
    expect(out.properties.org.properties.site.pattern).toBe(URL_PATTERN);
  });

  it('does not mutate the input schema', () => {
    const input = { type: 'object', properties: { site: { type: 'string', 'x-uri': true } } };
    const snapshot = JSON.stringify(input);
    applyUriPatterns(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns non-object input unchanged', () => {
    expect(applyUriPatterns(null as any)).toBeNull();
    expect(applyUriPatterns(undefined as any)).toBeUndefined();
  });
});

describe('collectUriFieldKeys', () => {
  it('returns the top-level marked property names', () => {
    expect(
      collectUriFieldKeys({
        type: 'object',
        properties: {
          site: { type: 'string', 'x-uri': true },
          links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
          name: { type: 'string' },
        },
      }),
    ).toEqual(['site', 'links']);
  });

  it('returns an empty array for a schema with no properties', () => {
    expect(collectUriFieldKeys({ type: 'object' })).toEqual([]);
    expect(collectUriFieldKeys(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter schemas exec vitest run src/__tests__/uri_fields.test.ts
```
Expected: FAIL — `Failed to resolve import "../uri_fields"`.

- [ ] **Step 3: Write the implementation**

Create `packages/schemas/src/uri_fields.ts`. **No imports** — see Global Constraints.

```ts
/**
 * Marker-driven URL fields.
 *
 *   "x-uri": true   — this field holds a URL. The UI renders its value as a
 *                     clickable link in profile/item cards, and both the form
 *                     and the API validate the value against URL_PATTERN.
 *
 * Valid on a string property, or on an array-of-strings property (the pattern
 * is then injected into `items`, so a domain can offer "add as many links as
 * you like"). Shared by the UI (card render + form validation) and the API
 * (item_state / action-payload validation) so both enforce identical rules.
 *
 * This module must stay dependency-free: the UI imports it through the deep
 * alias `@dpg/schemas/uri_fields`, because the `@dpg/schemas` barrel re-exports
 * DB-bound modules and breaks the browser build.
 */

type JsonRecord = Record<string, unknown>;

/** The `network.json` field-level marker. */
export const URI_FIELD_MARKER = 'x-uri' as const;

/**
 * The one URL rule, enforced by the profile form AND the API.
 *
 *  - The scheme is optional: `example.com` is accepted and stored as typed;
 *    the card prefixes `https://` when it builds the href.
 *  - Surrounding whitespace is tolerated (users paste with a trailing space);
 *    the href builder trims.
 *  - The empty string is accepted — presence is `required[]`'s job, not the
 *    pattern's. A required link field should also carry `minLength: 1`.
 *  - A host must contain a dot and end in letters, so `companyabc`,
 *    `http://localhost:3000` and bare IPs are rejected, as are non-http(s)
 *    schemes such as `javascript:` and `data:`.
 *
 * `pattern` is deliberately used rather than `format: "uri"`: `format` is
 * ignored by the API's ajv instance (no `ajv-formats` registered), and ajv's
 * `uri` format would reject the scheme-less input users actually type.
 */
export const URL_PATTERN =
  '^\\s*$|^\\s*(https?:\\/\\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}(:\\d{1,5})?(\\/[^\\s]*)?\\s*$';

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a property schema carries the marker with the exact boolean `true`. */
export function isUriField(propSchema: unknown): boolean {
  return isPlainObject(propSchema) && propSchema[URI_FIELD_MARKER] === true;
}

/**
 * Return a copy of `schema` with `pattern: URL_PATTERN` injected on every
 * marked field that does not already define its own `pattern`. For a marked
 * array property the pattern goes on `items` (patterns apply to strings, not
 * arrays). Recurses through `properties` and `items` so nested objects are
 * covered. The marker itself is left in place — the UI's
 * `normalizeSchemaForRjsf` strips it, and the API's ajv runs with
 * `strict: false` and ignores unknown keywords.
 */
export function applyUriPatterns<T>(schema: T): T {
  if (!isPlainObject(schema)) return schema;
  return transform(schema) as T;
}

function transform(node: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...node };

  if (isPlainObject(node.properties)) {
    const props: JsonRecord = {};
    for (const [key, prop] of Object.entries(node.properties)) {
      props[key] = isPlainObject(prop) ? withPattern(transform(prop)) : prop;
    }
    out.properties = props;
  }

  if (isPlainObject(node.items)) {
    out.items = transform(node.items);
  }

  return out;
}

/** Apply the pattern to a single (already recursed) property schema. */
function withPattern(prop: JsonRecord): JsonRecord {
  if (!isUriField(prop)) return prop;

  if (prop.type === 'array') {
    if (!isPlainObject(prop.items) || prop.items.pattern !== undefined) return prop;
    return { ...prop, items: { ...prop.items, pattern: URL_PATTERN } };
  }

  if (prop.pattern !== undefined) return prop;
  return { ...prop, pattern: URL_PATTERN };
}

/**
 * The top-level property names carrying the marker. Used by the form to map an
 * ajv `pattern` error back to "this is a link field" so the message can be
 * rewritten into something a user understands.
 */
export function collectUriFieldKeys(schema: unknown): string[] {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(([, prop]) => isUriField(prop))
    .map(([key]) => key);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter schemas exec vitest run src/__tests__/uri_fields.test.ts
```
Expected: PASS, all cases.

- [ ] **Step 5: Export from the barrel (for the API)**

In `packages/schemas/src/index.ts`, add next to the other `export *` lines (after the `export * from './item_state_masking';` line):

```ts
export * from './uri_fields';
```

- [ ] **Step 6: Add the UI deep-import alias**

In `apps/ui/vite.config.ts`, inside `resolve.alias`, add a new entry **immediately after** the existing `@dpg/schemas/location_fields` entry and **before** the generic `@dpg/*` entry:

```ts
        // Same reasoning as location_fields above: a dependency-free subpath so
        // the browser bundle never pulls the DB-bound @dpg/schemas barrel.
        {
          find: '@dpg/schemas/uri_fields',
          replacement: path.resolve(
            __dirname,
            '../../packages/schemas/src/uri_fields.ts',
          ),
        },
```

In `apps/ui/tsconfig.json`, add to `compilerOptions.paths` (before the generic `@dpg/*` entry):

```json
      "@dpg/schemas/uri_fields": [
        "../../packages/schemas/src/uri_fields"
      ],
```

- [ ] **Step 7: Verify the alias resolves**

```bash
pnpm --filter ui exec tsc --noEmit
```
Expected: PASS (no new errors). This only proves the tsconfig path; the Vite alias is exercised by Task 3's tests.

- [ ] **Step 8: Commit**

```bash
git add packages/schemas/src/uri_fields.ts \
        packages/schemas/src/__tests__/uri_fields.test.ts \
        packages/schemas/src/index.ts \
        apps/ui/vite.config.ts \
        apps/ui/tsconfig.json
git commit -m "feat(schemas): add x-uri field marker and shared URL pattern"
```

---

## Task 2: Enforce the URL pattern on the API

**Files:**
- Modify: `packages/schemas/src/network_workflow.ts:623-650` (`validateAgainstJsonSchema`)
- Create: `packages/schemas/src/__tests__/uri_fields_validation.test.ts`

**Interfaces:**
- Consumes: `applyUriPatterns` from Task 1.
- Produces: no new exports; `validateAgainstJsonSchema` gains the behaviour that a marked field rejects non-URL values.

**Why:** `validateAgainstJsonSchema` compiles `new Ajv2020({ strict: false })` with **no `ajv-formats`**, so `format` is ignored on every write. Without this task, validation is UI-only and any API, bulk-import, or aggregator write can store `companyabc` in a link field.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/__tests__/uri_fields_validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateAgainstJsonSchema } from '../network_workflow';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    site: { type: 'string', 'x-uri': true },
    links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
  },
};

describe('validateAgainstJsonSchema with x-uri fields', () => {
  it('rejects a non-URL value in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: 'companyabc' }, 'item_state'),
    ).toThrow(/Invalid item_state/);
  });

  it('accepts a scheme-less host in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: 'example.com' }, 'item_state'),
    ).not.toThrow();
  });

  it('accepts a full URL in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: 'https://example.com/x' }, 'item_state'),
    ).not.toThrow();
  });

  it('rejects a non-URL entry inside a marked array', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { links: ['https://a.com', 'nope'] }, 'item_state'),
    ).toThrow(/Invalid item_state/);
  });

  it('leaves unmarked fields unconstrained', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { name: 'companyabc' }, 'item_state'),
    ).not.toThrow();
  });

  it('accepts an empty string in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: '' }, 'item_state'),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter schemas exec vitest run src/__tests__/uri_fields_validation.test.ts
```
Expected: FAIL — the first and fourth cases do not throw, because `x-uri` is currently an unknown keyword that `strict: false` ignores.

- [ ] **Step 3: Wire the transform into `validateAgainstJsonSchema`**

In `packages/schemas/src/network_workflow.ts`, add the import at the top of the file (next to the existing imports):

```ts
import { applyUriPatterns } from './uri_fields';
```

Then, inside `validateAgainstJsonSchema`, change the schema-transform chain. It currently reads:

```ts
  const schemaForValidation = options.allowAdditionalProperties
    ? allowAdditionalProperties(schema)
    : schema;
  const finalSchema =
    ignoredKeys.length > 0
      ? omitRequiredSchemaKeys(schemaForValidation, ignoredKeys)
      : schemaForValidation;
```

Replace with:

```ts
  // `x-uri` fields get the shared URL pattern injected before compilation. The
  // API's ajv registers no `ajv-formats`, so `format` is ignored on every
  // write — `pattern` is what actually bites here, and it is the SAME pattern
  // the profile form applies client-side (packages/schemas/src/uri_fields.ts).
  const schemaWithUriPatterns = applyUriPatterns(schema);
  const schemaForValidation = options.allowAdditionalProperties
    ? allowAdditionalProperties(schemaWithUriPatterns)
    : schemaWithUriPatterns;
  const finalSchema =
    ignoredKeys.length > 0
      ? omitRequiredSchemaKeys(schemaForValidation, ignoredKeys)
      : schemaForValidation;
```

Note the type of the `schema` parameter: if `applyUriPatterns` returns a type the following calls reject, keep the existing parameter type by annotating the local as the same type the function already declares for `schema`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter schemas exec vitest run src/__tests__/uri_fields_validation.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run the whole schemas suite for regressions**

```bash
pnpm --filter schemas exec vitest run
```
Expected: PASS. Every existing test must still pass — no `examples/schemas` field carries the marker, so nothing should change behaviour.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/network_workflow.ts \
        packages/schemas/src/__tests__/uri_fields_validation.test.ts
git commit -m "feat(api): enforce the x-uri URL pattern during item_state validation"
```

---

## Task 3: Safe href builder + `UriValue` component

**Files:**
- Create: `apps/ui/src/lib/uri-field.ts`
- Create: `apps/ui/src/lib/uri-field.test.ts`
- Create: `apps/ui/src/components/cards/uri-value.tsx`
- Create: `apps/ui/src/components/cards/__tests__/uri-value.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `function toSafeHref(value: string): string | null`
  - `const URI_DISPLAY_MAX_CHARS: number` (60)
  - `function UriValue({ value, className }: { value: unknown; className?: string }): JSX.Element`

- [ ] **Step 1: Write the failing test for `toSafeHref`**

Create `apps/ui/src/lib/uri-field.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toSafeHref } from './uri-field';

describe('toSafeHref', () => {
  it('passes http and https through unchanged', () => {
    expect(toSafeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(toSafeHref('http://example.com')).toBe('http://example.com');
  });

  it('prefixes https:// on a scheme-less host', () => {
    expect(toSafeHref('example.com')).toBe('https://example.com');
    expect(toSafeHref('www.example.com/a')).toBe('https://www.example.com/a');
  });

  it('trims surrounding whitespace', () => {
    expect(toSafeHref('  example.com  ')).toBe('https://example.com');
  });

  it('returns null for a masked value', () => {
    expect(toSafeHref('https://***')).toBeNull();
    expect(toSafeHref('***')).toBeNull();
  });

  it('returns null for a non-http(s) scheme', () => {
    expect(toSafeHref('javascript:alert(1)')).toBeNull();
    expect(toSafeHref('data:text/html,<b>x</b>')).toBeNull();
    expect(toSafeHref('mailto:a@b.com')).toBeNull();
    expect(toSafeHref('ftp://example.com')).toBeNull();
  });

  it('returns null for blank input', () => {
    expect(toSafeHref('')).toBeNull();
    expect(toSafeHref('   ')).toBeNull();
  });

  it('returns null for something that cannot be a URL', () => {
    expect(toSafeHref('companyabc')).toBeNull();
    expect(toSafeHref('foo bar')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter ui exec vitest run src/lib/uri-field.test.ts
```
Expected: FAIL — `Failed to resolve import "./uri-field"`.

- [ ] **Step 3: Implement `toSafeHref`**

Create `apps/ui/src/lib/uri-field.ts`:

```ts
/**
 * Turn a stored `x-uri` field value into an href that is safe to put in an
 * `<a>`, or null when it must not be linked. Callers render plain text on null,
 * so a bad or masked value degrades instead of producing a dead link.
 */

/** Display text longer than this is elided; the href always keeps the full value. */
export const URI_DISPLAY_MAX_CHARS = 60;

/** Any explicit `scheme:` prefix, e.g. `https:`, `javascript:`, `mailto:`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function toSafeHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Masked public projection (the API rewrites uri-ish fields to `https://***`
  // for viewers who have not connected). Never link a stub.
  if (trimmed.includes('***')) return null;

  let candidate: string;
  if (SCHEME_RE.test(trimmed)) {
    // An explicit scheme is honoured only if it is http(s); this is what blocks
    // `javascript:` and `data:`.
    if (!/^https?:/i.test(trimmed)) return null;
    candidate = trimmed;
  } else {
    candidate = `https://${trimmed}`;
  }

  // Final gate: it must parse as a real URL with an http(s) protocol and a host
  // that looks like a hostname (a dot, and no spaces).
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return candidate;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter ui exec vitest run src/lib/uri-field.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing test for `UriValue`**

Create `apps/ui/src/components/cards/__tests__/uri-value.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UriValue } from '../uri-value';

describe('UriValue', () => {
  it('renders a safe link with the value as its text', () => {
    render(<UriValue value="https://example.com" />);
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('prefixes a scheme-less value in the href but shows it as typed', () => {
    render(<UriValue value="example.com" />);
    const link = screen.getByRole('link', { name: 'example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('renders a masked value as plain text, not a link', () => {
    render(<UriValue value="https://***" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('https://***')).toBeInTheDocument();
  });

  it('renders an unlinkable value as plain text', () => {
    render(<UriValue value="companyabc" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('companyabc')).toBeInTheDocument();
  });

  it('renders each entry of an array as its own link', () => {
    render(<UriValue value={['https://a.com', 'https://b.com']} />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('elides long display text but keeps the full href', () => {
    const long = `https://example.com/${'a'.repeat(120)}`;
    render(<UriValue value={long} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', long);
    expect(link).toHaveAttribute('title', long);
    expect(link.textContent!.length).toBeLessThan(long.length);
    expect(link.textContent!.endsWith('…')).toBe(true);
  });

  it('renders an em dash for an empty value', () => {
    render(<UriValue value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
pnpm --filter ui exec vitest run src/components/cards/__tests__/uri-value.test.tsx
```
Expected: FAIL — `Failed to resolve import "../uri-value"`.

- [ ] **Step 7: Implement `UriValue`**

Create `apps/ui/src/components/cards/uri-value.tsx`:

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';
import { toSafeHref, URI_DISPLAY_MAX_CHARS } from '@/lib/uri-field';

/**
 * Renders the value of a field flagged `"x-uri": true` in network.json.
 *
 * Each linkable entry becomes an `<a>`; anything that is not safely linkable
 * (masked stub, non-http scheme, junk) falls back to the plain text it renders
 * today, so a bad value degrades instead of producing a dead link. Arrays
 * render one link per entry.
 */
export function UriValue({ value, className }: Readonly<{ value: unknown; className?: string }>) {
  const entries = (Array.isArray(value) ? value : [value])
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => String(entry))
    .filter((entry) => entry.trim().length > 0);

  if (entries.length === 0) return <>—</>;

  return (
    <>
      {entries.map((entry, index) => (
        <React.Fragment key={`${entry}-${index}`}>
          {index > 0 && ', '}
          <UriEntry value={entry} className={className} />
        </React.Fragment>
      ))}
    </>
  );
}

function UriEntry({ value, className }: Readonly<{ value: string; className?: string }>) {
  const href = toSafeHref(value);
  if (!href) return <>{value}</>;

  // A URL needs no progressive disclosure, so unlike a long text field there is
  // no "Show more" toggle — the text is elided and the full value lives in the
  // href and the tooltip.
  const text =
    value.length > URI_DISPLAY_MAX_CHARS
      ? `${value.slice(0, URI_DISPLAY_MAX_CHARS).trimEnd()}…`
      : value;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={value}
      // List cards carry their own onClick; without this, following a link
      // would also trigger the card's click handler.
      onClick={(e) => e.stopPropagation()}
      className={cn('font-medium text-primary underline underline-offset-2 hover:opacity-80', className)}
    >
      {text}
    </a>
  );
}
```

- [ ] **Step 8: Run it to verify it passes**

```bash
pnpm --filter ui exec vitest run src/components/cards/__tests__/uri-value.test.tsx src/lib/uri-field.test.ts
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src/lib/uri-field.ts \
        apps/ui/src/lib/uri-field.test.ts \
        apps/ui/src/components/cards/uri-value.tsx \
        apps/ui/src/components/cards/__tests__/uri-value.test.tsx
git commit -m "feat(ui): add safe href builder and UriValue link renderer"
```

---

## Task 4: Carry the marker onto `CardRow` and render links in `ItemCard`

**Files:**
- Modify: `apps/ui/src/components/cards/resolve-card-fields.ts` (`CardRow` interface, `makeRow`)
- Modify: `apps/ui/src/components/cards/item-card.tsx` (`FieldRow`)
- Create: `apps/ui/src/components/cards/__tests__/uri-card-fields.test.tsx`

**Interfaces:**
- Consumes: `isUriField` from `@dpg/schemas/uri_fields` (Task 1); `UriValue` from `./uri-value` (Task 3).
- Produces: `CardRow` gains `isUri: boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/components/cards/__tests__/uri-card-fields.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { resolveCardFields } from '../resolve-card-fields';
import { ItemCard } from '../item-card';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    site: { type: 'string', title: 'Site', 'x-uri': true },
    notes: { type: 'string', title: 'Notes' },
  },
} as never;

describe('resolveCardFields marks x-uri rows', () => {
  it('sets isUri on a marked field and not on others', () => {
    const resolved = resolveCardFields(schema, {
      name: 'Asha',
      site: 'https://example.com',
      notes: 'hello',
    });
    const rows = [...resolved.defaultRows, ...resolved.extraRows];
    expect(rows.find((r) => r.key === 'site')?.isUri).toBe(true);
    expect(rows.find((r) => r.key === 'name')?.isUri).toBe(false);
    expect(rows.find((r) => r.key === 'notes')?.isUri).toBe(false);
  });
});

describe('ItemCard renders x-uri rows as links', () => {
  it('renders a flagged field as a hyperlink', () => {
    render(<ItemCard schema={schema} data={{ name: 'Asha', site: 'https://example.com' }} />);
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('leaves non-flagged fields as plain text', () => {
    render(
      <ItemCard schema={schema} data={{ name: 'Asha', notes: 'https://example.com' }} />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
  });

  it('does not link a masked value', () => {
    render(<ItemCard schema={schema} data={{ name: 'Asha', site: 'https://***' }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('does not fire the card onClick when the link is followed', () => {
    const onClick = vi.fn();
    render(
      <ItemCard
        schema={schema}
        data={{ name: 'Asha', site: 'https://example.com' }}
        onClick={onClick}
      />,
    );
    screen.getByRole('link').click();
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter ui exec vitest run src/components/cards/__tests__/uri-card-fields.test.tsx
```
Expected: FAIL — `isUri` is `undefined` and no link is rendered.

- [ ] **Step 3: Add `isUri` to `CardRow`**

In `apps/ui/src/components/cards/resolve-card-fields.ts`, add the import at the top:

```ts
import { isUriField } from '@dpg/schemas/uri_fields';
```

Extend the `CardRow` interface (add the field after `type`):

```ts
  type?: string;
  /** Field is flagged `"x-uri": true` in network.json — render as a hyperlink. */
  isUri: boolean;
```

And in `makeRow`, add it to the returned object:

```ts
  return {
    key,
    label: prop?.title ?? humaniseFieldKey(key),
    value,
    type: prop?.type as string | undefined,
    isUri: isUriField(prop),
    isEmpty: isEmptyValue(value),
  };
```

- [ ] **Step 4: Render links in `FieldRow`**

In `apps/ui/src/components/cards/item-card.tsx`, add the import:

```ts
import { UriValue } from './uri-value';
```

Then in `FieldRow`, short-circuit the long-text machinery for link rows. Replace the body of the value `<span>` — whose current content is (abridged):

```tsx
        {display}
        {isLong && (
          <button ... >...</button>
        )}
```

Restructure `FieldRow` so the link case is computed before the truncation logic:

```tsx
function FieldRow({ row, compact = false }: { row: CardRow; compact?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const formatted = formatCardValue(row.value, row.type);
  // A link row skips the "Show more" toggle: UriValue elides its own display
  // text and keeps the full value in the href + tooltip.
  const isLong = !row.isUri && formatted.length > LONG_VALUE_PREVIEW_CHARS;
  const display =
    isLong && !expanded
      ? `${formatted.slice(0, LONG_VALUE_PREVIEW_CHARS).trimEnd()}… `
      : formatted;
```

and inside the value `<span>`:

```tsx
        {row.isUri ? <UriValue value={row.value} /> : display}
        {isLong && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="font-medium text-primary hover:underline"
          >
            {expanded ? t('card.show_less', 'Show less') : t('card.show_more', 'Show more')}
          </button>
        )}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter ui exec vitest run src/components/cards/__tests__/uri-card-fields.test.tsx
```
Expected: PASS.

- [ ] **Step 6: Run the card + typecheck regression pass**

```bash
pnpm --filter ui exec vitest run src/components/cards src/pages
pnpm --filter ui exec tsc --noEmit
```
Expected: PASS. If any existing test constructs a `CardRow` literal, it now needs `isUri: false` — add it rather than making the field optional, so the flag is always explicit.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/components/cards/resolve-card-fields.ts \
        apps/ui/src/components/cards/item-card.tsx \
        apps/ui/src/components/cards/__tests__/uri-card-fields.test.tsx
git commit -m "feat(ui): render x-uri card fields as hyperlinks"
```

---

## Task 5: Links on the public profile page

**Files:**
- Modify: `apps/ui/src/pages/public-profile-page.tsx:585-595`
- Modify: `apps/ui/src/pages/__tests__/public-profile-page.test.tsx` (append a `describe` block)

**Interfaces:**
- Consumes: `CardRow.isUri` (Task 4), `UriValue` (Task 3).
- Produces: nothing new.

**Why separate from Task 4:** the public `/p/` page calls `formatCardValue()` directly and never goes through `FieldRow`, so Task 4 does not reach it. This is also the surface most likely to hold masked values.

- [ ] **Step 1: Write the failing test**

`apps/ui/src/pages/__tests__/public-profile-page.test.tsx` already has a full mounting harness (mocked `useItemDetail` / `useResolvedNetwork` / `useAuth` / `useMyItems`, a `wrapper`, and a `renderAt(path)` helper). **Extend that file** rather than writing a new harness.

Its shared `resolvedNetwork` const is used by every existing test, so do **not** add the link field to it — declare a separate network for these cases and override the mock per-test.

Append to the end of the file:

```tsx
describe('PublicProfilePage x-uri fields', () => {
  const uriNetwork = {
    ...resolvedNetwork,
    domains: [
      {
        ...resolvedNetwork.domains[0],
        item_schemas: {
          'profile_1.0': {
            type: 'object',
            properties: {
              name: { type: 'string', title: 'Name' },
              site: { type: 'string', title: 'Site', 'x-uri': true },
              notes: { type: 'string', title: 'Notes' },
            },
          },
        },
      },
    ],
  };

  function renderWithSite(site: string, extra: Record<string, unknown> = {}) {
    useResolvedNetwork.mockReturnValue({ data: uriNetwork, isLoading: false, isError: false });
    useItemDetail.mockReturnValue({
      item: {
        item_id: ID,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { name: 'Asha', site, ...extra },
        lifecycle_status: 'live',
      },
      isLoading: false,
      isError: false,
    });
    return renderAt(`/public/blue_dot/seeker/profile_1.0/${ID}`);
  }

  it('renders a flagged field as a hyperlink', () => {
    renderWithSite('https://example.com');
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders a masked flagged field as plain text', () => {
    renderWithSite('https://***');
    expect(screen.queryByRole('link', { name: /example/ })).toBeNull();
    expect(screen.getByText('https://***')).toBeInTheDocument();
  });

  it('leaves an unflagged field holding a URL as plain text', () => {
    renderWithSite('https://example.com', { notes: 'https://plain.example.org' });
    expect(screen.queryByRole('link', { name: 'https://plain.example.org' })).toBeNull();
    expect(screen.getByText('https://plain.example.org')).toBeInTheDocument();
  });
});
```

Note: the page renders other links (the "Explore more" nav). Scope every `queryByRole('link')` assertion with a name matcher, as above, rather than asserting there are no links at all.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter ui exec vitest run src/pages/__tests__/public-profile-page.test.tsx
```
Expected: FAIL on the first case — the page renders `https://example.com` as text, so no link with that accessible name exists.

- [ ] **Step 3: Use `UriValue` in the page**

In `apps/ui/src/pages/public-profile-page.tsx`, add the import next to the existing card imports:

```ts
import { UriValue } from '@/components/cards/uri-value';
```

Then in the details grid, replace:

```tsx
                <div className="mt-1 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                  {formatCardValue(row.value, row.type)}
                </div>
```

with:

```tsx
                <div className="mt-1 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                  {row.isUri ? <UriValue value={row.value} /> : formatCardValue(row.value, row.type)}
                </div>
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter ui exec vitest run src/pages
```
Expected: PASS — the new block, and every pre-existing test in that file.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/public-profile-page.tsx \
        apps/ui/src/pages/__tests__/public-profile-page.test.tsx
git commit -m "feat(ui): render x-uri fields as links on the public profile page"
```

---

## Task 6: Form validation for `x-uri` fields

**Files:**
- Modify: `apps/ui/src/components/forms/schema-form.tsx` (imports; `normalizeSchemaForRjsf` strip list; `generateUiSchema` placeholder; `rjsfSchema` memo; new `transformErrors` on `<Form>`)
- Modify: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`
- Create: `apps/ui/src/components/forms/__tests__/schema-form-uri.test.tsx`

**Interfaces:**
- Consumes: `applyUriPatterns`, `collectUriFieldKeys` from `@dpg/schemas/uri_fields` (Task 1).
- Produces: nothing new exported.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/components/forms/__tests__/schema-form-uri.test.tsx`.

Two constraints, both verified against the current source:

- `normalizeSchemaForRjsf` (line 360) and `generateUiSchema` (line 224) are **module-private**; only `isSchemaFormValid` (line 418) is exported. Do not add exports just for tests — assert through `SchemaForm` and through `isSchemaFormValid` fed a pre-transformed schema.
- RJSF v6's form submit does not fire under happy-dom (the suite default). `schema-form.test.tsx` works around this with a per-file `// @vitest-environment jsdom` pragma — this file needs the same pragma for its submit case.

```tsx
// RJSF v6's form submit does not fire under happy-dom (the suite default); jsdom
// implements form submission, so this file overrides the environment per-file.
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import validator from '@rjsf/validator-ajv8';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm, isSchemaFormValid } from '../schema-form';
import { applyUriPatterns } from '@dpg/schemas/uri_fields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    site: { type: 'string', title: 'Site', 'x-uri': true },
  },
} as RJSFSchema;

describe('applyUriPatterns + the RJSF validator', () => {
  // RJSF's ajv also runs strict:false, so the injected `pattern` is what bites;
  // the marker itself is inert. These cases pin the rule the form enforces.
  const patched = applyUriPatterns(schema);

  it('rejects a non-URL value in a marked field', () => {
    expect(isSchemaFormValid(validator, patched, { site: 'companyabc' })).toBe(false);
  });

  it('accepts a scheme-less host, a full URL, and an empty value', () => {
    expect(isSchemaFormValid(validator, patched, { site: 'example.com' })).toBe(true);
    expect(isSchemaFormValid(validator, patched, { site: 'https://example.com/x' })).toBe(true);
    expect(isSchemaFormValid(validator, patched, { site: '' })).toBe(true);
  });

  it('leaves unmarked fields unconstrained', () => {
    expect(isSchemaFormValid(validator, patched, { name: 'companyabc' })).toBe(true);
  });
});

describe('SchemaForm with an x-uri field', () => {
  it('blocks submit and shows a readable message for a non-URL value', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ name: 'Asha', site: 'companyabc' }}
        onSubmit={onSubmit}
        submitButtonText="Save"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter a valid link/i)).toBeInTheDocument();
    expect(screen.queryByText(/must match pattern/i)).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a scheme-less host unchanged', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ name: 'Asha', site: 'example.com' }}
        onSubmit={onSubmit}
        submitButtonText="Save"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ site: 'example.com' }));
  });

  it('uses the URL placeholder on the marked field', () => {
    render(<SchemaForm schema={schema} formData={{}} onSubmit={vi.fn()} submitButtonText="Save" />);
    expect(screen.getByLabelText(/Site/)).toHaveAttribute('placeholder', 'https://example.com');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter ui exec vitest run src/components/forms/__tests__/schema-form-uri.test.tsx
```
Expected: FAIL — the pattern is never injected, so `companyabc` validates, and the raw ajv message is shown.

- [ ] **Step 3: Strip the marker and inject the pattern**

In `apps/ui/src/components/forms/schema-form.tsx`, add the imports:

```ts
import { useTranslation } from 'react-i18next';
import { applyUriPatterns, collectUriFieldKeys, URI_FIELD_MARKER } from '@dpg/schemas/uri_fields';
```

In `normalizeSchemaForRjsf`, add to the strip list alongside the other custom keywords (after the `x-reference-source` case):

```ts
    // Strip the custom `x-uri` marker — its effect is the `pattern` injected by
    // applyUriPatterns before this point, plus the card-side link rendering.
    // (RJSF's ajv runs strict:false so an unknown keyword would be tolerated,
    // but every other custom marker is stripped here; keep it consistent.)
    if (key === URI_FIELD_MARKER) continue;
```

In the `rjsfSchema` memo, wrap the schema:

```ts
  const rjsfSchema = React.useMemo(
    // applyUriPatterns FIRST: it injects `pattern` for `x-uri` fields, then
    // normalizeSchemaForRjsf strips the marker so ajv only sees the pattern.
    () => normalizeSchemaForRjsf(applyUriPatterns(resolved.schema)),
    // resolved.schema depends only on (schema, visible set); key on hiddenKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, hiddenKey],
  );
```

- [ ] **Step 4: Add the placeholder**

In `generateUiSchema`, next to the existing `format === 'email'` case, add:

```ts
    if (typed[URI_FIELD_MARKER] === true) {
      uiSchema[key] = { ...(uiSchema[key] as object), 'ui:placeholder': 'https://example.com' };
    }
```

(The `typed` local is declared as `prop as RJSFSchema & { private?: boolean; format?: string }` — widen it to include `[URI_FIELD_MARKER]?: unknown` so this compiles.)

Note the ordering constraint already documented in that function: the author's own field-level `placeholder` must still win, so this block must sit **above** the existing `fieldPlaceholder` block.

- [ ] **Step 5: Add the friendly error message**

Inside the `SchemaForm` component body, add:

```ts
  const { t } = useTranslation();

  // ajv reports a pattern failure as `must match pattern "^\s*$|^\s*(https?..."`,
  // which is meaningless to a user. Rewrite it for `x-uri` fields only.
  const uriFieldKeys = React.useMemo(
    () => new Set(collectUriFieldKeys(baseSchema)),
    [baseSchema],
  );
  const transformErrors = React.useCallback(
    (errors: RjsfError[]) =>
      errors.map((error) => {
        if (error.name !== 'pattern') return error;
        const field = (error.property ?? '').replace(/^\./, '').split('.')[0];
        if (!uriFieldKeys.has(field)) return error;
        return {
          ...error,
          message: t('form.invalid_url', 'Enter a valid link, e.g. https://example.com'),
        };
      }),
    [uriFieldKeys, t],
  );
```

and pass it to `<Form>` next to the existing `onError` prop:

```tsx
        transformErrors={transformErrors}
```

If the local `RjsfError` interface does not satisfy RJSF's own error type here, import `RJSFValidationError` from `@rjsf/utils` and type the callback with it instead — do not widen the local `RjsfError`, which `fieldIdFromError` depends on.

- [ ] **Step 6: Add the i18n key to all three locales**

`apps/ui/src/i18n/locales/en.json`:
```json
  "form.invalid_url": "Enter a valid link, e.g. https://example.com",
```

`apps/ui/src/i18n/locales/hi.json`:
```json
  "form.invalid_url": "एक मान्य लिंक दर्ज करें, जैसे https://example.com",
```

`apps/ui/src/i18n/locales/kn.json`:
```json
  "form.invalid_url": "ಮಾನ್ಯವಾದ ಲಿಂಕ್ ಅನ್ನು ನಮೂದಿಸಿ, ಉದಾ. https://example.com",
```

Insert each in the same relative position the file's existing ordering implies (these files are flat key/value maps; match the surrounding grouping).

- [ ] **Step 7: Run the test to verify it passes**

```bash
pnpm --filter ui exec vitest run src/components/forms
```
Expected: PASS, including the pre-existing `schema-form*.test.tsx` files.

- [ ] **Step 8: Full UI regression + typecheck**

```bash
pnpm --filter ui exec vitest run
pnpm --filter ui exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src/components/forms/schema-form.tsx \
        apps/ui/src/components/forms/__tests__/schema-form-uri.test.tsx \
        apps/ui/src/i18n/locales/en.json \
        apps/ui/src/i18n/locales/hi.json \
        apps/ui/src/i18n/locales/kn.json
git commit -m "feat(ui): validate x-uri form fields as URLs with a readable error"
```

---

## Task 7: Document the marker

**Files:**
- Modify: `CLAUDE.md` (schema-marker section, next to the `x-reference-source` bullet at line ~50)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the marker documentation**

In `CLAUDE.md`, immediately after the existing `x-reference-source` bullet, add:

```markdown
- **`x-uri` schema marker (#565).** A `network.json` item-schema field may carry `"x-uri": true` to declare that it holds a URL. Any number of fields per schema may be flagged. Two effects: (1) the profile/item cards render the value as a **clickable link** (`target="_blank" rel="noopener noreferrer"`) rather than plain text — an inline link in the field row, *not* an action button; (2) the shared `URL_PATTERN` from `packages/schemas/src/uri_fields.ts` is injected as a JSON Schema `pattern` on both the client (`schema-form.tsx`, before ajv) and the server (`validateAgainstJsonSchema`), so `companyabc` is rejected on the form *and* on the API. The scheme is optional (`example.com` is accepted and stored as typed; the card prefixes `https://` when building the href) and the empty string is allowed — use `minLength: 1` for a required link field. Also valid on an array-of-strings property, where the pattern lands on `items` and each entry renders as its own link. Masked values (`https://***`) and non-`http(s)` schemes are never linked. `pattern` is used rather than `format: "uri"` because the API's ajv registers no `ajv-formats` (so `format` is ignored on writes) and ajv's `uri` format rejects the scheme-less input users actually type. **Caution:** flagging a field that already holds non-URL data in live items will make updates to those items fail with `INVALID_ITEM_STATE` — audit the data first. The marker is stripped before schema validation (client and server), so item validation is otherwise unaffected.
```

- [ ] **Step 2: Verify no schema files were touched**

```bash
git diff --stat origin/feature -- examples/ | cat
```
Expected: **empty output**. No `network.json` is flagged in this pass, so nothing propagates to `bluedots-schemas` or `bluedots-automation`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the x-uri network.json field marker"
```

---

## Task 8: Manual verification and PR

**Files:** none committed (the schema edit in Step 2 is reverted before the PR).

- [ ] **Step 1: Full verification sweep**

```bash
pnpm --filter schemas exec vitest run
pnpm --filter ui exec vitest run
pnpm --filter ui exec tsc --noEmit
pnpm --filter api exec tsc --noEmit
```
Expected: all PASS. Paste the actual output into the PR body — do not claim green without it.

- [ ] **Step 2: Temporarily flag a field for a live check**

Because no field is flagged in this pass, end-to-end behaviour has to be exercised with a throwaway edit. In `examples/schemas/purple_dot/network.json`, add `"x-uri": true` to the `catalog_url` property (around line 410).

Start the stack (see the `run-signals-dpg` skill or `README.md`), then confirm:
- the provider profile form rejects `companyabc` in Catalog URL with "Enter a valid link, e.g. https://example.com";
- it accepts `example.com`;
- the provider card (browse list and map popup) shows Catalog URL as a clickable link that opens in a new tab;
- clicking the link does not also open the card;
- the `/p/` public profile page shows the same link;
- a non-connected viewer sees the masked value as plain text, not a link.

- [ ] **Step 3: Revert the temporary schema edit**

```bash
git checkout -- examples/schemas/purple_dot/network.json
git status --short
```
Expected: `examples/` is clean.

- [ ] **Step 4: Push and open a draft PR**

Write the body to a file first, then pass it with `--body-file`:

```bash
git push -u origin feat/565-x-uri-link-fields
gh pr create --draft --base feature \
  --title "feat: x-uri field marker — clickable links in cards + URL validation" \
  --body-file /tmp/pr-565.md
```

The body must contain, in this order:

1. **Summary** — the `x-uri` marker; the single `URL_PATTERN` in `packages/schemas/src/uri_fields.ts`; link rendering on both card surfaces (`ItemCard`'s `FieldRow` and the public `/p/` page); validation enforced on both the client and the API.
2. **In Plain Terms** — required by `CLAUDE.md` for every PR: a short, jargon-free paragraph a non-expert teammate can follow.
3. **Scope note** — no `network.json` field is flagged in this pass (explicit product decision), so nothing changes in `bluedots-schemas` or `bluedots-automation`; the marker is documented in `CLAUDE.md`.
4. **Caution** — flagging a field that already holds non-URL data in live items will make updates to those items fail with `INVALID_ITEM_STATE`; audit the data first.
5. **Test evidence** — the actual pasted output of the Step 1 commands.
6. `Closes #565`.

Describe **what changed**, never "review fixes". Open as **draft**; the user marks it ready.

---

## Notes for the implementer

- **The `@dpg/schemas` barrel breaks the browser build.** If a UI file ever imports from `@dpg/schemas` (not `@dpg/schemas/uri_fields`), the Vite build fails on `pg`. Always use the deep alias in `apps/ui/`.
- **`examples/schemas/**/network.json` is the source of truth** for schemas, synced downstream to `bluedots-schemas` and `bluedots-automation/helm/signals/charts/api/files/networks/<dot>.json`. This plan touches none of them; if a future change does, all three must move together.
- **The orange-dot tourist "Website" button is unrelated.** It is hardcoded on the `website` field name in `apps/ui/src/tourist/practitioner-card.tsx:31`. Do not modify it. If `orange_dot.website` is later flagged `x-uri`, that card will show both a button and a link row — decide then.
