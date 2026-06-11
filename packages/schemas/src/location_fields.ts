/**
 * Marker-driven location-field selection. Exactly ONE field per domain is the
 * geo field, marked:
 *   - "location": "single"   — a string field → one coordinate.
 *   - "location": "multiple" — an array-of-strings field → one coordinate per entry.
 * No granularity/level axis (autocomplete is unrestricted) and no secondary fields.
 * Shared by the UI (form + map) and the API (server-side geocode).
 */
export type LocationCardinality = 'single' | 'multiple';

export interface LocationFields {
  field: string | null;
  cardinality: LocationCardinality | null;
}

/** One coordinate. `label` is the place/city name when known. */
export interface LocationPoint {
  lat: number;
  lng: number;
  label?: string;
}

type JsonSchemaProperty = { location?: unknown; private?: unknown };

export function parseLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationFields {
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  for (const [name, prop] of Object.entries(properties)) {
    if (prop?.location === 'single') return { field: name, cardinality: 'single' };
    if (prop?.location === 'multiple') return { field: name, cardinality: 'multiple' };
  }
  return { field: null, cardinality: null };
}

/**
 * Returns true when the schema's location field carries `"private": true`.
 * Used by the page-level geocode fallback to suppress exact-coordinate storage
 * for private fields (PII requirement: private → coarse coordinate only).
 */
export function isLocationFieldPrivate(
  itemSchema: Record<string, unknown> | null | undefined
): boolean {
  const fields = parseLocationFields(itemSchema);
  if (!fields.field) return false;
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  return properties[fields.field]?.private === true;
}

/**
 * The geocode queries that produce the item's locations:
 *   - multiple → one {query,label} per non-empty array entry (label = the value).
 *   - single   → one {query} from the field's string value.
 *   - else     → [].
 * Pure; the caller geocodes each query.
 */
export function buildLocationQueries(
  data: Record<string, unknown>,
  fields: LocationFields
): Array<{ query: string; label?: string }> {
  if (!fields.field) return [];
  const raw = data[fields.field];
  if (fields.cardinality === 'multiple') {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => ({ query: v.trim(), label: v.trim() }));
  }
  return typeof raw === 'string' && raw.trim() ? [{ query: raw.trim() }] : [];
}
