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
- **Memoize the pruned schema** (review finding #2). Recomputing
  `resolveVisibleSchema` into a *new object identity* every keystroke makes RJSF
  remount fields → text inputs lose focus / the cursor jumps mid-typing. Memoize so
  the pruned schema is referentially stable while the visible set is unchanged; key
  the recompute on **control-field values only** (typing a non-control field can't
  change visibility, so it must not re-prune).
- **Guarantee hidden data never submits** (review finding #3). `clearedFormData` is
  the primary mechanism; additionally set `omitExtraData` + `liveOmit` on `<Form>` so
  RJSF strips any value not in the pruned schema. The form test asserts the submit
  payload contains no hidden keys — a guarantee, not incidental.
- `onSubmit` already receives RJSF's formData (which, with the pruned schema + omit,
  won't contain hidden fields).
- **Strip `x-show-if`** in `normalizeSchemaForRjsf` (alongside `location`) so ajv
  never sees the custom keyword.
- **Edit mode:** because evaluation runs against the live formData (seeded from the
  loaded profile), the correct conditional fields appear when editing an existing
  item. If a loaded item's stored control value no longer matches, the orphaned
  hidden value is silently cleared on load (correct cleanup — see Edge cases).

### Data flow
`baseSchema` + `formData(state)` → `resolveVisibleSchema` → `{prunedSchema,
clearedFormData}` → RJSF `<Form>`; RJSF `onChange` → `setFormData` → re-evaluate.

## Schema-authoring invariant (review finding #1)

**An `x-show-if` field MUST NOT appear in the schema's unconditional top-level
`required[]`.** This design prunes hidden fields from `required` only in the
*client* schema. The server lifecycle classifier (#104) computes `required_complete`
over the flat server `required[]` and is `x-show-if`-unaware — so a conditional
field listed in `required[]` whose control takes the *other* branch stays empty and
strands the item in `draft` forever despite a validly completed form. Verified safe
today (no `x-show-if` field is in blue_dot seeker/provider `required[]`). To keep it
safe, the `example_network_configs` test fails if any conditional field is also
unconditionally required.

## Edge cases
- **Required + hidden:** hidden fields are removed from `required` in the client
  pruned schema (no phantom validation block). See the invariant above for the
  server side.
- **Chains:** handled by the fixpoint loop (clear-then-re-evaluate).
- **Array control fields:** intersection match (handles multi-select controls).
- **Unknown control field** (typo in schema) → treated as no-match → field hidden.
  Emit a dev-only `console.warn` (review finding #4) so an authoring typo doesn't
  silently hide a field with no signal.
- **Clear-on-hide data loss (UX, by design):** toggling a control by accident clears
  the dependent's entered value with no undo. Accepted per Decision 1; worth noting
  on long forms.
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
  block submit; the submit payload contains **no hidden keys** (finding #3).
- **Schema-config guard (`example_network_configs`):** fails if any `x-show-if`
  field also appears in a top-level `required[]` (finding #1 invariant).

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

## Design review (2026-06-16)

Reviewed against the codebase (`schema-form.tsx` / `normalizeSchemaForRjsf`, RJSF
ajv8 handling, the #129 finding that `x-show-if` is currently inert, and the #104
lifecycle classifier). **Verdict: approve to implement** — the model (pure
evaluator + fixpoint chains + controlled-form glue) is sound and well-reasoned.
Fold in the findings below.

**Strengths.** Pure evaluator / React-glue split keeps the tricky parts (chains,
AND, clearing, `required`-pruning) unit-testable. The fixpoint loop for chains is
correct and the running example shows exactly why a single pass orphans
grandchildren. Matching semantics (scalar membership, array→intersection,
missing→no-match, multi-key AND) and strip-before-ajv are the right calls.
Edit-mode-against-live-formData and out-of-scope bounding are handled.

1. **[Document the invariant — not a live bug today] Conditional-`required` vs the
   server lifecycle classifier (#104).** This design prunes hidden fields from
   `required` only in the *client* pruned schema. The server classifier computes
   `required_complete` over the flat server `required[]` and is `x-show-if`-unaware.
   Verified safe today: **no `x-show-if` field is in blue_dot's `required[]`**
   (seeker + provider — all conditional fields optional). But if a future schema
   author puts an `x-show-if` field into the top-level `required[]`, taking the
   *other* branch leaves it empty and the classifier strands those items in `draft`
   (never `live`) despite a validly completed form. **Action:** state the invariant
   ("`x-show-if` fields must not appear in the unconditional `required[]`") and
   ideally fail the `example_network_configs` test if a conditional field is also
   required.

2. **[Important — implementation pitfall] Controlled-form focus/identity
   stability.** Converting RJSF uncontrolled→controlled and "running
   `resolveVisibleSchema` on each render" risks text-input focus/cursor loss if the
   pruned schema is a new object identity every keystroke (RJSF can remount fields).
   **Memoize** so the pruned schema is referentially stable when the visible set is
   unchanged; ideally only recompute when a *control* field changes (typing a
   non-control field can't change visibility). Call this out in Component 2.

3. **[Moderate] Guard the submit against retained hidden data.** Passing
   `clearedFormData` is good; to be safe against RJSF retaining controlled extra
   data, set `omitExtraData` + `liveOmit` on `<Form>` (or assert in the form test
   that the submit payload contains no hidden keys). Make "hidden fields aren't
   submitted" guaranteed, not incidental.

4. **[Minor]** Decision 1 (clear-on-hide) loses entered data on accidental control
   toggling with no undo — fine/by-design, note the UX on long forms. Edit mode will
   also silently clear an orphaned value when loaded data's control no longer matches
   (correct cleanup, but a silent mutation). Add the optional dev `console.warn` for
   an unknown control field (a schema typo otherwise silently hides the field).
