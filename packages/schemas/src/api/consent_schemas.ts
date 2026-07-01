import z from 'zod';

export const UserConsentCategorySchema = z.enum(['terms', 'privacy']);

export const ConsentStatusQuerySchema = z.object({ network: z.string().min(1) });
export const ConsentStatusResponseSchema = z.object({
  statuses: z.object({
    terms: z.array(z.number().int()),
    privacy: z.array(z.number().int()),
  }),
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
