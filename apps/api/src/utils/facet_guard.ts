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
 * Server-resolved private/undeclared-facet guard for the discover BFF (#203).
 * Drops any client-supplied filter whose field is not a declared, non-private
 * facet on the network config's item schema — the client's field list is
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
