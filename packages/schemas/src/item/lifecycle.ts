import { z } from 'zod';

export const ItemLifecycleBody = z.object({
  item_id: z.uuid(),
  action: z.enum(['pause', 'unpause', 'retire']),
});

export const ItemLifecycleResponse = z.object({
  item_id: z.uuid(),
  lifecycle_status: z.enum(['draft', 'live', 'paused', 'retired']),
});

export type ItemLifecycleBody = z.infer<typeof ItemLifecycleBody>;
export type ItemLifecycleResponse = z.infer<typeof ItemLifecycleResponse>;
