/**
 * Readable copy for a failed AJV `pattern`, whose own message is the raw
 * regex. The regex comes from network.json, so the copy does too. Most
 * specific first:
 *
 *  1. The field's `x-error-message`, authored with the pattern.
 *  2. Built-in URL copy for an `x-uri` field.
 *  3. A generic naming the field ("Please enter a valid Mobile.").
 */

/** Per-field copy for a failed `pattern`, authored in network.json. */
export const FIELD_ERROR_MESSAGE_MARKER = 'x-error-message';

export interface FieldErrorMessages {
  /** Copy for an `x-uri` field. */
  uri: string;
  /** Copy for any other pattern, given the field's human label. */
  generic: (label: string) => string;
}

/** Only for `pattern` errors; other AJV keywords already read well. */
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
