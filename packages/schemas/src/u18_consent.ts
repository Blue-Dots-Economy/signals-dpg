import z from 'zod';

export const U18DobBodySchema = z.object({
  network: z.string().min(1),
  birthYear: z.number().int().min(1900).max(2100),
  birthMonth: z.number().int().min(1).max(12),
});
export const U18DobResponseSchema = z.object({ isMinor: z.boolean() });

export const U18GuardianBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  guardianName: z.string().min(1),
  guardianContact: z.string().min(1),
  guardianContactType: z.enum(['phone', 'email']),
  // Ward's guardian-validity attestation (D12) — must be explicitly true.
  guardianDeclarationAccepted: z.literal(true),
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
