/**
 * Marker-driven location-field selection.
 *
 *   "location": "primary"   — the ONE field per domain that is geocoded,
 *                             stored as item_locations, and shown on the map.
 *                             Also gets form autocomplete.
 *   "location": "secondary" — a field that gets form autocomplete ONLY; never
 *                             geocoded, stored, or mapped. Zero or more per domain.
 *
 * Cardinality (one coordinate vs many) is derived from the field's JSON Schema
 * `type`: `array` -> multiple, otherwise single. Shared by the UI (form + map)
 * and the API (server-side geocode).
 */
export type LocationCardinality = 'single' | 'multiple';
export type LocationRole = 'primary' | 'secondary';

export interface LocationField {
  field: string;
  cardinality: LocationCardinality;
}

export interface LocationFields {
  /** The geo field (geocode + map). Null when no field is marked primary. */
  primary: LocationField | null;
  /** Autocomplete-only fields. */
  secondary: LocationField[];
}

/** One coordinate. `label` is the place/city name when known. */
export interface LocationPoint {
  lat: number;
  lng: number;
  label?: string;
}

type JsonSchemaProperty = { location?: unknown; private?: unknown; type?: unknown };

function cardinalityOf(prop: JsonSchemaProperty): LocationCardinality {
  return prop?.type === 'array' ? 'multiple' : 'single';
}

export function parseLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationFields {
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  let primary: LocationField | null = null;
  const secondary: LocationField[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (prop?.location === 'primary') {
      // Validation guarantees at most one; first wins defensively.
      primary ??= { field: name, cardinality: cardinalityOf(prop) };
    } else if (prop?.location === 'secondary') {
      secondary.push({ field: name, cardinality: cardinalityOf(prop) });
    }
  }
  return { primary, secondary };
}

/** Primary + secondary fields (primary first) — the fields that get autocomplete. */
export function getAutocompleteLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationField[] {
  const { primary, secondary } = parseLocationFields(itemSchema);
  return primary ? [primary, ...secondary] : secondary;
}

/**
 * True when the primary location field carries `"private": true`. Used by the
 * geocode paths to coarsen exact coordinates for a PII field.
 */
export function isLocationFieldPrivate(
  itemSchema: Record<string, unknown> | null | undefined
): boolean {
  const { primary } = parseLocationFields(itemSchema);
  if (!primary) return false;
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  return properties[primary.field]?.private === true;
}

/**
 * The geocode queries that produce the item's locations, from the PRIMARY field
 * only (secondary fields are never geocoded):
 *   - multiple -> one {query,label} per non-empty array entry (label = value).
 *   - single   -> one {query} from the field's string value.
 *   - null     -> [].
 */
export function buildLocationQueries(
  data: Record<string, unknown>,
  primary: LocationField | null
): Array<{ query: string; label?: string }> {
  if (!primary) return [];
  const raw = data[primary.field];
  if (primary.cardinality === 'multiple') {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => ({ query: v.trim(), label: v.trim() }));
  }
  return typeof raw === 'string' && raw.trim() ? [{ query: raw.trim() }] : [];
}

/**
 * True when the schema's primary location field is present in `partialState`
 * (a partial update payload) and its value differs from `priorState`.
 * Used to decide whether an UPDATE should re-geocode.
 */
export function primaryAddressChanged(
  itemSchema: Record<string, unknown>,
  partialState: Record<string, unknown>,
  priorState: Record<string, unknown>,
): boolean {
  const { primary } = parseLocationFields(itemSchema);
  if (!primary) return false;
  if (!Object.prototype.hasOwnProperty.call(partialState, primary.field)) return false;
  // Primary location values are a string (single) or string[] (multiple), so
  // JSON.stringify is a sound deterministic equality check (and array reordering
  // is intentionally treated as a change). Not safe for object-valued fields.
  return JSON.stringify(partialState[primary.field]) !== JSON.stringify(priorState[primary.field]);
}

/**
 * Throws when an item schema does not declare exactly one `primary` location
 * field. Called at network-config load so a misconfigured network fails fast.
 */
export function assertSinglePrimaryLocation(
  itemSchema: Record<string, unknown> | null | undefined,
  context: string
): void {
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const primaryCount = Object.values(properties).filter(
    (p) => p?.location === 'primary'
  ).length;
  if (primaryCount !== 1) {
    throw new Error(
      `${context}: item schema must declare exactly one "location": "primary" field, found ${primaryCount}.`
    );
  }
}
