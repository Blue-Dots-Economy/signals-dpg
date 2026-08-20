/**
 * When a field's validation error is allowed to be SHOWN.
 *
 * SchemaForm runs `liveValidate`, so AJV errors exist for every empty required
 * field from the first render. Painting those immediately would turn a pristine
 * form red, so an error surfaces only once the user has visited the field (blur)
 * or has tried to submit. After that it updates live, clearing as soon as the
 * value becomes valid.
 *
 * This lives in its own module rather than in schema-form.tsx because the custom
 * widgets render their own error text and need the same gate — and schema-form
 * imports those widgets, so importing back would be circular.
 */

/** formContext keys SchemaForm populates for the gate. */
export const TOUCHED_FIELDS_KEY = '__touchedFieldIds';
export const SUBMIT_ATTEMPTED_KEY = '__submitAttempted';

/**
 * `id` is the RJSF field id ("root_website"). A container (object/array) counts
 * as visited when any of its children is, so a bad array entry still reddens the
 * group it sits in. With no gate in the formContext — a caller rendering these
 * widgets outside SchemaForm — errors show as they always did.
 */
export function shouldShowFieldErrors(id: string, formContext: unknown): boolean {
  const ctx = (formContext ?? {}) as Record<string, unknown>;
  if (ctx[SUBMIT_ATTEMPTED_KEY] === true) return true;
  const touched = ctx[TOUCHED_FIELDS_KEY];
  if (!(touched instanceof Set)) return true;
  if (touched.has(id)) return true;
  const childPrefix = `${id}_`;
  for (const touchedId of touched) {
    if (typeof touchedId === 'string' && touchedId.startsWith(childPrefix)) return true;
  }
  return false;
}
