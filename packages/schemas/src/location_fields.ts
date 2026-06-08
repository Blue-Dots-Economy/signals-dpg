/**
 * Marker-driven location-field selection for geocoding.
 *
 * A profile JSON-Schema property may carry a `location` keyword:
 *   - `"location": "primary"` — exactly one field; the autocomplete/geocode
 *     anchor that yields lat/lng and leads the composite query.
 *   - `"location": true`      — secondary address fields appended to the
 *     composite geocode query (fallback + backend paths).
 *
 * Shared by the UI (form + map) and the API (server-side geocode) so the
 * selection semantics never drift between client and server.
 */
export interface LocationFields {
  primary: string | null;
  secondary: string[];
}

type JsonSchemaProperty = { location?: unknown };

export function parseLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationFields {
  const result: LocationFields = { primary: null, secondary: [] };
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;

  for (const [name, prop] of Object.entries(properties)) {
    const marker = prop?.location;
    if (marker === 'primary') {
      // First primary wins; ignore accidental duplicates.
      if (result.primary === null) result.primary = name;
    } else if (marker === true) {
      result.secondary.push(name);
    }
  }

  return result;
}

/**
 * Builds a single geocode query string from the marked fields' values in
 * `data`: primary first, then secondaries in declaration order. Empty/missing
 * values are skipped. Returns null when there is no primary field or no usable
 * value.
 */
export function buildGeoQuery(
  data: Record<string, unknown>,
  fields: LocationFields
): string | null {
  if (!fields.primary) return null;

  const ordered = [fields.primary, ...fields.secondary];
  const parts = ordered
    .map((name) => data[name])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());

  return parts.length > 0 ? parts.join(', ') : null;
}
