import z from 'zod';
import { ItemLocationsArray } from '../api/item_schemas';

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
 *
 * #521 reshape: `fields`, `contact`, and `include_locations` are three
 * independent, optional controls (see
 * docs/superpowers/specs/2026-08-07-participant-decrypt-field-resolution-design.md
 * §4) — deliberately decoupled so canonical contacts and locations are
 * available regardless of the `item_state` projection.
 */
export const DecryptParticipantRequest = z
  .object({
    item_ids: z.array(z.uuid()).min(1).optional(),
    user_id: z.string().min(1).optional(),
    // Pure item_state projection. Omitted => full item_state (today's
    // behavior). Present => only these raw keys, read as-is from item_state.
    // No canonical special-casing, no `user` (account) fallback — see
    // `contact` below for that.
    fields: z.array(z.string().min(1)).min(1).max(50).optional(),
    // Canonical contact block (independent of `fields`). `true` = all three;
    // an array = that subset. Resolved via the domain contact_fields map with
    // account (user-table) fallback + provenance — see DecryptedProfileSnapshot.contact.
    contact: z
      .union([z.boolean(), z.array(z.enum(['name', 'email', 'phone'])).min(1)])
      .optional(),
    // Include the item's geocoded item_locations in the response.
    include_locations: z.boolean().optional(),
  })
  .refine(
    (b) => (b.item_ids ? 1 : 0) + (b.user_id ? 1 : 0) === 1,
    { message: 'exactly one of item_ids or user_id is required' },
  );

const ContactResolutionSchema = z.object({
  value: z.string().nullable(),
  source: z.enum(['item', 'user']).nullable(),
});

/**
 * One decrypted profile. `item_state` is the full cleartext merge of the
 * public item_state and the decrypted private fields (or, when `fields` is
 * requested, a pure projection of it). `item_private_state` is never
 * included.
 *
 * `contact` is present iff the request's `contact` param was set (truthy
 * boolean or non-empty array); `locations` is present iff `include_locations`
 * was `true`.
 */
export const DecryptedProfileSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_state: z.record(z.string(), z.unknown()),
  contact: z
    .object({
      name: ContactResolutionSchema.optional(),
      email: ContactResolutionSchema.optional(),
      phone: ContactResolutionSchema.optional(),
    })
    .optional(),
  locations: ItemLocationsArray.optional(),
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
