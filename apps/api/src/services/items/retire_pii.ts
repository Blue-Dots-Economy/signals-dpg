import { splitItemStateByPrivacy } from '@dpg/schemas';

/**
 * Top-level keys always scrubbed on retire, even when a network's schema does
 * not mark them `private:true`. The schema-driven private-field removal below
 * covers the general case (PII is expected to be `private:true`); this is a
 * backstop for the standard profile identity fields named in #347 (Q9).
 */
const ALWAYS_SCRUB_KEYS = new Set([
  'name',
  'full_name',
  'email',
  'phone',
  'phone_number',
  'mobile',
  'mobile_number',
]);

/**
 * Build the PII-stripped `item_state` for a retired profile (#347, Q9).
 *
 * The stored `item_state` holds the public fields plus MASKED placeholders for
 * every `private:true` field (the real values live encrypted in
 * `item_private_state`). Retire must leave NO PII behind:
 *   - drop every `private:true` field (via the privacy split — the masked
 *     placeholders go to `privateState`, which we discard), and
 *   - additionally drop the standard identity keys (name/phone/email …) in case
 *     a network left them non-private.
 *
 * Kept: all remaining non-PII public fields. Location coordinates are NOT in
 * item_state (they live in the `item_locations` column, jittered) so the
 * caller keeps those untouched. `item_private_state` should be nulled by the
 * caller alongside using this result.
 */
export function buildRetiredItemState(
  itemSchema: Record<string, unknown> | null | undefined,
  storedItemState: Record<string, unknown>,
): Record<string, unknown> {
  // Without a schema we can't tell public from private — fail safe by scrubbing
  // only the known identity keys and keeping the rest is NOT safe, so drop
  // everything except an empty object. A retired profile with an unknown schema
  // keeps no fields rather than risk leaking an unclassified PII field.
  if (!itemSchema) return {};

  const { publicState } = splitItemStateByPrivacy(itemSchema, storedItemState);
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(publicState)) {
    if (ALWAYS_SCRUB_KEYS.has(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
