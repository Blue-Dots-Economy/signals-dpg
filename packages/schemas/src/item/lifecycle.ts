import { z } from 'zod';

export const ItemLifecycleBodySchema = z.object({
  item_id: z.uuid(),
  action: z.enum(['pause', 'unpause']),
});

export const ItemLifecycleResponseSchema = z.object({
  item_id: z.string(),
  lifecycle_status: z.enum(['draft', 'live', 'paused']),
  completion_pct: z.number().int().min(0).max(100),
  cancelled_pending_actions: z.number().int().nonnegative(),
});

export type ItemLifecycleBody = z.infer<typeof ItemLifecycleBodySchema>;
export type ItemLifecycleResponse = z.infer<typeof ItemLifecycleResponseSchema>;
