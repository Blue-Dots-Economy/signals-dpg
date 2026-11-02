import type { ErrorSchema } from '@rjsf/utils';

/**
 * Which fields may display a validation error yet. The form passes errors via
 * `extraErrors` instead of `liveValidate`, which would error every invalid
 * field at once; keeping untouched fields out means no renderer shows them.
 * RJSF still validates on submit.
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
 * Narrows an error schema to visited fields. Returns nothing once a submit
 * was attempted, since RJSF then renders every error itself and ours would
 * duplicate them. Root-level `__errors` are dropped, as no field owns them.
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
