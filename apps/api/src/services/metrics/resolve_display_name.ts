export interface ResolveDisplayNameSchema {
  /** Optional pointer to the item_state property to use as the display name. */
  display_name_field?: string;
  /** Standard JSON Schema `properties` object; only structurally checked here. */
  properties?: Record<string, unknown>;
}

export interface ResolveDisplayNameInput {
  schema: ResolveDisplayNameSchema;
  item_state: Record<string, unknown> | null;
  item_id: string;
}

/**
 * Resolves an item's display name for the aggregator dashboard.
 *
 * 1. If the item's schema declares `display_name_field` AND the value at
 *    `item_state[display_name_field]` is a non-empty trimmed string, return it.
 * 2. Otherwise return `item_id` as the fallback.
 *
 * Privacy is enforced upstream by the network-config validator (a schema with
 * `display_name_field` pointing at a `private: true` property fails to load),
 * so this function does not re-check privacy at recompute time.
 */
export const resolve_display_name = (i: ResolveDisplayNameInput): string => {
  const field = i.schema.display_name_field;
  if (!field) return i.item_id;
  if (!i.item_state) return i.item_id;
  const raw = i.item_state[field];
  if (typeof raw !== 'string') return i.item_id;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return i.item_id;
  return trimmed;
};
