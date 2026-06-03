import z from 'zod';

export const BulkItemErrorSchema = z.object({
  index: z.number().int().nonnegative(),
  status: z.literal('error'),
  error: z.string().min(1),
  message: z.string(),
});

export const BulkSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/** Build a `{ results, summary }` envelope schema for a given success shape. */
function bulkEnvelope<T extends z.ZodRawShape>(successFields: T) {
  const success = z
    .object({
      index: z.number().int().nonnegative(),
      status: z.literal('success'),
    })
    .extend(successFields);
  return z.object({
    results: z.array(z.union([success, BulkItemErrorSchema])),
    summary: BulkSummarySchema,
  });
}

export const BulkPerformActionResponseSchema = bulkEnvelope({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
  source_item_id: z.string(),
  target_item_id: z.string(),
});

export const BulkUpdateActionStatusResponseSchema = bulkEnvelope({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
});

/** Request-level (non-array / empty / over-limit) error body. */
export const BulkRequestErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
