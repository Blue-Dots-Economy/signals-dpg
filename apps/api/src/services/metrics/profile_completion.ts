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
 * Schema-driven profile completion percentage — **required-only**.
 *
 * Mirrors the lifecycle classifier (`classify_item`): only fields listed in
 * `schema.required` count. `filled_required / total_required × 100`, rounded.
 * Optional fields contribute nothing. A schema with no required fields is
 * vacuously complete → 100.
 *
 * (Previously a weighted formula — required ×1.0 + optional ×0.5. Unified to
 * required-only so there is a single completion notion across the system.)
 */
export const profile_completion_pct = (
  payload: Record<string, unknown> | null | undefined,
  schema: JSONSchemaLike | null | undefined,
): number => {
  const required = schema?.required ?? [];
  if (required.length === 0) return 100;

  const state = payload ?? {};
  const filled = required.filter((key) => is_populated(state[key]));
  return Math.round((filled.length / required.length) * 100);
};
