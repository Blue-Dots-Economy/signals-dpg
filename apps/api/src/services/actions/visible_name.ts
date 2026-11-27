import { resolve_display_name } from '@/services/metrics/resolve_display_name';

/**
 * Conventional name properties to surface when an item schema declares no
 * public `display_name_field`. Private values are masked on every item write
 * (packages/schemas item_state_masking), so item_state carries e.g. "M***".
 */
export const PRIVATE_NAME_FIELDS = ['beneficiary_name', 'full_name', 'name', 'contact_name'];

/**
 * Whether a private name is shown on an action row: the row's status reveals
 * contact details and that profile is live (a paused/draft profile stays
 * masked, matching the contact-details gate). The one rule the list, its search
 * and the export search all use.
 */
export function privateNameShown(
  revealStatuses: readonly string[],
  status: string,
  lifecycleStatus: string | null | undefined
): boolean {
  return revealStatuses.includes(status) && lifecycleStatus === 'live';
}

/**
 * The item's name as a caller may see it, or null when it stays masked: a
 * public display name as-is, else a private name only when `revealed` (a
 * failed decrypt means not visible). Never returns a masked value, so search
 * cannot probe hidden names.
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
