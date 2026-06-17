# x-show-if Conditional Form Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inert `x-show-if` schema keyword functional so schema-driven forms show/hide fields live based on other fields' values.

**Architecture:** A pure evaluator (`apps/ui/src/lib/show-if.ts`) decides which top-level properties are visible for the current form data and returns a pruned schema (hidden props removed from `properties` and `required`) plus cleared form data, iterating to a fixpoint so chains cascade. `SchemaForm` becomes a controlled RJSF form that runs the evaluator on every change, memoizing the pruned schema by the hidden-set signature to avoid input remounts (focus loss), and sets `omitExtraData`/`liveOmit` so hidden values never submit. `normalizeSchemaForRjsf` strips the custom `x-show-if` keyword before the schema reaches ajv. A schema-config test enforces the authoring invariant that `x-show-if` fields are never unconditionally required.

**Tech Stack:** React 19, Vite, RJSF (`@rjsf/shadcn` + `@rjsf/validator-ajv8`), Vitest + happy-dom + @testing-library/react, TypeScript (ESM, strict, no `any`).

**Branch:** `feat/x-show-if-conditional-fields` (rebased onto `feature`).

**Spec:** `docs/superpowers/specs/2026-06-16-x-show-if-conditional-fields-design.md` (covers all 4 review findings — folded into the tasks below).

**Conventions to honor (from CLAUDE.md / AGENTS.md):** files are snake_case (the new file is `show-if.ts`); ESM only; strict TS, no `any`; no `console.log` (a guarded dev `console.warn` is intentional and allowed); after editing files run `codacy_cli_analyze` (skip complexity/coverage). Run the full UI suite with `pnpm --filter @dpg/ui test` (alias `pnpm --filter ui test`) and typecheck with `pnpm typecheck`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/ui/src/lib/show-if.ts` (create) | Pure evaluator: `isFieldVisible`, `collectControlFields`, `resolveVisibleSchema`. No React. |
| `apps/ui/src/lib/show-if.test.ts` (create) | Unit tests for the evaluator. |
| `apps/ui/src/components/forms/schema-form.tsx` (modify) | Controlled form: state + onChange, memoized pruned schema, `omitExtraData`/`liveOmit`; strip `x-show-if` in `normalizeSchemaForRjsf`. |
| `apps/ui/src/components/forms/schema-form.test.tsx` (create) | Form-level tests: visibility, clear-on-hide, no hidden keys in submit, focus stability. |
| `packages/schemas/src/__tests__/example_network_configs.test.ts` (modify) | Invariant guard: no `x-show-if` field in a top-level `required[]` (finding #1). |

---

## Task 1: Pure evaluator (`show-if.ts`)

**Files:**
- Create: `apps/ui/src/lib/show-if.ts`
- Test: `apps/ui/src/lib/show-if.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/ui/src/lib/show-if.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { isFieldVisible, collectControlFields, resolveVisibleSchema } from './show-if';

// A small schema mirroring the real blue_dot chain:
// educationCategory -> schoolQualification -> schoolQualificationOther
function chainSchema(): RJSFSchema {
  return {
    type: 'object',
    required: ['educationCategory'],
    properties: {
      educationCategory: { type: 'string', enum: ['School', 'College', 'None'] },
      schoolQualification: {
        type: 'string',
        enum: ['10th', '12th', 'Other'],
        'x-show-if': { educationCategory: ['School'] },
      },
      schoolQualificationOther: {
        type: 'string',
        'x-show-if': { schoolQualification: ['Other'] },
      },
      note: { type: 'string' },
    },
  } as RJSFSchema;
}

describe('isFieldVisible', () => {
  it('is always visible when there is no x-show-if', () => {
    expect(isFieldVisible({ type: 'string' }, {})).toBe(true);
  });

  it('matches a scalar control value in the allowed list', () => {
    const field = { 'x-show-if': { educationCategory: ['School'] } };
    expect(isFieldVisible(field, { educationCategory: 'School' })).toBe(true);
    expect(isFieldVisible(field, { educationCategory: 'College' })).toBe(false);
  });

  it('treats a missing/empty control value as no match', () => {
    const field = { 'x-show-if': { educationCategory: ['School'] } };
    expect(isFieldVisible(field, {})).toBe(false);
    expect(isFieldVisible(field, { educationCategory: '' })).toBe(false);
  });

  it('matches when a multi-select control intersects the allowed list', () => {
    const field = { 'x-show-if': { skills: ['welding'] } };
    expect(isFieldVisible(field, { skills: ['welding', 'plumbing'] })).toBe(true);
    expect(isFieldVisible(field, { skills: ['plumbing'] })).toBe(false);
    expect(isFieldVisible(field, { skills: [] })).toBe(false);
  });

  it('ANDs multiple control keys', () => {
    const field = { 'x-show-if': { a: ['x'], b: ['y'] } };
    expect(isFieldVisible(field, { a: 'x', b: 'y' })).toBe(true);
    expect(isFieldVisible(field, { a: 'x', b: 'z' })).toBe(false);
  });
});

describe('collectControlFields', () => {
  it('returns every control field referenced by any x-show-if', () => {
    const set = collectControlFields(chainSchema());
    expect([...set].sort()).toEqual(['educationCategory', 'schoolQualification']);
  });
});

describe('resolveVisibleSchema', () => {
  it('keeps all fields visible when controls match (no pruning)', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'School',
      schoolQualification: 'Other',
      schoolQualificationOther: 'Diploma',
    });
    expect(hidden).toEqual([]);
    expect(Object.keys(schema.properties ?? {})).toContain('schoolQualificationOther');
    expect(formData.schoolQualificationOther).toBe('Diploma');
  });

  it('hides a dependent and clears its value when the control does not match', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'College',
      schoolQualification: '10th',
    });
    expect(hidden).toContain('schoolQualification');
    expect(schema.properties).not.toHaveProperty('schoolQualification');
    expect(formData).not.toHaveProperty('schoolQualification');
  });

  it('cascades chains: hiding a control also hides and clears its grandchild', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'College', // hides schoolQualification ...
      schoolQualification: 'Other', // ... which was the control for the grandchild
      schoolQualificationOther: 'Diploma',
    });
    expect(hidden).toEqual(
      expect.arrayContaining(['schoolQualification', 'schoolQualificationOther']),
    );
    expect(formData).not.toHaveProperty('schoolQualificationOther');
    expect(schema.properties).not.toHaveProperty('schoolQualificationOther');
  });

  it('removes hidden fields from required', () => {
    const base = chainSchema();
    base.required = ['educationCategory', 'schoolQualification'];
    const { schema } = resolveVisibleSchema(base, { educationCategory: 'College' });
    expect(schema.required).toEqual(['educationCategory']);
  });

  it('does not mutate the input schema or formData', () => {
    const base = chainSchema();
    const input = { educationCategory: 'College', schoolQualification: '10th' };
    resolveVisibleSchema(base, input);
    expect(input).toHaveProperty('schoolQualification'); // input untouched
    expect(base.properties).toHaveProperty('schoolQualification');
  });

  it('warns in dev when an x-show-if references an unknown control field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        b: { type: 'string', 'x-show-if': { doesNotExist: ['x'] } },
      },
    } as RJSFSchema;
    resolveVisibleSchema(schema, {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('doesNotExist'));
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dpg/ui exec vitest run src/lib/show-if.test.ts`
Expected: FAIL — `Failed to resolve import "./show-if"` / functions not defined.

- [ ] **Step 3: Implement the evaluator**

Create `apps/ui/src/lib/show-if.ts`:

```ts
import type { RJSFSchema } from '@rjsf/utils';

/** The custom keyword: control field name → values that reveal the dependent field. */
type ShowIfMap = Record<string, unknown[]>;

interface FieldSchema {
  'x-show-if'?: ShowIfMap;
  [key: string]: unknown;
}

/**
 * True when a field's `x-show-if` is satisfied by the current formData.
 * AND across keys: every (controlField → allowed) entry must match.
 * A field without `x-show-if` is always visible.
 */
export function isFieldVisible(
  fieldSchema: FieldSchema,
  formData: Record<string, unknown>,
): boolean {
  const rule = fieldSchema['x-show-if'];
  if (!rule || typeof rule !== 'object') return true;
  return Object.entries(rule).every(([controlField, allowed]) => {
    if (!Array.isArray(allowed)) return false;
    const value = formData[controlField];
    if (Array.isArray(value)) {
      // multi-select control → visible if any selected value is allowed
      return value.some((v) => allowed.includes(v));
    }
    if (value === undefined || value === null || value === '') return false;
    return allowed.includes(value);
  });
}

/** Names of every top-level property referenced as a control by some x-show-if. */
export function collectControlFields(schema: RJSFSchema): Set<string> {
  const out = new Set<string>();
  const props = (schema.properties ?? {}) as Record<string, FieldSchema>;
  for (const prop of Object.values(props)) {
    const rule = prop?.['x-show-if'];
    if (rule && typeof rule === 'object') {
      for (const control of Object.keys(rule)) out.add(control);
    }
  }
  return out;
}

export interface ResolveResult {
  /** Schema with hidden properties removed from `properties` and `required`. */
  schema: RJSFSchema;
  /** formData with hidden fields' values cleared. */
  formData: Record<string, unknown>;
  /** Names of the hidden properties (sorted). */
  hidden: string[];
}

/**
 * Prune fields hidden by `x-show-if` from a schema (top-level `properties` +
 * `required`) and clear their values from formData. Chain-aware: iterates to a
 * fixpoint so hiding a control also hides (and clears) its dependents.
 *
 * Pure — never mutates its inputs. Scope is top-level properties (all current
 * `x-show-if` usage is top-level). Emits a dev-only `console.warn` when an
 * `x-show-if` references a control field that does not exist (authoring typo).
 */
export function resolveVisibleSchema(
  schema: RJSFSchema,
  formData: Record<string, unknown>,
): ResolveResult {
  const allProps = (schema.properties ?? {}) as Record<string, FieldSchema>;
  const propNames = Object.keys(allProps);

  if (import.meta.env?.DEV) {
    for (const [name, prop] of Object.entries(allProps)) {
      const rule = prop?.['x-show-if'];
      if (rule && typeof rule === 'object') {
        for (const control of Object.keys(rule)) {
          if (!(control in allProps)) {
            console.warn(
              `[x-show-if] field "${name}" references unknown control field "${control}"`,
            );
          }
        }
      }
    }
  }

  // Fixpoint. Clearing a value can only hide more fields (never reveal one), so
  // the hidden set grows monotonically and converges in at most propNames steps.
  let hidden = new Set<string>();
  let working: Record<string, unknown> = { ...formData };
  for (;;) {
    const next = new Set<string>();
    for (const name of propNames) {
      if (!isFieldVisible(allProps[name], working)) next.add(name);
    }
    const stable = next.size === hidden.size && [...next].every((n) => hidden.has(n));
    if (stable) break;
    hidden = next;
    working = { ...formData };
    for (const name of hidden) delete working[name];
  }

  const prunedProps: Record<string, unknown> = {};
  for (const name of propNames) {
    if (!hidden.has(name)) prunedProps[name] = allProps[name];
  }
  const prunedSchema: RJSFSchema = { ...schema, properties: prunedProps };
  if (Array.isArray(schema.required)) {
    prunedSchema.required = (schema.required as string[]).filter((r) => !hidden.has(r));
  }

  return { schema: prunedSchema, formData: working, hidden: [...hidden].sort() };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @dpg/ui exec vitest run src/lib/show-if.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Codacy analyze the new files**

Run `codacy_cli_analyze` on `apps/ui/src/lib/show-if.ts` and `apps/ui/src/lib/show-if.test.ts` (skip complexity/coverage). Fix anything flagged.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/show-if.ts apps/ui/src/lib/show-if.test.ts
git commit -m "feat(ui): pure x-show-if evaluator (resolveVisibleSchema)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Controlled form + strip keyword (`schema-form.tsx`)

**Files:**
- Modify: `apps/ui/src/components/forms/schema-form.tsx` (strip in `normalizeSchemaForRjsf` ~line 304-311; controlled body in `SchemaForm` ~line 328-379)
- Test: `apps/ui/src/components/forms/schema-form.test.tsx` (create)

- [ ] **Step 1: Write the failing form tests**

Create `apps/ui/src/components/forms/schema-form.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from './schema-form';

// educationCategory controls schoolQualification; `note` is always visible.
const schema: RJSFSchema = {
  type: 'object',
  required: ['educationCategory', 'schoolQualification'],
  properties: {
    educationCategory: { type: 'string', title: 'Education', enum: ['School', 'College'] },
    schoolQualification: {
      type: 'string',
      title: 'School Qualification',
      enum: ['10th', '12th'],
      'x-show-if': { educationCategory: ['School'] },
    },
    note: { type: 'string', title: 'Note' },
  },
};

describe('SchemaForm + x-show-if', () => {
  it('hides a conditional field when its control does not match', () => {
    render(
      <SchemaForm schema={schema} formData={{ educationCategory: 'College' }} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByText('School Qualification')).not.toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
  });

  it('shows a conditional field when its control matches', () => {
    render(
      <SchemaForm schema={schema} formData={{ educationCategory: 'School' }} onSubmit={vi.fn()} />,
    );
    expect(screen.getByText('School Qualification')).toBeInTheDocument();
  });

  it('does not submit a hidden field value (clear-on-hide guarantee)', async () => {
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ educationCategory: 'College', schoolQualification: '10th' }}
        onSubmit={onSubmit}
        submitButtonText="Save"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('schoolQualification');
    expect(payload).toMatchObject({ educationCategory: 'College' });
  });

  it('keeps focus while typing in a visible field (no remount)', async () => {
    render(
      <SchemaForm schema={schema} formData={{ educationCategory: 'School' }} onSubmit={vi.fn()} />,
    );
    const noteInput = screen.getByLabelText('Note') as HTMLInputElement;
    await userEvent.type(noteInput, 'hello');
    expect(noteInput).toHaveValue('hello');
    expect(document.activeElement).toBe(noteInput);
    // The conditional field stays visible — typing a non-control field must not re-prune.
    expect(screen.getByText('School Qualification')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dpg/ui exec vitest run src/components/forms/schema-form.test.tsx`
Expected: FAIL — the "hides a conditional field" test fails because the form currently renders all fields (x-show-if is inert).

- [ ] **Step 3: Strip `x-show-if` in `normalizeSchemaForRjsf`**

In `apps/ui/src/components/forms/schema-form.tsx`, the loop that strips the `location` marker (currently ~line 305-311) becomes:

```ts
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    // Strip the custom `location` MARKER (value "primary" | "secondary"), which is consumed
    // by generateUiSchema, not real JSON Schema. Must NOT strip a property whose
    // NAME is "location" (its value is the field's schema object, not a string).
    if (key === 'location' && (value === 'primary' || value === 'secondary')) continue;
    // Strip the custom `x-show-if` keyword — consumed by resolveVisibleSchema before
    // this point; ajv must never see it.
    if (key === 'x-show-if') continue;
    result[key] = normalizeSchemaForRjsf(value as RJSFSchema, root);
  }
```

- [ ] **Step 4: Make `SchemaForm` controlled with a memoized pruned schema**

Add the import near the top of `schema-form.tsx` (after the existing `@/theme/form-layouts` import):

```ts
import { resolveVisibleSchema } from '@/lib/show-if';
```

Replace the body of `SchemaForm` (currently ~line 328-379) with:

```tsx
export function SchemaForm({
  schema,
  formData,
  onSubmit,
  onError,
  mode = 'full',
  disabled = false,
  className,
  submitButtonText,
  id,
  hideSubmit = false,
  domainId,
  formContext,
}: SchemaFormProps) {
  // Base schema (meta stripped) still carries `x-show-if` so the evaluator can read it.
  const baseSchema = React.useMemo(() => stripMetaSchema(schema), [schema]);

  // Controlled form data. Seeded from the prop, with hidden values pre-cleared so
  // an edit-mode load whose stored control no longer matches starts clean.
  const [data, setData] = React.useState<Record<string, unknown>>(
    () => resolveVisibleSchema(baseSchema, formData ?? {}).formData,
  );

  // Re-seed when the incoming formData identity changes (edit mode loads async).
  // Parents pass a stable formData identity except on (re)load, so this does not
  // fire while the user is typing.
  React.useEffect(() => {
    setData(resolveVisibleSchema(baseSchema, formData ?? {}).formData);
  }, [baseSchema, formData]);

  const resolved = resolveVisibleSchema(baseSchema, data);
  // Signature of the visible set. The normalized schema + uiSchema are memoized on
  // this so their object identity is stable while the visible set is unchanged —
  // otherwise RJSF remounts fields and text inputs lose focus on every keystroke.
  const hiddenKey = resolved.hidden.join('|');

  const rjsfSchema = React.useMemo(
    () => normalizeSchemaForRjsf(resolved.schema),
    // resolved.schema depends only on (schema, visible set); key on hiddenKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, hiddenKey],
  );

  const uiSchema = React.useMemo(() => {
    const ui = generateUiSchema(resolved.schema, mode, hideSubmit ? undefined : submitButtonText);
    if (hideSubmit) ui['ui:submitButtonOptions'] = { norender: true };
    return ui;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, hiddenKey, mode, hideSubmit, submitButtonText]);

  const templates = domainId && formLayouts[domainId]
    ? { ObjectFieldTemplate: SectionedObjectFieldTemplate(domainId) }
    : undefined;

  const containerRef = React.useRef<HTMLDivElement>(null);

  return (
    <div className={className} ref={containerRef}>
      <Form
        id={id}
        schema={rjsfSchema}
        uiSchema={uiSchema}
        formData={data}
        validator={validator}
        widgets={widgets}
        templates={templates}
        disabled={disabled}
        formContext={formContext}
        onChange={({ formData: next }) => {
          setData(resolveVisibleSchema(baseSchema, (next ?? {}) as Record<string, unknown>).formData);
        }}
        onSubmit={({ formData: submitted }) => {
          if (submitted) onSubmit(submitted as Record<string, unknown>);
        }}
        onError={(errors) => onError?.(errors)}
        focusOnFirstError={(error) =>
          focusErrorField(containerRef.current, error as RjsfError)
        }
        showErrorList={false}
        liveValidate={false}
        noHtml5Validate
        omitExtraData
        liveOmit
      />
    </div>
  );
}
```

Notes for the implementer:
- `omitExtraData` + `liveOmit` make RJSF drop any formData key not present in the (pruned) schema — the belt-and-suspenders guarantee that hidden values never validate or submit (finding #3).
- The `onChange` re-runs `resolveVisibleSchema` so a control flip clears its dependents immediately (finding: clear-on-hide).
- The memoization keys on `hiddenKey` (the visible set), not on `data`, so typing in a visible non-control field reuses the same schema/uiSchema objects and does not remount inputs (finding #2).

- [ ] **Step 5: Run the form tests to verify they pass**

Run: `pnpm --filter @dpg/ui exec vitest run src/components/forms/schema-form.test.tsx`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Run the full UI suite + typecheck (no regressions)**

Run: `pnpm --filter @dpg/ui test`
Expected: PASS (existing suite + the new tests).
Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 7: Codacy analyze**

Run `codacy_cli_analyze` on `apps/ui/src/components/forms/schema-form.tsx` and `apps/ui/src/components/forms/schema-form.test.tsx` (skip complexity/coverage). Fix anything flagged.

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/components/forms/schema-form.tsx apps/ui/src/components/forms/schema-form.test.tsx
git commit -m "feat(ui): make x-show-if functional in schema-driven forms

Controlled RJSF form runs resolveVisibleSchema on each change; pruned schema
memoized by hidden-set signature (no focus loss); omitExtraData+liveOmit so
hidden values never submit; strip x-show-if before ajv.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Schema-authoring invariant guard (finding #1)

**Files:**
- Modify: `packages/schemas/src/__tests__/example_network_configs.test.ts`

Context: This design prunes hidden fields from `required` only in the *client* schema. The server lifecycle classifier (#104) computes `required_complete` over the flat server `required[]` and is `x-show-if`-unaware, so a conditional field listed in a top-level `required[]` would strand items in `draft` forever when the other branch is taken. This test makes that authoring mistake fail CI. The item schema lives at `doc.domains[].item_schemas['profile_1.0']` with top-level `properties` and `required`.

- [ ] **Step 1: Write the failing test**

Append to `packages/schemas/src/__tests__/example_network_configs.test.ts` (after the existing `describe('example network configs declare a location field', ...)` block):

```ts
describe('x-show-if fields are never unconditionally required', () => {
  // Server lifecycle classifier (#104) is x-show-if-unaware: a conditional field
  // in a top-level required[] would strand items in draft when the other branch
  // is taken. Guard the invariant across every example network's item schemas.
  const configs = [
    ['orange_dot', 'examples/schemas/orange_dot/network.json'],
    ['purple_dot', 'examples/schemas/purple_dot/network.json'],
    ['yellow_dot', 'examples/schemas/yellow_dot/network.json'],
    ['blue_dot', 'examples/schemas/blue_dot/network.json'],
  ] as const;

  it.each(configs)('%s has no x-show-if field in any required[]', (_network, relPath) => {
    const abs = resolve(__dirname, '../../../..', relPath);
    const doc = JSON.parse(readFileSync(abs, 'utf8')) as {
      domains: Array<{
        id: string;
        item_schemas?: Record<
          string,
          { properties?: Record<string, { 'x-show-if'?: unknown }>; required?: string[] }
        >;
      }>;
    };

    const violations: string[] = [];
    for (const domain of doc.domains ?? []) {
      for (const [itemType, itemSchema] of Object.entries(domain.item_schemas ?? {})) {
        const props = itemSchema.properties ?? {};
        const required = itemSchema.required ?? [];
        for (const field of required) {
          if (props[field]?.['x-show-if'] !== undefined) {
            violations.push(`${domain.id}/${itemType}.${field}`);
          }
        }
      }
    }

    expect(
      violations,
      `x-show-if fields must not be unconditionally required:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (invariant already holds)**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/example_network_configs.test.ts`
Expected: PASS — no example schema currently lists an `x-show-if` field in `required[]` (verified: blue_dot seeker `required` = name/gender/location/age/phone; provider = jobProviderName/role/…). This is a guard, so green-on-first-run is correct.

- [ ] **Step 3: Prove the guard actually fails on a violation (temporary check)**

Temporarily add `"schoolQualification"` to the blue_dot seeker `required[]` array (around line 21-27 of `examples/schemas/blue_dot/network.json`), re-run the test, and confirm it FAILS with `blue_dot/profile_1.0.schoolQualification` in the message. Then revert the edit and re-run to confirm PASS. (Do not commit the temporary edit.)

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/example_network_configs.test.ts`
Expected: FAIL (with the violation), then PASS after revert.

- [ ] **Step 4: Codacy analyze**

Run `codacy_cli_analyze` on `packages/schemas/src/__tests__/example_network_configs.test.ts` (skip complexity/coverage). Fix anything flagged.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/__tests__/example_network_configs.test.ts
git commit -m "test(schemas): guard that x-show-if fields are never unconditionally required

Server lifecycle classifier is x-show-if-unaware; a conditional field in a
top-level required[] would strand items in draft. Fail CI on that mistake.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Run the full UI suite: `pnpm --filter @dpg/ui test` — expected PASS.
- [ ] Run the schemas suite: `pnpm --filter @dpg/schemas test` — expected PASS.
- [ ] Typecheck everything: `pnpm typecheck` — expected 0 errors.
- [ ] Manual QA against blue_dot seeker profile create (run-signals-dpg skill): selecting `educationCategory = School` reveals `schoolQualification`; choosing `Other` reveals `schoolQualificationOther`; switching back to `College` hides both and their values are not submitted; editing an existing profile shows the correct conditional fields.

---

## Self-review (plan vs. spec)

**Spec coverage:**
- Goal (make x-show-if functional) → Tasks 1 + 2.
- Component 1 (pure evaluator, matching rule, fixpoint, prune + clear + required-pruning) → Task 1.
- Component 2 (controlled form, onChange, strip in normalize, edit mode) → Task 2.
- Decision 1 (clear-on-hide + drop from required) → Task 1 (required) + Task 2 (onChange clear) + Task 2 test (no hidden submit).
- Decision 2 (all schema-driven forms) → Task 2 changes `SchemaForm`, used by both profile-form-page and action-modal; no per-call opt-in.
- Decision 3 (AND across keys) → Task 1 `isFieldVisible` + test.
- Finding #1 (required invariant + config guard) → Task 3.
- Finding #2 (memoize / focus stability) → Task 2 Step 4 + focus test.
- Finding #3 (omitExtraData + liveOmit + no-hidden-keys assertion) → Task 2 Step 4 + submit test.
- Finding #4 (dev console.warn on unknown control field; clear-on-hide UX note) → Task 1 (warn + test). UX data-loss is by-design per Decision 1, no code.
- Edge cases (array control intersection, missing control, nested out-of-scope) → Task 1 tests; nested explicitly out of scope (top-level only).

**Type consistency:** `resolveVisibleSchema` returns `{ schema, formData, hidden }` everywhere; `isFieldVisible(fieldSchema, formData)` and `collectControlFields(schema)` signatures match between `show-if.ts`, its test, and the `schema-form.tsx` usage. `hidden` is `string[]` (sorted); `hiddenKey` joins it.

**Placeholder scan:** none — every code/test step contains complete code and exact commands.
