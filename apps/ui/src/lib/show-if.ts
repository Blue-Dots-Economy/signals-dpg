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
