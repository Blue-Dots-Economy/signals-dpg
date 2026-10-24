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
 * An item's public display name: the trimmed `item_state[display_name_field]`
 * when non-empty, else `item_id`. No privacy check here: the network-config
 * validator rejects a `display_name_field` that points at a private property.
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
