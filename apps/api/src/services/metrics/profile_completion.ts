/**
 * Structural JSON Schema shape we need for profile completion scoring.
 *
 * Intentionally narrow + local (not pulling in `@types/json-schema`) — we
 * only ever read `properties` (key set) and `required` (which keys count
 * as weight 1.0). Everything else in a real JSON Schema is irrelevant
 * here.
 */
export interface JSONSchemaLike {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

const REQUIRED_WEIGHT = 1.0;
const OPTIONAL_WEIGHT = 0.5;

/**
 * Predicate shared by profile_completion_pct and actionable_tags' "missing_X"
 * derivation (Task 4). Returns true for any value we consider "the user
 * filled this in." Critically: boolean false and numeric 0 are POPULATED
 * (legitimate values); empty strings and empty arrays are NOT.
 */
export const is_populated = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

/**
 * Schema-driven profile completion percentage.
 *
 * Walks the JSON Schema's `properties`. Each property is weighted 1.0 if
 * it's listed in `required`, 0.5 otherwise. Earned weight / total weight ×
 * 100, rounded, capped at 100.
 *
 * Returns 0 for: missing/empty schema, missing/empty payload, schema with
 * no `properties` block.
 *
 * Only keys that appear in `schema.properties` are scored — extra keys in
 * the payload don't push completion past 100 and don't count for/against.
 */
export const profile_completion_pct = (
  payload: Record<string, unknown> | null | undefined,
  schema: JSONSchemaLike | null | undefined,
): number => {
  const props = schema?.properties;
  if (!props) return 0;

  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props);

  let earned = 0;
  let total = 0;
  for (const key of keys) {
    const weight = required.has(key) ? REQUIRED_WEIGHT : OPTIONAL_WEIGHT;
    total += weight;
    if (is_populated(payload?.[key])) earned += weight;
  }

  if (total === 0) return 0;
  return Math.min(100, Math.round((earned / total) * 100));
};
