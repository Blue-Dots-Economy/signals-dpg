import type { ErrorSchema } from '@rjsf/utils';

/**
 * Which fields are allowed to display a validation error yet.
 *
 * The form feeds RJSF its errors through `extraErrors` rather than turning on
 * `liveValidate`, and this module decides what goes in. That distinction is the
 * whole point: `liveValidate` hands an error to EVERY invalid field, and the
 * theme's own input/select templates redden their borders straight off
 * `rawErrors` — so a pristine form lit up the moment anything was typed. Keeping
 * an untouched field out of `extraErrors` means it never receives an error at
 * all, so every renderer (our field template, the theme's templates, and the
 * custom widgets that draw their own error text) stays quiet without each one
 * needing to know about this rule.
 *
 * RJSF still validates natively on submit, so filtering display errors here
 * cannot let invalid data through.
 */

/** RJSF field ids look like "root_website" / "root_reference_links_0". */
const ID_PREFIX = 'root_';

/**
 * True when the user has visited `property` — either the field itself, or any
 * child of it, so a bad array entry still marks the group it sits in.
 */
export function isFieldVisited(property: string, touchedFieldIds: ReadonlySet<string>): boolean {
  const fieldId = `${ID_PREFIX}${property}`;
  if (touchedFieldIds.has(fieldId)) return true;
  const childPrefix = `${fieldId}_`;
  for (const touchedId of touchedFieldIds) {
    if (touchedId.startsWith(childPrefix)) return true;
  }
  return false;
}

/**
 * Narrow a full error schema to the fields the user has actually visited.
 *
 * Returns nothing at all once a submit has been attempted: from that point RJSF
 * has validated natively and renders every field's error itself, so supplying
 * ours as well would print each message twice.
 *
 * Root-level `__errors` are dropped: they are not attributable to a field the
 * user could have visited, and showing them would reintroduce the "pristine form
 * shouts at you" problem this exists to prevent.
 */
export function filterErrorSchemaToVisited(
  errorSchema: ErrorSchema,
  touchedFieldIds: ReadonlySet<string>,
  submitAttempted: boolean,
): ErrorSchema {
  if (submitAttempted) return {} as ErrorSchema;
  const filtered: Record<string, unknown> = {};
  for (const [property, subSchema] of Object.entries(errorSchema)) {
    if (property === '__errors') continue;
    if (isFieldVisited(property, touchedFieldIds)) filtered[property] = subSchema;
  }
  return filtered as ErrorSchema;
}
