/**
 * Turning AJV's `pattern` complaint into something a person can act on.
 *
 * The regex lives in `network.json`, so the copy has to come from there too — a
 * lookup table of known patterns in this repo would be wrong the moment a
 * network adds a field we have never seen. AJV's own message is the raw regex
 * ("must match pattern \"^\\s*$|^\\s*([hH][tT]...\""), which tells the user
 * nothing, so it must never reach them.
 *
 * Three layers, most specific first:
 *
 *  1. `x-error-message` on the field — the schema author's own copy, for any
 *     pattern in any network. This is the escape hatch for a rule only the
 *     author can explain ("Enter a 10-digit mobile number, no spaces").
 *  2. `x-uri` on the field — the marker already implies the rule, so the URL
 *     copy is built in and authors get it for free.
 *  3. A readable generic naming the field ("Please enter a valid Mobile."), so a
 *     network that declares a bare `pattern` and no copy still says something
 *     useful instead of showing a regex.
 */

/** Per-field copy for a failed `pattern`, authored in network.json. */
export const FIELD_ERROR_MESSAGE_MARKER = 'x-error-message';

export interface FieldErrorMessages {
  /** Copy for an `x-uri` field. */
  uri: string;
  /** Copy for any other pattern, given the field's human label. */
  generic: (label: string) => string;
}

/**
 * Resolve the message for a failed `pattern` on `propertySchema`. Callers apply
 * this only to `pattern` errors — every other AJV keyword already produces
 * readable text ("must have required property 'Name'").
 */
export function resolvePatternErrorMessage(
  propertySchema: Record<string, unknown> | undefined,
  isUriField: boolean,
  messages: FieldErrorMessages,
): string {
  const authored = propertySchema?.[FIELD_ERROR_MESSAGE_MARKER];
  if (typeof authored === 'string' && authored.trim().length > 0) return authored;
  if (isUriField) return messages.uri;
  const title = propertySchema?.title;
  const label = typeof title === 'string' && title.trim().length > 0 ? title : 'value';
  return messages.generic(label);
}
