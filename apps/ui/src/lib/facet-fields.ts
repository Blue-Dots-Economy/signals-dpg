import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import { humanizeKey } from '@/lib/enum-filters';

/** A schema property object, or null for anything that is not one. */
function asPropertySchema(value: unknown): { private?: boolean; title?: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as { private?: boolean; title?: string };
}

/** The declared, non-private facet fields of ONE item schema, key → label. */
function facetFieldsOfSchema(schema: RJSFSchema | undefined): Array<[string, string]> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return [];

  const out: Array<[string, string]> = [];
  for (const [field, raw] of Object.entries(properties)) {
    const prop = asPropertySchema(raw);
    if (!prop || prop.private === true) continue;
    out.push([field, prop.title || humanizeKey(field)]);
  }
  return out;
}
/**
 * The facet fields a domain honours, field key → label (schema `title`, else
 * the humanized key).
 *
 * Mirrors the server's `resolveAllowedFacetFields` (apps/api/src/utils/facet_guard.ts):
 * a field is a valid facet when declared in the item schema's `properties` and
 * not `private: true`. The server drops any other facet silently (no 4xx, so
 * private fields cannot be probed), leaving the domain unfiltered while the UI
 * thinks the filter is active. Broader than `getEnumFilterFieldsForDomains`,
 * which returns only enum fields for rendering chip groups.
 */
export function resolveFacetFieldLabels(
  domains: readonly DotNetworkDomain[],
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const domain of domains) {
    for (const schema of Object.values(domain.item_schemas ?? {})) {
      for (const [field, label] of facetFieldsOfSchema(schema as RJSFSchema)) {
        // The first domain to declare a field names it.
        out[field] ??= label;
      }
    }
  }

  return out;
}
