import z from 'zod';

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
 *  - Both `terms_accepted` and `privacy_accepted` must be literally true.
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

export const UpsertParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneE164.optional(),
    name: z.string().min(1),
    date_of_birth: z.iso.datetime().optional(),
    terms_accepted: z
      .boolean()
      .refine((v) => v === true, 'terms_accepted must be true'),
    privacy_accepted: z
      .boolean()
      .refine((v) => v === true, 'privacy_accepted must be true'),
    channel: z.enum(['bulk', 'link', 'voice', 'self']),
    source_id: z.string().min(1).optional(),
    item_state: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'payload written to the items table; if absent the user is created/looked up without an item (account-only)',
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
  item_state: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const UpsertParticipantResponse = z.object({
  user_id: z.string(),
  user_existed: z.boolean(),
  owned_elsewhere: z.boolean(),
  onboarded_at: z.iso.datetime().nullable(),
  items: z.array(ParticipantItemSnapshot),
});

export type UpsertParticipantRequest = z.infer<typeof UpsertParticipantRequest>;
export type UpsertParticipantResponse = z.infer<typeof UpsertParticipantResponse>;
export type ParticipantItemSnapshot = z.infer<typeof ParticipantItemSnapshot>;
