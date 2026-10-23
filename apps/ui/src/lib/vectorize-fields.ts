import type { RJSFSchema } from '@rjsf/utils';

export interface VectorizeField {
  /** Property name in `item_state`. */
  name: string;
  /** The schema's own title, or the property name when it has none. */
  label: string;
  /** `vector_weight` from the schema; 1 when unset, matching the ingest default. */
  weight: number;
}

/**
 * The `vectorize: true` properties of an item schema, with their
 * `vector_weight`: exactly the fields signals-search embeds for ranking (each
 * line repeated `vector_weight` times at ingest). They answer "what feeds this
 * relevance number?", not "how much did each field contribute" (see
 * `RelevanceExplanation`).
 *
 * Sorted by weight descending; ties keep schema order.
 */
export function vectorizeFieldsOf(schema: RJSFSchema | undefined): VectorizeField[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return [];

  const out: VectorizeField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object') continue;
    const prop = raw as Record<string, unknown>;
    if (prop.vectorize !== true) continue;

    const weight = typeof prop.vector_weight === 'number' ? prop.vector_weight : 1;
    const label = typeof prop.title === 'string' && prop.title ? prop.title : name;
    out.push({ name, label, weight });
  }

  // Array.prototype.sort is stable, so ties keep declaration order.
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * The viewer's and the item's values for one vectorized field, as display
 * strings. Compares attributes only; it does not decompose the score. Arrays
 * are joined; objects are dropped rather than shown as `[object Object]`.
 */
export function readFieldValue(
  state: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const value = state?.[name];
  if (value == null) return null;
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === 'string' || typeof v === 'number');
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
