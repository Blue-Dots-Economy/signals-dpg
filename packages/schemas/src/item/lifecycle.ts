import { z } from 'zod';

export const ItemLifecycleBody = z.object({
  item_id: z.uuid(),
  action: z.enum(['pause', 'unpause']),
});

export const ItemLifecycleResponse = z.object({
  item_id: z.uuid(),
  lifecycle_status: z.enum(['draft', 'live', 'paused']),
  completion_pct: z.number().int().min(0).max(100),
  cancelled_pending_actions: z.number().int().nonnegative(),
});

export type ItemLifecycleBody = z.infer<typeof ItemLifecycleBody>;
export type ItemLifecycleResponse = z.infer<typeof ItemLifecycleResponse>;
