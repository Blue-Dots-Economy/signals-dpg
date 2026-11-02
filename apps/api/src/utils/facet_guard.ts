import {
  getDomainItemSchema,
  getDomainItemTypes,
  type NetworkConfigDocument,
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
 * Declared, non-private fields of an item schema (the same
 * `properties[field].private === true` convention as item_state masking).
 * `arrayValued` (`type: 'array'`) tells the signals-search client which
 * filter op to use.
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
 * Drops any client filter whose field is not a declared, non-private field of
 * the item schema; the client's field list is never trusted. `item_state` is
 * already the masked projection, but undeclared fields must not reach
 * signals-search either.
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
  const allowed = resolveAllowedFacetFields(itemSchema);

  return selections
    .filter((selection) => allowed.has(selection.field))
    .map((selection) => ({
      field: selection.field,
      values: selection.values,
      arrayValued: allowed.get(selection.field)?.arrayValued,
    }));
}

/**
 * Server-side allowlist of non-private `item_state` keys a free-text `q` may
 * match, never the client's own list. With no `item_type` (e.g. a map
 * viewport) it unions every item type of the domain. An undefined
 * network/domain/item_type yields no fields, which makes the match
 * unsatisfiable rather than an error.
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
