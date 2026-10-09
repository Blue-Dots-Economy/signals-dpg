// Schema filter markers (infra#57): `filterable`, `x-range-filter`, `x-filter-include-values`.
// Shared by UI and API; a schema with no `filterable` marker keeps every non-private field.

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
  title?: string;
  maxField: string;
  buckets: RangeFilterBucket[];
}

export interface FilterFieldEntry {
  field: string;
  property: Record<string, unknown>;
  range?: RangeFilter;
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
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) return null;
  return { label: raw.label, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

// `max_field` must be declared and non-private, or it could be probed through results.
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

/** The filter fields of one item schema, in declaration order. */
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

/** Selected values plus `x-filter-include-values`; an empty selection stays empty. */
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

/** Declared buckets matching the labels; unknown labels are ignored. */
export function resolveRangeBuckets(range: RangeFilter, labels: unknown[]): RangeFilterBucket[] {
  const wanted = new Set(labels.map(String));
  return range.buckets.filter((bucket) => wanted.has(bucket.label));
}

/** True when the property is a JSON Schema `boolean`. */
export function isBooleanProperty(property: unknown): boolean {
  return isPlainObject(property) && property.type === 'boolean';
}
