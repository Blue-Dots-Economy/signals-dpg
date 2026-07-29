import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';

/**
 * enum-filters.ts
 *
 * Generic helpers for deriving filter groups from JSON Schema enum fields.
 * Completely schema-driven — nothing is hardcoded to a specific network or
 * domain name. Works with any network that uses JSON Schema `enum` /
 * `type:"array" + items.enum` conventions.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EnumFilterField {
  /** Property name from the JSON Schema, e.g. "looking_for". */
  key: string;
  /**
   * Human-readable label. Prefers the schema property's `title`; falls back
   * to humanizing the key (snake_case / camelCase → Title Case).
   */
  label: string;
  /** All possible option values for this field (unioned across schemas). */
  options: string[];
  /**
   * `true` when the field is `type:"array"` with `items.enum` (multi-value
   * per item). `false` when it is a simple `enum` (single value per item).
   */
  isArray: boolean;
  /**
   * `true` when the field's config declares `filterable: true` (Task 1,
   * #203) in at least one of the unioned schemas. This is a DIFFERENT gate
   * than "is an enum" (every field returned by `extractEnumFields` already
   * has an `enum`): `filterable` is what the SERVER's facet guard
   * (`resolveAllowedFacetFields` in `apps/api/src/utils/item_fetch_runtime.ts`)
   * actually honors for the `= ANY(...)` map facet path (#203 Task 3) — an
   * enum field with no `filterable: true` marker is a normal form field the
   * server will silently drop as a facet filter. `getEnumFilterFieldsForDomains`'s
   * `filterableOnly` option uses this to scope the MAP's offered/sent
   * facets to only fields the server will actually act on, while the LIST
   * keeps offering every enum field regardless (#203 Task 7 review fix).
   */
  filterable: boolean;
}

// ─── Humanization ─────────────────────────────────────────────────────────────

/**
 * Convert a snake_case or camelCase key to Title Case.
 * Examples: "looking_for" → "Looking For", "providerCategory" → "Provider Category"
 */
export function humanizeKey(key: string): string {
  // Split on underscores and camelCase boundaries
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Scan a single JSON Schema's `properties` for enum and array-of-enum fields.
 * Returns one `EnumFilterField` per matching property.
 *
 * Detection rules (generic — inspects JSON Schema `properties`):
 *   - `{ type: "string"|"number", enum: [...] }` → single-value enum (`isArray: false`)
 *   - `{ type: "array", items: { enum: [...] } }` → array-of-enum (`isArray: true`)
 *   - Any other shape is ignored.
 */
function extractEnumFields(schema: RJSFSchema): EnumFilterField[] {
  if (!schema.properties || typeof schema.properties !== 'object') return [];

  const fields: EnumFilterField[] = [];

  for (const [key, rawProp] of Object.entries(schema.properties)) {
    // JSON Schema properties can be boolean (true/false) when using additionalProperties
    if (typeof rawProp !== 'object' || rawProp === null) continue;
    const prop = rawProp as RJSFSchema & { private?: boolean; filterable?: boolean };
    const filterable = prop.filterable === true;

    // Defense-in-depth (#203 Task 7): never offer a `private: true` field as
    // a filter option, even though the server's facet guard
    // (`resolveAllowedFacetFields`) would silently drop any filter request
    // on one anyway. No currently-configured network schema declares both
    // `private: true` and `enum` on the same property (verified across
    // every `examples/schemas/*/network.json`), so this doesn't change any
    // network's filter options today — it just stops a future schema edit
    // from silently surfacing an inert-but-visible filter for a private
    // field.
    if (prop.private === true) continue;

    // Single-value enum: string or number property with a top-level `enum` array
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      const options = prop.enum
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map(String);
      if (options.length > 0) {
        fields.push({
          key,
          label: typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : humanizeKey(key),
          options,
          isArray: false,
          filterable,
        });
      }
      continue;
    }

    // Array-of-enum: `type: "array"` with `items.enum`
    if (
      prop.type === 'array' &&
      prop.items !== null &&
      typeof prop.items === 'object' &&
      !Array.isArray(prop.items)
    ) {
      const items = prop.items as RJSFSchema;
      if (Array.isArray(items.enum) && items.enum.length > 0) {
        const options = items.enum
          .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
          .map(String);
        if (options.length > 0) {
          fields.push({
            key,
            label: typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : humanizeKey(key),
            options,
            isArray: true,
            filterable,
          });
        }
      }
    }
  }

  return fields;
}

// ─── Multi-schema union ────────────────────────────────────────────────────────

/**
 * Derive enum filter fields from an array of JSON Schemas (e.g. all item_type
 * schemas from all visible domains).
 *
 * When the same `key` appears in multiple schemas:
 *   - The `label` from the first occurrence is used.
 *   - `options` are unioned (preserving first-seen order, deduped by value).
 *   - `isArray` from the first occurrence wins.
 *   - `filterable` is OR'd across occurrences — a field counts as filterable
 *     if ANY unioned schema (e.g. any domain's item_type) declares
 *     `filterable: true` for it, matching the permissive "union" spirit of
 *     `options`/`isArray` above. Note this is a coarser grain than the
 *     server's own per-domain guard (`resolveAllowedFacetFields` resolves
 *     filterable-ness per NETWORK+DOMAIN, not globally): in the rare case a
 *     field is `filterable` in one domain's schema but not another's, this
 *     union will still offer/send it, and the server will apply it for the
 *     domain(s) that declare it filterable and silently drop it for the
 *     domain(s) that don't (Task 3's existing per-domain-request behavior,
 *     unchanged) — no domain ever gets a filter applied it didn't declare.
 *
 * Fields are returned in declaration order across schemas (first schema first).
 */
export function getEnumFilterFields(schemas: RJSFSchema[]): EnumFilterField[] {
  // Map from key → accumulated field (mutable during the loop)
  const byKey = new Map<
    string,
    { label: string; optionsSet: Set<string>; options: string[]; isArray: boolean; filterable: boolean }
  >();

  for (const schema of schemas) {
    for (const field of extractEnumFields(schema)) {
      const existing = byKey.get(field.key);
      if (!existing) {
        byKey.set(field.key, {
          label: field.label,
          optionsSet: new Set(field.options),
          options: [...field.options],
          isArray: field.isArray,
          filterable: field.filterable,
        });
      } else {
        // Union options, preserving insertion order, deduping by value
        for (const opt of field.options) {
          if (!existing.optionsSet.has(opt)) {
            existing.optionsSet.add(opt);
            existing.options.push(opt);
          }
        }
        existing.filterable = existing.filterable || field.filterable;
      }
    }
  }

  return Array.from(byKey.entries()).map(([key, { label, options, isArray, filterable }]) => ({
    key,
    label,
    options,
    isArray,
    filterable,
  }));
}

export interface GetEnumFilterFieldsForDomainsOptions {
  /**
   * When `true`, only return fields with `filterable: true` (Task 1's
   * network.json marker) — the set the server's facet guard
   * (`resolveAllowedFacetFields`, #203 Task 3) will actually honor as an
   * `item_state` MAP filter. When `false`/omitted, returns every enum field
   * (the LIST's behavior, unchanged — the list filters client-side and
   * needs no server cooperation, #203 Task 7 review fix).
   */
  filterableOnly?: boolean;
}

/**
 * Convenience helper: extract all item_schemas from the given visible domains,
 * then derive enum filter fields.
 */
export function getEnumFilterFieldsForDomains(
  domains: DotNetworkDomain[],
  options?: GetEnumFilterFieldsForDomainsOptions,
): EnumFilterField[] {
  const schemas: RJSFSchema[] = [];
  for (const domain of domains) {
    if (domain.item_schemas) {
      for (const schema of Object.values(domain.item_schemas)) {
        schemas.push(schema);
      }
    }
    // Also check default_item_schemas for backwards-compat
    if (domain.default_item_schemas?.profile) {
      schemas.push(domain.default_item_schemas.profile);
    }
  }
  const fields = getEnumFilterFields(schemas);
  return options?.filterableOnly ? fields.filter((f) => f.filterable) : fields;
}

// ─── Filter application ───────────────────────────────────────────────────────

/**
 * Apply `selectedFields` (a map of fieldKey → selected values[]) to a single
 * item's data object.
 *
 * Semantics:
 *   - AND across different field keys (item must pass every active field filter).
 *   - OR within a single field's selected values (match ANY selected value).
 *   - If the item does NOT have the field in its data → the item PASSES this
 *     field check (domain-safe: a provider field won't kill seeker items).
 *   - If the field is present:
 *       • Single value: passes if the item's value is in the selected set.
 *       • Array value:  passes if the item's array intersects the selected set.
 *
 * @param data           - The item's data object (from `item.data`).
 * @param selectedFields - Map of fieldKey → non-empty selected value arrays.
 * @param enumFields     - The field metadata (used to know `isArray`).
 */
export function itemPassesEnumFilters(
  data: Record<string, unknown>,
  selectedFields: Record<string, string[]>,
  enumFields: EnumFilterField[],
): boolean {
  // Build a quick lookup from key → metadata
  const fieldMeta = new Map<string, EnumFilterField>();
  for (const f of enumFields) {
    fieldMeta.set(f.key, f);
  }

  for (const [key, selectedValues] of Object.entries(selectedFields)) {
    if (selectedValues.length === 0) continue; // no selection → don't filter

    // Absent field → passes (domain-safe)
    if (!(key in data)) continue;

    const itemValue = data[key];
    const meta = fieldMeta.get(key);
    const isArray = meta?.isArray ?? Array.isArray(itemValue);

    if (isArray) {
      // Array field: passes if any of the item's values is in the selected set
      if (!Array.isArray(itemValue)) {
        // Malformed data — treat the single value as a one-element array
        const strVal = String(itemValue);
        if (!selectedValues.includes(strVal)) return false;
      } else {
        const itemArr = (itemValue as unknown[]).map(String);
        const intersects = itemArr.some((v) => selectedValues.includes(v));
        if (!intersects) return false;
      }
    } else {
      // Single-value field: passes if the item's value is in the selected set
      const strVal = itemValue === null || itemValue === undefined ? '' : String(itemValue);
      if (!selectedValues.includes(strVal)) return false;
    }
  }

  return true;
}
