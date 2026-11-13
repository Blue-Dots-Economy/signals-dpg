import { isFieldVisible } from '@/lib/show-if';

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

/**
 * Form-standard sentences: missing → "required"; wrong → "Invalid entry" with the reason.
 */
export interface FieldErrorCopy {
  required: (label: string) => string;
  invalid: (message: string) => string;
  /** "Please enter a valid {label}." for keywords whose AJV text is developer-facing. */
  validValue: (label: string) => string;
  /** Readable copy for a length/range/choice rule; without it, `validValue` is used. */
  rule?: (kind: RuleKind, label: string, limit: string) => string;
}

export type RuleKind =
  | 'minLength'
  | 'maxLength'
  | 'minimum'
  | 'maximum'
  | 'exclusiveMinimum'
  | 'exclusiveMaximum'
  | 'minItems'
  | 'maxItems'
  | 'enum';

const RULE_KINDS: ReadonlySet<string> = new Set<RuleKind>([
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'enum',
]);

/** The subset of an RJSF error this module reads. */
export interface FieldErrorInput {
  name?: string;
  property?: string;
  message?: string;
  params?: Record<string, unknown>;
}

/** Walks `schema` along dot-path segments; numeric segments step into `items`. */
export function schemaNodeAt(schema: unknown, segments: string[]): Record<string, unknown> | undefined {
  let node: unknown = schema;
  for (const seg of segments) {
    if (!node || typeof node !== 'object') return undefined;
    const n = node as Record<string, unknown>;
    const props = n.properties as Record<string, unknown> | undefined;
    if (/^\d+$/.test(seg) && n.items) node = n.items;
    else if (props?.[seg]) node = props[seg];
    else return undefined;
  }
  return node as Record<string, unknown> | undefined;
}

/** True when the error means "nothing entered" rather than "entered wrongly". */
export function isMissingValueError(e: FieldErrorInput): boolean {
  return e.name === 'required' || (e.name === 'minLength' && e.params?.limit === 1);
}

/**
 * Message under a field: "{title} is required." or "Invalid entry. …".
 */
export function formStandardMessage(
  error: FieldErrorInput,
  schema: unknown,
  copy: FieldErrorCopy,
  patternMessage: (topField: string) => string,
): string {
  const segments = (error.property ?? '').replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  const missingKey = error.params?.missingProperty;
  if (error.name === 'required' && typeof missingKey === 'string' && segments.at(-1) !== missingKey) {
    segments.push(missingKey);
  }
  const node = schemaNodeAt(schema, segments);
  const label = labelOf(schema, node, segments);

  if (isMissingValueError(error)) return copy.required(label);
  let detail: string;
  if (error.name === 'pattern') {
    detail = patternMessage(segments[0] ?? '');
  } else if (error.name && RULE_KINDS.has(error.name) && copy.rule) {
    const limit = error.params?.limit ?? error.params?.comparison;
    detail = copy.rule(error.name as RuleKind, label, typeof limit === 'number' || typeof limit === 'string' ? String(limit) : '');
  } else {
    detail = copy.validValue(label);
  }
  return copy.invalid(withStop(detail));
}

function labelOf(schema: unknown, node: Record<string, unknown> | undefined, segments: string[]): string {
  const title = node?.title;
  if (typeof title === 'string' && title.trim()) return title;
  // An array item has no title of its own; name the list it belongs to.
  if (segments.length > 1 && /^\d+$/.test(segments.at(-1) ?? '')) {
    return labelOf(schema, schemaNodeAt(schema, segments.slice(0, -1)), segments.slice(0, -1));
  }
  return segments.at(-1) ?? 'value';
}


function withStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Server (AJV) wording for limit failures, mapped to the form's rule copy. */
const SERVER_LIMIT_RULES: ReadonlyArray<readonly [RegExp, RuleKind]> = [
  [/^must NOT have fewer than (\d+) characters/, 'minLength'],
  [/^must NOT have more than (\d+) characters/, 'maxLength'],
  [/^must NOT have fewer than (\d+) items/, 'minItems'],
  [/^must NOT have more than (\d+) items/, 'maxItems'],
  // Ajv writes ">=" / "<=" for inclusive bounds and ">" / "<" for exclusive ones.
  [/^must be >= ?(\S+)/, 'minimum'],
  [/^must be <= ?(\S+)/, 'maximum'],
  [/^must be > ?(\S+)/, 'exclusiveMinimum'],
  [/^must be < ?(\S+)/, 'exclusiveMaximum'],
];

const NOT_ALLOWED_FIELD = 'is not an allowed field';

/** The API's per-field message in the form's wording; null when the user can't fix it in the form. */
export function serverFieldMessage(
  path: string,
  message: string,
  schema: unknown,
  copy: FieldErrorCopy,
): string | null {
  const segments = path.split('.').filter(Boolean);
  const node = schemaNodeAt(schema, segments);
  const label = labelOf(schema, node, segments);
  const m = message.trim();
  if (m === 'is required') return copy.required(label);
  if (m === NOT_ALLOWED_FIELD) return null;
  const rule = (kind: RuleKind, limit: string) =>
    copy.invalid(withStop(copy.rule ? copy.rule(kind, label, limit) : copy.validValue(label)));
  for (const [pattern, kind] of SERVER_LIMIT_RULES) {
    const found = pattern.exec(m);
    if (found) return rule(kind, found[1]!);
  }
  if (m.startsWith('must be one of')) return rule('enum', '');
  // Remaining `must …` text is a type/format failure; anything else is the
  // field's authored pattern copy, already a sentence.
  const detail = m.startsWith('must') ? copy.validValue(label) : m;
  return copy.invalid(withStop(detail));
}

/**
 * Splits the API's per-field messages into those a field on the form can show
 * (`onForm`) and the paths the form has no visible field for (`offForm`).
 */
export function splitServerFieldErrors(
  fields: Record<string, string>,
  schema: unknown,
  data: Record<string, unknown>,
): { onForm: Record<string, string>; offForm: string[] } {
  const onForm: Record<string, string> = {};
  const offForm: string[] = [];
  for (const [path, message] of Object.entries(fields)) {
    const segments = path.split('.').filter(Boolean);
    const top = segments[0] ? schemaNodeAt(schema, [segments[0]]) : undefined;
    const shown =
      message.trim() !== NOT_ALLOWED_FIELD &&
      top !== undefined &&
      isFieldVisible(top, data) &&
      schemaNodeAt(schema, segments) !== undefined;
    if (shown) onForm[path] = message;
    else offForm.push(path);
  }
  return { onForm, offForm };
}
