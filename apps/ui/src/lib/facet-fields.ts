import type { RJSFSchema } from '@rjsf/utils';
import { getFilterFieldEntries } from '@dpg/schemas/filter_fields';
import type { DotNetworkDomain } from '@/engine/types';
import { humanizeKey } from '@/lib/enum-filters';

/**
 * The facet fields a domain will actually honour, field key → human label.
 *
 * Mirrors the SERVER's rule in `apps/api/src/utils/facet_guard.ts`
 * (`resolveFilterableFacetFields`): a field is a valid facet target when it is
 * declared in the item schema's `properties`, not `private: true`, and — once
 * the schema uses the marker — `filterable: true` (`getFilterFieldEntries`). Any
 * other facet is dropped there **silently** — never a 4xx, so a caller cannot
 * probe for private or undeclared fields — which means the domain comes back
 * UNFILTERED while the UI still believes the filter is active (#644 QA, Q6).
 *
 * Deliberately broader than `getEnumFilterFieldsForDomains`: that returns only
 * enum-shaped fields, which is the right set for *rendering* chip groups but
 * the wrong set for deciding what the server accepts. Pruning against the
 * narrow set discards legitimate facets — a declared plain-string field, or
 * anything seeded from a `?f_*` param.
 *
 * The label prefers the schema's own `title`, falling back to a humanized key,
 * so a chip and its editor never print a field's name differently.
 */
/** The facet fields of ONE item schema the server will honour, key → label. */
function facetFieldsOfSchema(schema: RJSFSchema | undefined): Array<[string, string]> {
  return getFilterFieldEntries(schema).map(({ field, property, range }) => {
    const title = typeof property.title === 'string' ? property.title : '';
    return [field, range?.title || title || humanizeKey(field)];
  });
}

export function resolveFacetFieldLabels(
  domains: readonly DotNetworkDomain[],
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const domain of domains) {
    for (const schema of Object.values(domain.item_schemas ?? {})) {
      for (const [field, label] of facetFieldsOfSchema(schema as RJSFSchema)) {
        // First domain to declare a field names it. Two domains declaring the
        // same key with different titles is a schema-authoring question, not
        // something to resolve per-render.
        out[field] ??= label;
      }
    }
  }

  return out;
}
