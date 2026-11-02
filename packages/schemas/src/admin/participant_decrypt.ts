import z from 'zod';
import { ItemLocationsArray } from '../api/item_schemas';

/**
 * Body for POST /api/v1/admin/participant/decrypt.
 *
 * Returns decrypted profile item_state for participants the calling org is
 * entitled to (an aggregator sees only items whose creator it onboarded;
 * network_service sees all items in served networks). Exactly one selector is
 * required:
 *  - `item_ids` — 1..N item uuids.
 *  - `user_id` — a single signals user id (all of that user's items).
 *
 * `fields`, `contact` and `include_locations` are independent, so contacts
 * and locations are available regardless of the `item_state` projection.
 */
export const DecryptParticipantRequest = z
  .object({
    item_ids: z.array(z.uuid()).min(1).optional(),
    user_id: z.string().min(1).optional(),
    // item_state projection. Omitted => full item_state; present => only these
    // raw keys. `[]` => `{}`, so `{ fields: [], contact: true }` returns
    // contact details only. No account fallback here; see `contact`.
    fields: z.array(z.string().min(1)).max(50).optional(),
    // Canonical contact block: `true` = all three, an array = that subset,
    // omitted = none. Resolved via the domain contact_fields map with the
    // account (user table) as fallback; each value reports its source.
    contact: z
      .union([z.literal(true), z.array(z.enum(['name', 'email', 'phone'])).min(1)])
      .optional(),
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
  profiles: z.array(DecryptedProfileSnapshot).describe(
    'In `user_id` mode, ordered newest first by `created_at` (ties broken by ' +
      '`item_id`), matching GET/POST /admin/participant. In `item_ids` mode the ' +
      'order follows the database, not the requested ids.',
  ),
  skipped: z.array(z.string()),
});

export type DecryptParticipantRequest = z.infer<typeof DecryptParticipantRequest>;
export type DecryptedProfileSnapshot = z.infer<typeof DecryptedProfileSnapshot>;
export type DecryptParticipantResponse = z.infer<typeof DecryptParticipantResponse>;
