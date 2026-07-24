import z from 'zod';
import { ItemLocationsArray } from '../api/item_schemas';

/**
 * Body for POST /api/v1/admin/participant.
 *
 * Tier-aware upsert. Called by aggregator-dpg / voice-dpg / any
 * integrating service to ensure a participant exists on Signals and
 * to add/update their items.
 *
 * Identity rules:
 *  - At least one of `email` or `phone_number` is required (refine).
 *  - Phone numbers are E.164.
 *
 * Consent rules:
 *  - `terms_accepted` / `privacy_accepted` are deprecated (#309): optional,
 *    accepted for backward compatibility, but ignored. Consent is recorded
 *    via the `compliance` array instead.
 *
 * Attribution:
 *  - `channel` tags the broad onboarding surface.
 *  - `source_id` is opaque to Signals.
 *
 * `item_state` is the payload written into the items table. `item_id`
 * (optional) targets a specific existing item to update — only
 * meaningful when acting_org is network_service AND the user already
 * exists; ignored otherwise.
 */

const PhoneE164 = z
  .string()
  .regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +911234567890)');

// Read-side lookup accepts the number with or without the leading "+"
// (callers often send "919876543210"). The handler canonicalizes to E.164
// (prepends "+") before matching the stored, "+"-prefixed phone_number.
const PhoneLookup = z
  .string()
  .regex(/^\+?\d{10,15}$/, 'must be digits, optionally E.164 (e.g. 919876543210 or +919876543210)');

export const UpsertParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneE164.optional(),
    name: z.string().min(1),
    // Accept a date-only `yyyy-mm-dd` OR a full ISO datetime — integrating DPGs
    // (aggregator / voice / WhatsApp) typically have only a birth date. Both
    // parse cleanly via `new Date(...)` into `user.date_of_birth`.
    date_of_birth: z.union([z.iso.date(), z.iso.datetime()]).optional(),
    // Deprecated (#309): accepted for backward compatibility with existing
    // callers (aggregator-dpg / bulk) but IGNORED. Consent is recorded via
    // `compliance`. Remove in a later cleanup ticket.
    terms_accepted: z.boolean().optional(),
    privacy_accepted: z.boolean().optional(),
    // Consent captured by an external channel (voice/aggregator/bulk). Each
    // entry names a consent the user accepted/declined on the channel; only
    // `value: true` is recorded (append-only ledger). Recognised keys:
    // `user_terms`, `user_privacy`, `profile_creation`. Unknown keys (e.g. a
    // future action/connect key) are ignored. Versions are derived server-side.
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
        'UUID. Only meaningful when acting_org is network_service AND user already exists. ' +
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
      .describe("domain within the network (default: 'seeker')."),
    item_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "schema-typed item_type for the item (default: 'profile_1.0').",
      ),
  })
  .refine((b) => Boolean(b.email) || Boolean(b.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

export const ParticipantItemSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  // Present on the upsert response so callers can tell live vs draft. Optional
  // because sibling readers (participant_read) do not populate it.
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
  items: z.array(ParticipantItemSnapshot),
  // Number of consent_record rows written this call (#309). Optional so the
  // rejected / owned-elsewhere branches can omit it.
  consent_recorded: z.number().int().optional(),
});

export const GetParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneLookup.optional(),
  })
  .refine((q) => Boolean(q.email) || Boolean(q.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

export const GetParticipantResponse = z.object({
  user_id: z.string().nullable(),
  user_consent: z.object({
    terms_accepted: z.boolean(),
    privacy_accepted: z.boolean(),
    has_date_of_birth: z.boolean(),
  }),
  items: z.array(ParticipantItemSnapshot),
});

export type UpsertParticipantRequest = z.infer<typeof UpsertParticipantRequest>;
export type UpsertParticipantResponse = z.infer<typeof UpsertParticipantResponse>;
export type ParticipantItemSnapshot = z.infer<typeof ParticipantItemSnapshot>;
export type GetParticipantRequest = z.infer<typeof GetParticipantRequest>;
export type GetParticipantResponse = z.infer<typeof GetParticipantResponse>;
