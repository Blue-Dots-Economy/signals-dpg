import { items } from '@dpg/database';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import z from 'zod';
export const ItemSelectSchema = createSelectSchema(items);
export const ItemResponseSchema = ItemSelectSchema.omit({
  item_private_state: true,
}).extend({
  // aggregator_id is nullable in the DB and absent from responses of pre-aggregator
  // peer instances; accept both null and undefined during cross-instance rollout.
  aggregator_id: z.uuid().nullish(),
});
export const ItemInsertSchema = createInsertSchema(items);
export const ItemSnapshotSchema = ItemResponseSchema.omit({
  created_by: true,
  created_at: true,
  updated_at: true,
});

export const CreateItemBodySchema = ItemInsertSchema.omit({
  created_by: true,
  item_id: true,
  item_instance_url: true,
  item_schema_url: true,
  item_private_state: true,
  created_at: true,
  updated_at: true,
}).extend({
  created_by: z.string().min(1).optional(),
});

const FetchItemsSchemaBase = z.object({
  item_id: z.uuid().optional(),
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1).optional(),

  item_instance_url: z.url().nullable().optional(),

  item_schema_url: z.url().nullable().optional(),

  /** Filter to items produced by a single aggregator (provenance scope). */
  aggregator_id: z.uuid().optional(),

  item_state: z.record(z.string(), z.unknown()).optional(),
  item_latitude: z.coerce.number().optional(),
  item_longitude: z.coerce.number().optional(),
  radius_meters: z.coerce.number().positive().optional(),

  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  cache_ttl_seconds: z.coerce.number().int().positive().optional(),
});

type FetchItemsSchemaShape = z.infer<typeof FetchItemsSchemaBase>;

function withGeoSearchRefinement<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (rawData) => {
      const data = rawData as Partial<FetchItemsSchemaShape>;
      const hasCoordinates =
        data.item_latitude !== undefined || data.item_longitude !== undefined;

      if (!hasCoordinates) {
        return true;
      }

      return (
        data.item_latitude !== undefined &&
        data.item_longitude !== undefined &&
        data.radius_meters !== undefined
      );
    },
    {
      message:
        'item_latitude, item_longitude, and radius_meters must be provided together for geosearch',
      path: ['radius_meters'],
    }
  );
}

export const FetchItemsQuerySchema = withGeoSearchRefinement(FetchItemsSchemaBase);

export const FetchItemsCountBodySchema = withGeoSearchRefinement(
  FetchItemsSchemaBase.omit({
    limit: true,
    offset: true,
    cache_ttl_seconds: true,
  })
);

export const FetchItemsBodySchema = withGeoSearchRefinement(FetchItemsSchemaBase.extend({
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0),
  cache_ttl_seconds: z.number().int().positive().optional(),
}));

export const UpdateItemParamsSchema = z.object({
  itemId: z.uuid(),
});

export const UpdateItemBodySchema = ItemInsertSchema.omit({
  created_by: true,
  item_network: true,
  item_domain: true,
  item_type: true,
  item_id: true,
  item_private_state: true,
  created_at: true,
  updated_at: true,
})
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });
