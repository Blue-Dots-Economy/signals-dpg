import z from 'zod';
import { ItemSnapshotSchema } from './item_schemas';

export const MatchScoreRequestSchema = z.object({
  itemA: ItemSnapshotSchema,
  itemB: ItemSnapshotSchema,
});

export const MatchScoreResponseSchema = z.object({
  provider: z.string().min(1),
  score: z.number().finite().optional(),
  band: z.string().min(1).optional(),
  confidence: z.number().finite().optional(),
  version: z.string().min(1).optional(),
  prompt_version: z.string().min(1).optional(),
  model_provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning: z.string().min(1).optional(),
  /**
   * Why `score` is absent on a 200: `not_indexed` (signals-search 404, an
   * item has no embedding yet) or `not_comparable` (409, the items were
   * embedded with different model versions). This schema is the reply
   * serializer, so the field must be declared here or Zod strips it.
   */
  unavailable_reason: z.enum(['not_indexed', 'not_comparable']).optional(),
  signals: z
    .object({
      name: z.string().min(1),
      impact: z.string().min(1),
      summary: z.string().min(1),
    })
    .array()
    .optional(),
  raw_response: z.unknown(),
});
