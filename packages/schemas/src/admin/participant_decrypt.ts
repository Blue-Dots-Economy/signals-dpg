import z from 'zod';

/**
 * Body for POST /api/v1/admin/participant/decrypt.
 *
 * Returns DECRYPTED profile item_state for participants the calling org is
 * entitled to (an aggregator sees only items it onboarded; network_service
 * sees all). Exactly one selector is required:
 *  - `item_ids` — 1..N item uuids (used by the aggregator profile export).
 *  - `user_id` — a single signals user id (all of that user's items).
 *
 * Both modes are implemented now; the aggregator UI uses item_ids first.
 */
export const DecryptParticipantRequest = z
  .object({
    item_ids: z.array(z.uuid()).min(1).optional(),
    user_id: z.string().min(1).optional(),
    // #237: optional field selector. Omitted => full item_state (today's
    // behavior). Present => only these fields returned. Canonical name/email/
    // phone are resolved via the domain contact_fields map with user-table
    // fallback; other names are read from item_state as-is.
    fields: z.array(z.string().min(1)).min(1).max(50).optional(),
  })
  .refine(
    (b) => (b.item_ids ? 1 : 0) + (b.user_id ? 1 : 0) === 1,
    { message: 'exactly one of item_ids or user_id is required' },
  );

/**
 * One decrypted profile. `item_state` is the full cleartext merge of the
 * public item_state and the decrypted private fields. `item_private_state`
 * is never included.
 */
export const DecryptedProfileSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_state: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

/**
 * Response for the decrypt endpoint. Invariant for item_ids mode:
 * profiles.length + skipped.length === count of distinct requested item_ids.
 */
export const DecryptParticipantResponse = z.object({
  profiles: z.array(DecryptedProfileSnapshot),
  skipped: z.array(z.string()),
});

export type DecryptParticipantRequest = z.infer<typeof DecryptParticipantRequest>;
export type DecryptedProfileSnapshot = z.infer<typeof DecryptedProfileSnapshot>;
export type DecryptParticipantResponse = z.infer<typeof DecryptParticipantResponse>;
