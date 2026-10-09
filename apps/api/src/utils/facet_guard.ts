import {
  expandFilterValues,
  getDomainItemSchema,
  getDomainItemTypes,
  getFilterFieldEntries,
  isBooleanProperty,
  resolveRangeBuckets,
  type FilterFieldEntry,
  type NetworkConfigDocument,
  type RangeFilterBucket,
} from '@dpg/schemas';
import type {
  FacetValue,
  SignalsSearchFacetInput,
} from '@/services/signals_search_client';

export interface FacetSelection {
  field: string;
  values: FacetValue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Declared, non-private facet fields for an item schema, keyed by field name.
 * Reuses the same `properties[field].private === true` convention as
 * `item_state_privacy.ts` / `location_fields.ts` (item_state masking) — a
 * field is a valid facet target only if it is declared in the schema's
 * `properties` AND not marked private. `arrayValued` (JSON Schema
 * `type: 'array'`) tells the signals-search client which filter op to use.
 */
export function resolveAllowedFacetFields(
  itemSchema: Record<string, unknown>
): Map<string, { arrayValued: boolean }> {
  const properties = isPlainObject(itemSchema.properties)
    ? itemSchema.properties
    : {};
  const allowed = new Map<string, { arrayValued: boolean }>();

  for (const [field, propertySchema] of Object.entries(properties)) {
    if (!isPlainObject(propertySchema) || propertySchema.private === true) {
      continue;
    }

    allowed.set(field, { arrayValued: propertySchema.type === 'array' });
  }

  return allowed;
}

/**
 * The facet fields a caller may FILTER on for an item schema (infra#57): the
 * declared, non-private fields above, narrowed to the ones marked
 * `filterable: true` once the schema uses that marker at all — see
 * `getFilterFieldEntries` in `@dpg/schemas`. `booleanValued` lets
 * `resolveAllowedFacetFilters` turn the UI's `"true"`/`"false"` into JSON
 * booleans, which signals-search compares type-strictly.
 */
export function resolveFilterableFacetFields(
  itemSchema: Record<string, unknown>
): Map<string, { arrayValued: boolean; booleanValued: boolean; entry: FilterFieldEntry }> {
  const allowed = new Map<
    string,
    { arrayValued: boolean; booleanValued: boolean; entry: FilterFieldEntry }
  >();
  for (const entry of getFilterFieldEntries(itemSchema)) {
    allowed.set(entry.field, {
      arrayValued: entry.property.type === 'array',
      booleanValued: isBooleanProperty(entry.property),
      entry,
    });
  }
  return allowed;
}

/**
 * One `[min, max]` covering every selected bucket. signals-search ANDs its
 * filter clauses, so it cannot OR two buckets; their envelope is exact for
 * adjacent buckets but also matches the gap between non-adjacent ones
 * (0-3 + 10-15 LPA includes 3-10 LPA jobs). The native path ORs the buckets
 * and is exact. An open bound on any bucket stays open.
 */
function bucketEnvelope(buckets: RangeFilterBucket[]): { min?: number; max?: number } {
  const mins = buckets.map((bucket) => bucket.min);
  const maxes = buckets.map((bucket) => bucket.max);
  const min = mins.includes(undefined) ? undefined : Math.min(...(mins as number[]));
  const max = maxes.includes(undefined) ? undefined : Math.max(...(maxes as number[]));
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

function toBooleanFacetValue(value: FacetValue): FacetValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/**
 * Server-resolved private/undeclared-facet guard for the discover BFF (#203).
 * Drops any client-supplied filter whose field is not a declared, non-private
 * (and, where the schema uses the marker, `filterable: true`) facet on the
 * network config's item schema — the client's field list is
 * never trusted. Defense-in-depth: `item_state` is already the masked public
 * projection, but undeclared fields (typos, fields dropped from a newer
 * schema, etc.) must not reach signals-search either.
 */
export function resolveAllowedFacetFilters(
  networkConfig: NetworkConfigDocument,
  domain: string,
  itemType: string,
  selections: FacetSelection[]
): SignalsSearchFacetInput[] {
  const itemSchema = getDomainItemSchema(
    networkConfig,
    domain,
    itemType
  ) as Record<string, unknown>;
  const allowed = resolveFilterableFacetFields(itemSchema);

  return selections.flatMap((selection): SignalsSearchFacetInput[] => {
    const meta = allowed.get(selection.field);
    if (!meta) return [];

    const { range } = meta.entry;
    if (range) {
      // Labels the schema doesn't declare are ignored. If none survive, send
      // the labels as a plain value match — a label is never a stored number,
      // so it matches nothing, as the native path's `false` does. Dropping
      // the filter instead would silently widen it to every item.
      const buckets = resolveRangeBuckets(range, selection.values);
      if (buckets.length === 0) {
        return [{ field: selection.field, values: selection.values, arrayValued: false }];
      }
      return [
        {
          field: selection.field,
          values: buckets.map((bucket) => bucket.label),
          range: { maxField: range.maxField, ...bucketEnvelope(buckets) },
        },
      ];
    }

    const values = meta.booleanValued
      ? selection.values.map(toBooleanFacetValue)
      : selection.values;
    return [
      {
        field: selection.field,
        values: expandFilterValues(meta.entry, values),
        arrayValued: meta.arrayValued,
      },
    ];
  });
}

/**
 * #394 map native text search (moved here unchanged from `markers.ts` for
 * #203 List PR Task 3 reuse by the discover BFF's native fallback): resolves
 * the SERVER-known allowlist of non-private `item_state` field keys a
 * free-text `q` may match against, for a given network/domain (+ optional
 * item_type). Reuses `resolveAllowedFacetFields` above — the same
 * `private: true` convention every other item_state guard in this codebase
 * already trusts — never the client's own field list, so a client can't
 * expand its match surface by naming more fields.
 *
 * `item_type` is optional for callers whose request can span every item_type
 * in a domain (e.g. a map viewport), so when it's omitted this unions the
 * non-private fields across every item_type declared for the domain — the
 * same "no single item_type" treatment item_fetch_runtime.ts's own
 * (differently-scoped, array-facet) `resolveAllowedFacetFields` already
 * gives. A network/domain/item_type this instance doesn't actually define
 * contributes no fields — fails closed via `buildWhereClause`'s
 * `fields.length === 0` branch (unsatisfiable match), never a throw or a 500.
 */
export function resolveTextSearchFields(
  networkConfig: NetworkConfigDocument,
  domain: string,
  itemType: string | undefined
): string[] {
  let itemTypes: string[];
  try {
    itemTypes = itemType ? [itemType] : getDomainItemTypes(networkConfig, domain);
  } catch {
    return [];
  }

  const fields = new Set<string>();
  for (const type of itemTypes) {
    let schema: Record<string, unknown>;
    try {
      schema = getDomainItemSchema(networkConfig, domain, type) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    for (const field of resolveAllowedFacetFields(schema).keys()) {
      fields.add(field);
    }
  }

  return [...fields];
}
