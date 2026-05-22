import z from 'zod';

/**
 * Body for POST /api/v1/admin/onboard_participant.
 *
 * Called by aggregator-dpg / voice-dpg / any integrating DPG to create a
 * participant on Signals: a new user plus their profile_1.0 item, with
 * an attribution record of where the onboarding originated.
 *
 * Identity rules:
 *  - At least one of `email` or `phone_number` must be provided (refine).
 *  - Phone numbers are E.164: leading '+' then 10-15 digits.
 *
 * Consent rules:
 *  - Both `terms_accepted` and `privacy_accepted` must be literally true.
 *
 * Attribution:
 *  - `channel` tags the broad onboarding surface.
 *  - `source_id` is opaque to Signals — upstream's id for the originating
 *    artifact (bulk_upload_id, voice_session_id, magic-link id, etc.).
 *
 * `profile` is the payload written into the items table as the
 * participant's profile_1.0 item.
 */

// E.164 phone: leading '+' then 10-15 digits.
const PhoneE164 = z
  .string()
  .regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +911234567890)');

export const OnboardParticipantRequest = z
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
    profile: z
      .record(z.string(), z.unknown())
      .describe('payload written to the items table as profile_1.0'),
  })
  .refine((b) => Boolean(b.email) || Boolean(b.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

export const OnboardParticipantResponse = z.object({
  user_id: z.string(),
  profile_item_id: z.string(),
  onboarded_at: z.iso.datetime(),
});

export type OnboardParticipantRequest = z.infer<
  typeof OnboardParticipantRequest
>;
export type OnboardParticipantResponse = z.infer<
  typeof OnboardParticipantResponse
>;
