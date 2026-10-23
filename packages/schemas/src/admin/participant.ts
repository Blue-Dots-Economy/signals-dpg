import z from 'zod';
import { ItemLocationsArray } from '../api/item_schemas';

/**
 * Body for POST /api/v1/admin/participant: an upsert called by integrating
 * services (aggregator-dpg, voice) to ensure a participant exists on Signals
 * and to add or update their items.
 *
 * At least one of `email` or `phone_number` (E.164) is required. Consent is
 * recorded via the `compliance` array. `channel` tags the onboarding surface;
 * `source_id` is opaque to Signals.
 */

const PhoneE164 = z
  .string()
  .regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +911234567890)');

// Lookup accepts the number with or without the leading "+"; the handler
// prepends "+" before matching the stored E.164 value.
const PhoneLookup = z
  .string()
  .regex(/^\+?\d{10,15}$/, 'must be digits, optionally E.164 (e.g. 919876543210 or +919876543210)');

export const UpsertParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneE164.optional(),
    name: z.string().min(1),
    // Age in years, stored as the `user.age` snapshot. null, '' and non-strings
    // mean "not provided" rather than 0, so they don't trip the U18 age gate.
    // A non-numeric string (e.g. "abc") still fails with 400.
    age: z.preprocess(
      (v) =>
        typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')
          ? v
          : undefined,
      z.coerce.number().int().min(0).max(120).optional(),
    ),
    // Consent captured by an external channel. Recognised keys: `user_terms`,
    // `user_privacy`, `profile_creation`; unknown keys are ignored. Any `false`
    // value is rejected with CONSENT_DECLINED. Versions are derived server-side.
    compliance: z
      .array(z.object({ key: z.string().min(1), value: z.boolean() }))
      .optional(),
    channel: z.enum(['bulk', 'link', 'voice', 'self']),
    source_id: z.string().min(1).optional(),
    item_state: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'payload written to the items table. If absent OR an empty object {} ' +
        'with NO item_id, the route enters account_only mode (only the user is ' +
        'created/looked up, no item is written). If absent/empty WITH an item_id, ' +
        'that profile is targeted for a consent/DOB update without changing its fields.',
      ),
    item_id: z
      .uuid()
      .optional()
      .describe(
        'UUID. Meaningful when the user already exists AND the caller owns them — ' +
        'network_service, or the aggregator that onboarded the user (#309 activation). ' +
        'Targets that specific item for a PATCH-style update. Ignored otherwise.',
      ),
    network: z
      .string()
      .min(1)
      .optional()
      .describe(
        "network id (default: 'blue_dot'). Set when this Signals instance serves a different network.",
      ),
    domain: z
      .string()
      .min(1)
      .optional()
      .describe(
        "domain within the network (default: 'seeker'). REQUIRED when acting on behalf of a non-aggregator org (network_service): it selects which default aggregator owns the participant, so the 'seeker' fallback would mis-assign a provider signup. Omitting it there returns 400 DOMAIN_REQUIRED. Aggregator callers own their own onboards and may omit it.",
      ),
    item_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "schema-typed item_type for the item (default: 'profile_1.0').",
      ),
    item_locations: ItemLocationsArray.optional().describe(
      'exact coordinates the caller already resolved for this item (e.g. an ' +
      'address the participant picked from a Places autocomplete, so the ' +
      'lat/lng is the one the geocoder returned for that exact suggestion). ' +
      'When present and non-empty these are stored as-is and the address text ' +
      'in `item_state` is NOT geocoded server-side. When absent or empty, ' +
      "Signals geocodes the item schema's primary location field from " +
      '`item_state`, which is the historical behaviour. Privacy is unaffected ' +
      'either way: if the primary location field is declared private, the ' +
      'coordinate is jittered 100-250 m before storage regardless of whether ' +
      'it was supplied here or resolved server-side.',
    ),
  })
  .refine((b) => Boolean(b.email) || Boolean(b.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

/**
 * Ordering contract for every participant item list this API returns. Callers
 * such as the voice bot keep only the head of the list, and every POST without
 * `item_id` adds a profile, so newest-first keeps the latest one.
 */
export const PARTICIPANT_ITEMS_ORDER =
  'Ordered newest first by `created_at` (ties broken by `item_id`), so a caller that reads only the head of the list gets the participant\'s most recent profile.';

export const ParticipantItemSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  lifecycle_status: z.string().optional(),
  // Whether this specific profile has profile_creation consent recorded.
  // Optional because the upsert response doesn't populate it (only GET does).
  profile_consent_accepted: z.boolean().optional(),
  item_state: z.record(z.string(), z.unknown()),
  item_locations: ItemLocationsArray,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const UpsertParticipantResponse = z.object({
  user_id: z.string(),
  user_existed: z.boolean(),
  owned_elsewhere: z.boolean(),
  onboarded_at: z.iso.datetime().nullable(),
  items: z.array(ParticipantItemSnapshot).describe(PARTICIPANT_ITEMS_ORDER),
  // consent_record rows written this call. Omitted on the rejected and
  // owned-elsewhere branches.
  consent_recorded: z.number().int().optional(),
  // Who owns this participant. The owner is not always the acting org: a
  // `network_service` caller gets the instance's default aggregator, or null
  // when no single default is nominated. Omitted on the rejected and
  // owned-elsewhere branches.
  onboarded_by_org_id: z.string().nullable().optional(),
  onboarded_by_default: z.boolean().optional(),
});

export const GetParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneLookup.optional(),
    /**
     * Which network's consent documents to compare accepted versions against.
     * Defaults to the served network on a single-network instance; required on
     * a multi-network one.
     */
    network: z.string().min(1).optional(),
  })
  .refine((q) => Boolean(q.email) || Boolean(q.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

/**
 * Keys reported in the GET response's `compliance` array. `user_terms` /
 * `user_privacy` match the POST keys. `has_age` is not a consent but decides
 * whether the adult or minor document set applies. `profile_creation` is
 * item-level and reported per item as `profile_consent_accepted`.
 */
export const ParticipantComplianceKeySchema = z.enum([
  'user_terms',
  'user_privacy',
  'has_age',
]);

/**
 * One reported compliance point, in the same `{key, value}` shape as the POST
 * body. `value` is `true` only when a consent row exists at the document
 * version this instance currently serves (`readCompliance` in
 * `participant_read.ts`).
 */
export const ParticipantComplianceEntry = z.object({
  key: ParticipantComplianceKeySchema,
  value: z.boolean(),
});

export const GetParticipantResponse = z.object({
  user_id: z.string().nullable(),
  /**
   * Always has an entry for every key; the user-not-found and
   * aggregator-not-entitled branches report all `false`.
   */
  compliance: z.array(ParticipantComplianceEntry),
  items: z.array(ParticipantItemSnapshot).describe(PARTICIPANT_ITEMS_ORDER),
});

export type UpsertParticipantRequest = z.infer<typeof UpsertParticipantRequest>;
export type UpsertParticipantResponse = z.infer<typeof UpsertParticipantResponse>;
export type ParticipantItemSnapshot = z.infer<typeof ParticipantItemSnapshot>;
export type GetParticipantRequest = z.infer<typeof GetParticipantRequest>;
export type GetParticipantResponse = z.infer<typeof GetParticipantResponse>;
export type ParticipantComplianceKey = z.infer<typeof ParticipantComplianceKeySchema>;
export type ParticipantComplianceEntry = z.infer<typeof ParticipantComplianceEntry>;
