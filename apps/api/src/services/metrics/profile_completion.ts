/** The narrow JSON Schema shape profile completion and the go-live gates read. */
export interface JSONSchemaLike {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * Whether the user filled a value in. Boolean false and numeric 0 count as
 * populated; blank strings and empty arrays do not.
 */
export const is_populated = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

/**
 * Profile completion percentage over `schema.required` fields only, rounded,
 * so there is one completion notion across the system. A schema with no
 * required fields is 100.
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
