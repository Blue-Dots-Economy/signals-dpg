import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';

/**
 * Derives filter groups from JSON Schema `enum` and `type: "array"` +
 * `items.enum` fields. Schema-driven; nothing is network-specific.
 */
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
}

/** Converts a snake_case or camelCase key to Title Case ("looking_for" → "Looking For"). */
export function humanizeKey(key: string): string {
  return key
    .replaceAll('_', ' ')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * One `EnumFilterField` per property with a non-empty top-level `enum`
 * (`isArray: false`) or `type: "array"` with `items.enum` (`isArray: true`).
 * Other shapes are ignored.
 */
function extractEnumFields(schema: RJSFSchema): EnumFilterField[] {
  if (!schema.properties || typeof schema.properties !== 'object') return [];

  const fields: EnumFilterField[] = [];

  for (const [key, rawProp] of Object.entries(schema.properties)) {
    if (typeof rawProp !== 'object' || rawProp === null) continue;
    const prop = rawProp as RJSFSchema & { private?: boolean };

    // A private field is never offered as a filter; the server's facet guard
    // (`resolveAllowedFacetFields`) would drop it anyway. Every declared,
    // non-private enum field is a filter in both the map and list views.
    if (prop.private === true) continue;

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
        });
      }
      continue;
    }

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
          });
        }
      }
    }
  }

  return fields;
}

/**
 * Derives enum filter fields from several schemas. For a key in more than one
 * schema, the first `label` and `isArray` win and `options` are unioned in
 * first-seen order. Fields keep declaration order across schemas.
 */
export function getEnumFilterFields(schemas: RJSFSchema[]): EnumFilterField[] {
  const byKey = new Map<
    string,
    { label: string; optionsSet: Set<string>; options: string[]; isArray: boolean }
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
        });
      } else {
        for (const opt of field.options) {
          if (!existing.optionsSet.has(opt)) {
            existing.optionsSet.add(opt);
            existing.options.push(opt);
          }
        }
      }
    }
  }

  return Array.from(byKey.entries()).map(([key, { label, options, isArray }]) => ({
    key,
    label,
    options,
    isArray,
  }));
}

/**
 * Enum filter fields for every item schema (and `default_item_schemas.profile`)
 * of the given domains. The map and list views use the same set.
 */
export function getEnumFilterFieldsForDomains(domains: DotNetworkDomain[]): EnumFilterField[] {
  const schemas: RJSFSchema[] = [];
  for (const domain of domains) {
    if (domain.item_schemas) {
      for (const schema of Object.values(domain.item_schemas)) {
        schemas.push(schema);
      }
    }
    if (domain.default_item_schemas?.profile) {
      schemas.push(domain.default_item_schemas.profile);
    }
  }
  return getEnumFilterFields(schemas);
}

/**
 * Applies `selectedFields` (fieldKey → selected values) to one item's data:
 * AND across fields, OR within a field. An item without the field passes that
 * check, so a provider field does not exclude seeker items. An array value
 * passes if it intersects the selection.
 */
export function itemPassesEnumFilters(
  data: Record<string, unknown>,
  selectedFields: Record<string, string[]>,
  enumFields: EnumFilterField[],
): boolean {
  const fieldMeta = new Map<string, EnumFilterField>();
  for (const f of enumFields) {
    fieldMeta.set(f.key, f);
  }

  for (const [key, selectedValues] of Object.entries(selectedFields)) {
    if (selectedValues.length === 0) continue; // no selection → don't filter

    // Absent field passes.
    if (!(key in data)) continue;

    const itemValue = data[key];
    const meta = fieldMeta.get(key);
    const isArray = meta?.isArray ?? Array.isArray(itemValue);

    if (isArray) {
      if (!Array.isArray(itemValue)) {
        // Malformed data: treat the single value as a one-element array.
        const strVal = String(itemValue);
        if (!selectedValues.includes(strVal)) return false;
      } else {
        const itemArr = (itemValue as unknown[]).map(String);
        const intersects = itemArr.some((v) => selectedValues.includes(v));
        if (!intersects) return false;
      }
    } else {
      const strVal = itemValue === null || itemValue === undefined ? '' : String(itemValue);
      if (!selectedValues.includes(strVal)) return false;
    }
  }

  return true;
}
