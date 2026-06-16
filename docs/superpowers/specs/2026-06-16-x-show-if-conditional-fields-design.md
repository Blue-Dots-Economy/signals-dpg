# `x-show-if` — conditional form fields — Design

**Date:** 2026-06-16
**Branch:** `feat/x-show-if-conditional-fields` (from `feature`; rebase onto `feature` after PR #178 merges)
**Status:** Approved design — implementation to follow

## Goal

Make the `x-show-if` schema keyword **functional**: in schema-driven forms, show or
hide a field based on the current value(s) of other field(s), live as the user
fills the form. Today the keyword is present in `network.json` item schemas (e.g.
blue_dot) but is **inert** — no code reads it.

## Background — current state

- **Schema syntax** (in `examples/schemas/blue_dot/network.json`):
  ```json
  "schoolQualification": {
    "type": "string",
    "enum": ["..."],
    "x-show-if": { "educationCategory": ["School"] }
  }
  ```
  `x-show-if` maps **control field → allowed values**: the field is shown only when
  the control field's current value is one of the listed values.
- **Chains exist.** e.g. `schoolQualificationOther` ← `schoolQualification` ←
  `educationCategory`; `minQualificationSchoolOther` ← `minQualificationSchool` ←
  `minEducationalInstitute`. Hiding a control must cascade to its dependents.
- **It is inert.** `grep` finds zero references to `x-show-if` in `apps/ui/src`.
- **The form** (`apps/ui/src/components/forms/schema-form.tsx`, RJSF `@rjsf/shadcn`
  + `validator-ajv8`) passes the schema **statically** and only handles `onSubmit`
  — there is **no `onChange`**, so no live form state to react to today.
  `normalizeSchemaForRjsf` already strips custom markers (e.g. `location`).

## Decisions (locked)

1. **Clear hidden field values.** When a field hides (its control changed), its
   value is dropped — never submitted — and it is removed from `required` so a
   hidden required field can't block submit. (Toggling the control back leaves the
   field empty.)
2. **Applies to all schema-driven forms.** It's a general `schema-form` capability
   (profile create/edit **and** action / requirement-schema forms). Schemas without
   `x-show-if` are unaffected.
3. **Multiple control keys ⇒ AND.** A field with several keys in `x-show-if` shows
   only when **every** control field's value is in its allowed set. (All current
   schemas use a single key; this defines the general case.)

## Design

Two pieces: **Component 1** is pure logic that decides *what* should be visible
given the current answers; **Component 2** is the React glue that calls it *live*
as the user types. Keeping the logic pure means the tricky parts (chains, AND,
clearing, `required`-pruning) are testable without rendering anything.

**Running example** (a real blue_dot chain):
```json
"educationCategory":        { "enum": ["School", "College", "None"] },
"schoolQualification":      { "enum": ["10th", "12th"], "x-show-if": { "educationCategory": ["School"] } },
"schoolQualificationOther": { "type": "string",         "x-show-if": { "schoolQualification": ["12th"] } }
```
`schoolQualification` shows only when `educationCategory === "School"`;
`schoolQualificationOther` shows only when `schoolQualification === "12th"`.

### Component 1 — pure evaluator (`apps/ui/src/lib/show-if.ts`, new)

```ts
/** True when `field` (its x-show-if) is satisfied by the current formData. */
export function isFieldVisible(
  fieldSchema: Record<string, unknown>,
  formData: Record<string, unknown>,
): boolean;

/**
 * Given a JSON Schema (object with `properties`) and current formData, returns
 * the schema with hidden properties removed (and removed from `required`), and
 * the formData with hidden fields' values cleared. Chain-aware: iterates to a
 * fixpoint so hiding a control also hides (and clears) its dependents.
 */
export function resolveVisibleSchema(
  schema: RJSFSchema,
  formData: Record<string, unknown>,
): { schema: RJSFSchema; formData: Record<string, unknown>; hidden: string[] };
```

**Matching rule** (`isFieldVisible`): for each `(controlField → allowed)` entry in
the field's `x-show-if`:
- control value is a **scalar** → match when `allowed.includes(value)`.
- control value is an **array** (multi-select) → match when it **intersects**
  `allowed`.
- control value missing/empty → no match.
A field is visible when **all** entries match (AND). A field without `x-show-if` is
always visible.

**`resolveVisibleSchema`** (chain-aware, top-level properties):
1. Start from `formData`.
2. Compute the hidden set = properties whose `isFieldVisible` is false against the
   current (working) formData.
3. Clear hidden fields from the working formData.
4. Repeat 2–3 until the hidden set is stable (fixpoint) — this cascades chains
   (clearing `educationCategory`'s dependent clears the grandchild, etc.).
5. Return: schema with hidden properties deleted from `properties` and filtered out
   of `required`; the cleared formData; and the hidden list.

The loop (not a single pass) is what makes **chains** work. If the user changes
`educationCategory` from `"School"` back to `"College"`:
- pass 1 hides + clears `schoolQualification` (its control no longer matches);
- pass 2 re-evaluates and now `schoolQualificationOther` has no control, so it hides
  + clears too;
- pass 3 finds nothing new → stop.

A single pass would have left the grandchild (`schoolQualificationOther`) behind.

Pure and synchronous — unit-tested in isolation.

### Component 2 — controlled form (`schema-form.tsx`)

A pure evaluator only helps if something re-runs it on every keystroke. Today the
form is **uncontrolled** — it hands RJSF the schema once and only listens for the
final `onSubmit`, so it never sees intermediate edits and can't react. Component 2
makes the form **controlled** so Component 1 runs on each change:

- Track `formData` in component state, seeded from the `formData` prop; wire RJSF's
  **`onChange`** to update it (today only `onSubmit` is handled).
- On each render, run `resolveVisibleSchema(baseSchema, formData)` and pass the
  **pruned schema** + **cleared formData** to `<Form>`. Hidden fields don't render,
  don't validate, and aren't submitted.
- `onSubmit` already receives RJSF's formData (which, with the pruned schema, won't
  contain hidden fields).
- **Strip `x-show-if`** in `normalizeSchemaForRjsf` (alongside `location`) so ajv
  never sees the custom keyword.
- **Edit mode:** because evaluation runs against the live formData (seeded from the
  loaded profile), the correct conditional fields appear when editing an existing
  item.

### Data flow
`baseSchema` + `formData(state)` → `resolveVisibleSchema` → `{prunedSchema,
clearedFormData}` → RJSF `<Form>`; RJSF `onChange` → `setFormData` → re-evaluate.

## Edge cases
- **Required + hidden:** hidden fields are removed from `required` (no phantom
  validation block).
- **Chains:** handled by the fixpoint loop (clear-then-re-evaluate).
- **Array control fields:** intersection match (handles multi-select controls).
- **Unknown control field** (typo in schema) → treated as no-match → field hidden;
  acceptable (authoring error surfaces as a missing field). Could optionally
  `console.warn` in dev.
- **Nested objects/arrays:** v1 scopes evaluation to **top-level** properties (all
  current `x-show-if` usage is top-level). Nested support is out of scope unless a
  schema needs it.

## Testing
- **Unit (`show-if.test.ts`):** `isFieldVisible` (scalar in/out of allowed, array
  intersection, missing control, multi-key AND, no `x-show-if` → visible);
  `resolveVisibleSchema` (hides + clears value, removes from `required`, chain
  cascade clears grandchildren, schema without `x-show-if` unchanged).
- **Form test:** rendering a schema with `x-show-if`, changing a control field
  shows/hides the dependent and clears its value; a hidden required field does not
  block submit.

## Out of scope
- Backend / schema changes (the keyword already exists in `network.json`).
- Nested (non-top-level) `x-show-if`.
- `x-show-if` operators beyond value-membership (e.g. ranges, "not", regex).
- Server-side enforcement (this is form-UX only; the server validates the submitted
  payload against the schema as today).

## Notes
- Independent of the per-domain UI split (PR #178) — different files
  (`schema-form.tsx` is identical on `feature` and the per-domain branch), so this
  branch rebases cleanly onto `feature` once #178 merges.
