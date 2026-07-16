import z from 'zod';

export const U18DobBodySchema = z.object({
  network: z.string().min(1),
  // Full date of birth (ISO) — stored on user.date_of_birth; is_minor derives.
  dateOfBirth: z.coerce.date(),
});
export const U18DobResponseSchema = z.object({ isMinor: z.boolean() });

// Read-only U18 status for the authenticated ward, derived from the stored
// minor_guardian row (birth month/year captured once at login). Lets the UI
// decide whether to run the guardian flow WITHOUT re-asking the date of birth
// at profile-creation / action time.
export const U18StatusQuerySchema = z.object({ network: z.string().min(1) });
export const U18StatusResponseSchema = z.object({
  /** A birth month/year is already stored for this user (never ask DOB again). */
  hasBirthData: z.boolean(),
  /** Derived from the stored birth month/year; false when no birth data yet. */
  isMinor: z.boolean(),
  /** A guardian has already been OTP-verified for this user. */
  guardianVerified: z.boolean(),
});
export type U18StatusQuery = z.infer<typeof U18StatusQuerySchema>;

export const U18GuardianBodySchema = z
  .object({
    network: z.string().min(1),
    brand: z.string().min(1).nullish(),
    guardianName: z.string().min(1),
    // Both contacts the guardian supplied — at least one required. The server
    // resolves the OTP channel (phone preferred) and stores whatever is given.
    guardianEmail: z.string().min(1).optional(),
    guardianPhone: z.string().min(1).optional(),
    // Ward's guardian-validity attestation (D12) — must be explicitly true.
    guardianDeclarationAccepted: z.literal(true),
    // Explicit ack when a guardian contact matches the ward's own (warn-and-confirm, not a hard reject).
    sameContactAcknowledged: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.guardianEmail) || Boolean(v.guardianPhone), {
    message: 'Provide at least one guardian contact (email or phone)',
    path: ['guardianPhone'],
  });
export const U18GuardianResponseSchema = z.object({ otpSent: z.boolean() });

export const U18GuardianVerifyBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  otp: z.string().length(6),
});
export const U18GuardianVerifyResponseSchema = z.object({ verified: z.boolean() });

export type U18DobBody = z.infer<typeof U18DobBodySchema>;
export type U18GuardianBody = z.infer<typeof U18GuardianBodySchema>;
export type U18GuardianVerifyBody = z.infer<typeof U18GuardianVerifyBodySchema>;

export const U18ProfileConsentBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  item_id: z.string().uuid(),
});
export const U18ProfileConsentResponseSchema = z.object({ otpSent: z.boolean() });

export const U18ProfileConsentVerifyBodySchema = U18ProfileConsentBodySchema.extend({
  otp: z.string().length(6),
});
export const U18ProfileConsentVerifyResponseSchema = z.object({
  verified: z.boolean(),
  promoted: z.boolean(),
});

export type U18ProfileConsentBody = z.infer<typeof U18ProfileConsentBodySchema>;
export type U18ProfileConsentVerifyBody = z.infer<typeof U18ProfileConsentVerifyBodySchema>;

// --- Pre-auth, signup-scoped guardian consent (no session yet) ---
//
// The account doesn't exist yet at this point in the flow, so these bodies
// carry the signup identifier (email OR phoneNumber) directly instead of
// relying on an authenticated user id. Exactly one identifier must be given.

const EXACTLY_ONE_IDENTIFIER = {
  message: 'Exactly one of email or phoneNumber is required',
  path: ['email'],
};

export const SignupGuardianBodySchema = z
  .object({
    network: z.string().min(1),
    domain: z.string().min(1),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(1).optional(),
    dateOfBirth: z.coerce.date(),
    guardianName: z.string().min(1),
    // Both guardian contacts — at least one required; server resolves the OTP
    // channel (phone preferred) and stores whatever is given.
    guardianEmail: z.string().min(1).optional(),
    guardianPhone: z.string().min(1).optional(),
    // Ward's guardian-validity attestation (D12) — must be explicitly true.
    guardianDeclarationAccepted: z.literal(true),
    // Explicit ack when a guardian contact matches the signup identifier itself
    // (warn-and-confirm, not a hard reject).
    sameContactAcknowledged: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.email) !== Boolean(v.phoneNumber), EXACTLY_ONE_IDENTIFIER)
  .refine((v) => Boolean(v.guardianEmail) || Boolean(v.guardianPhone), {
    message: 'Provide at least one guardian contact (email or phone)',
    path: ['guardianPhone'],
  });
export const SignupGuardianResponseSchema = z.object({ otpSent: z.boolean() });

export const SignupGuardianVerifyBodySchema = z
  .object({
    network: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(1).optional(),
    otp: z.string().length(6),
  })
  .refine((v) => Boolean(v.email) !== Boolean(v.phoneNumber), EXACTLY_ONE_IDENTIFIER);
export const SignupGuardianVerifyResponseSchema = z.object({ verified: z.boolean() });

export type SignupGuardianBody = z.infer<typeof SignupGuardianBodySchema>;
export type SignupGuardianVerifyBody = z.infer<typeof SignupGuardianVerifyBodySchema>;
