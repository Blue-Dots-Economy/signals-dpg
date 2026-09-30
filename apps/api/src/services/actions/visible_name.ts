import { resolve_display_name } from '@/services/metrics/resolve_display_name';

/**
 * Conventional name properties to surface when an item schema declares no
 * public `display_name_field`. The schema-aware mask in
 * packages/schemas/item_state_masking applies to these at item-create time,
 * so item_state already carries the masked value (e.g. "M***").
 */
export const PRIVATE_NAME_FIELDS = ['beneficiary_name', 'full_name', 'name', 'contact_name'];

/**
 * Whether a PRIVATE name is shown on an action row: the row's status is one
 * the interaction reveals contact details on, AND that profile is live (a
 * paused/draft profile keeps its name masked even on an accepted action —
 * the contact-details gate, #273). The one rule the list, its search and the
 * export search all use.
 */
export function privateNameShown(
  revealStatuses: readonly string[],
  status: string,
  lifecycleStatus: string | null | undefined
): boolean {
  return revealStatuses.includes(status) && lifecycleStatus === 'live';
}

/**
 * The item's name as a caller may see it, or null when it stays masked.
 *
 * - a public `display_name_field` value → returned as-is;
 * - otherwise a private name → only when `revealed`, read from the decrypted
 *   state (`decrypt` may throw; a failure means "not visible").
 *
 * Used where only UNMASKED names may be matched (owned-action search), so a
 * masked value is never returned.
 */
export function visibleItemName(input: {
  itemId: string;
  schema: Record<string, unknown>;
  publicState: Record<string, unknown>;
  revealed: boolean;
  decrypt: () => Record<string, unknown>;
  /** Told about a failed decrypt; the name then counts as not visible. */
  onDecryptError?: (err: unknown) => void;
}): string | null {
  const publicName = resolve_display_name({
    schema: input.schema,
    item_state: input.publicState,
    item_id: input.itemId,
  });
  if (publicName !== input.itemId) return publicName;
  if (!input.revealed) return null;
  try {
    const state = input.decrypt();
    for (const f of PRIVATE_NAME_FIELDS) {
      const v = state[f];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
  } catch (err) {
    input.onDecryptError?.(err);
    return null;
  }
  return null;
}
