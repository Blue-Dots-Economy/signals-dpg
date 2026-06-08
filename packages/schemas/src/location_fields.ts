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
 * `data`. Concatenates the values of the marked fields (primary first, then
 * secondaries in order), skipping empty/missing ones. A partial query — e.g.
 * secondaries only when the primary value is absent — is intentional and still
 * returned. Returns null only when no primary field is declared, or no marked
 * field has a usable value.
 */
export function buildGeoQuery(
  data: Record<string, unknown>,
  fields: LocationFields
): string | null {
  if (!fields.primary) return null;

  const ordered = [fields.primary, ...fields.secondary];
  const parts: string[] = [];
  for (const name of ordered) {
    const raw = data[name];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > 0) parts.push(trimmed);
    }
  }

  return parts.length > 0 ? parts.join(', ') : null;
}
