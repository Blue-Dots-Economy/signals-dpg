import z from 'zod';

export const UserConsentCategorySchema = z.enum(['terms', 'privacy']);

export const ConsentStatusQuerySchema = z.object({ network: z.string().min(1) });

const ConsentStatusVersionsSchema = z.object({
  terms: z.array(z.number().int()),
  privacy: z.array(z.number().int()),
});

/**
 * The UNAUTHENTICATED pre-login status, keyed on a phone/email.
 *
 * Kept separate from `ConsentStatusResponseSchema` because it must never carry
 * `variant`: that would tell anyone holding a phone number that it belongs to
 * a minor.
 */
export const ConsentStatusByIdentifierResponseSchema = z.object({
  statuses: ConsentStatusVersionsSchema,
});

export const ConsentStatusResponseSchema = z.object({
  statuses: ConsentStatusVersionsSchema,
  /**
   * Which document set applies to this user, resolved server-side from the
   * recorded age; never client-supplied, or a client could choose its own
   * terms. `statuses` are compared against the current version of this set,
   * so a `u18_documents` version bump re-prompts a minor. Absent means `adult`.
   */
  variant: z.enum(['adult', 'u18']).optional(),
});

export const ConsentStatusByIdentifierQuerySchema = z.object({
  network: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
});

export const ConsentAcceptItemSchema = z.object({
  category: UserConsentCategorySchema,
  version: z.number().int().min(1),
});
export const ConsentAcceptBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  source: z.enum(['signup', 'login']),
  items: z.array(ConsentAcceptItemSchema).min(1),
});
export const ConsentAcceptResponseSchema = z.object({ recorded: z.number().int() });

export type ConsentStatusResponse = z.infer<typeof ConsentStatusResponseSchema>;
export type ConsentStatusByIdentifierResponse = z.infer<
  typeof ConsentStatusByIdentifierResponseSchema
>;
export type ConsentAcceptBody = z.infer<typeof ConsentAcceptBodySchema>;
export type ConsentStatusByIdentifierQuery = z.infer<typeof ConsentStatusByIdentifierQuerySchema>;

export const ProfileConsentStatusResponseSchema = z.object({
  consented_item_ids: z.array(z.string()),
});

export const ProfileConsentAcceptBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  item_id: z.string().uuid(),
  version: z.number().int().min(1),
});

export type ProfileConsentStatusResponse = z.infer<typeof ProfileConsentStatusResponseSchema>;
export type ProfileConsentAcceptBody = z.infer<typeof ProfileConsentAcceptBodySchema>;
