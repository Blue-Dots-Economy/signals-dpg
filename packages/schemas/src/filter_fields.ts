/**
 * Marker-driven filter-field selection (infra-deployments#57).
 *
 *   "filterable": true   — the property is offered as a filter (UI) and
 *                          accepted as a facet (API).
 *
 * Opt-in per item schema: as soon as ONE property of a schema carries
 * `filterable: true`, only the marked properties of that schema are filters.
 * A schema with no marker keeps the pre-marker behaviour (every declared,
 * non-private property is a facet), so networks that have not adopted the
 * marker are unchanged. `private: true` always wins — a private property is
 * never a filter, marked or not; it is the enumeration guard for private
 * values and must stay.
 *
 * Text search is deliberately NOT gated by this marker: free-text `q` still
 * matches every non-private field (see `resolveTextSearchFields`).
 *
 * Two optional markers refine HOW a filter field matches:
 *
 *   "x-range-filter": { title?, max_field, buckets: [{ label, min?, max? }] }
 *       — on the lower-bound field of a min/max pair (e.g. `salaryMin`). The
 *         filter value is a bucket LABEL; the server resolves its bounds from
 *         this schema and matches an item whose [field, max_field] range
 *         overlaps the bucket. A client therefore can never send arbitrary
 *         numbers, only a bucket the schema declares.
 *   "x-filter-include-values": ["Any"]
 *       — values that also match whenever the field is filtered at all, so a
 *         seeker choosing "Female" still sees jobs open to "Any" gender.
 *
 * Shared by the UI (filter panels, chip pruning) and the API (facet guards),
 * so both sides always agree on what a filter is.
 */

type FilterPropertySchema = { filterable?: unknown; private?: unknown; type?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertiesOf(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) return {};
  return isPlainObject(schema.properties) ? schema.properties : {};
}

/** True when any property of the schema declares `filterable: true`. */
export function hasFilterableMarkers(schema: unknown): boolean {
  return Object.values(propertiesOf(schema)).some(
    (prop) => isPlainObject(prop) && prop.filterable === true
  );
}

export interface RangeFilterBucket {
  label: string;
  min?: number;
  max?: number;
}

export interface RangeFilter {
  /** Group heading for the filter; the field's own title when absent. */
  title?: string;
  /** The upper-bound field paired with the marked (lower-bound) field. */
  maxField: string;
  buckets: RangeFilterBucket[];
}

export interface FilterFieldEntry {
  field: string;
  property: Record<string, unknown>;
  /** Present when the property declares a valid `x-range-filter`. */
  range?: RangeFilter;
  /** `x-filter-include-values`, when the property declares any. */
  includeValues?: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRangeBucket(raw: unknown): RangeFilterBucket | null {
  if (!isPlainObject(raw) || typeof raw.label !== 'string' || raw.label.trim() === '') {
    return null;
  }
  const min = isFiniteNumber(raw.min) ? raw.min : undefined;
  const max = isFiniteNumber(raw.max) ? raw.max : undefined;
  // A bucket with no bound at all would match everything.
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) return null;
  return { label: raw.label, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

/**
 * The `x-range-filter` of one property, or undefined when it has none or it
 * is malformed. `max_field` must be a declared, non-private property of the
 * same schema: the overlap match reads it, so a private upper bound would
 * let a caller probe a private value through found/not-found results.
 */
function parseRangeFilter(
  property: Record<string, unknown>,
  properties: Record<string, unknown>
): RangeFilter | undefined {
  const raw = property['x-range-filter'];
  if (!isPlainObject(raw) || typeof raw.max_field !== 'string') return undefined;

  const maxProperty = properties[raw.max_field];
  if (!isPlainObject(maxProperty) || maxProperty.private === true) return undefined;
  if (!Array.isArray(raw.buckets)) return undefined;

  const buckets = raw.buckets
    .map(parseRangeBucket)
    .filter((bucket): bucket is RangeFilterBucket => bucket !== null);
  if (buckets.length === 0) return undefined;

  return {
    ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim() } : {}),
    maxField: raw.max_field,
    buckets,
  };
}

function parseIncludeValues(property: Record<string, unknown>): string[] | undefined {
  const raw = property['x-filter-include-values'];
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((value): value is string => typeof value === 'string');
  return values.length > 0 ? values : undefined;
}

/**
 * The properties of ONE item schema that are filters, in declaration order.
 * See the module comment for the opt-in rule.
 */
export function getFilterFieldEntries(schema: unknown): FilterFieldEntry[] {
  const properties = propertiesOf(schema);
  const markersInUse = hasFilterableMarkers(schema);
  const entries: FilterFieldEntry[] = [];

  for (const [field, raw] of Object.entries(properties)) {
    if (!isPlainObject(raw)) continue;
    const prop = raw as FilterPropertySchema;
    if (prop.private === true) continue;
    if (markersInUse && prop.filterable !== true) continue;

    const range = parseRangeFilter(raw, properties);
    const includeValues = parseIncludeValues(raw);
    entries.push({
      field,
      property: raw,
      ...(range ? { range } : {}),
      ...(includeValues ? { includeValues } : {}),
    });
  }

  return entries;
}

/**
 * The selected values plus the field's `x-filter-include-values`, deduped.
 * An empty selection stays empty: it means "match nothing", and widening it
 * would turn that into "match Any".
 */
export function expandFilterValues<T>(
  entry: Pick<FilterFieldEntry, 'includeValues'>,
  values: T[]
): Array<T | string> {
  if (values.length === 0 || !entry.includeValues) return values;
  const out: Array<T | string> = [...values];
  for (const extra of entry.includeValues) {
    if (!out.some((value) => String(value) === extra)) out.push(extra);
  }
  return out;
}

/** The declared buckets matching the selected labels; unknown labels drop. */
export function resolveRangeBuckets(range: RangeFilter, labels: unknown[]): RangeFilterBucket[] {
  const wanted = new Set(labels.map(String));
  return range.buckets.filter((bucket) => wanted.has(bucket.label));
}

/** True when the property is a JSON Schema `boolean`. */
export function isBooleanProperty(property: unknown): boolean {
  return isPlainObject(property) && property.type === 'boolean';
}
