import { items } from '@dpg/database';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import z from 'zod';

const ItemLocationPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().optional(),
});
export const ItemLocationsArray = z.array(ItemLocationPoint);

export const ItemSelectSchema = createSelectSchema(items);
export const ItemResponseSchema = ItemSelectSchema.omit({
  item_private_state: true,
}).extend({
  // Kept optional deliberately: response paths that do not project this column
  // (e.g. browse/fetch without lifecycle filter) must not cause a serialization 500.
  lifecycle_status: z.enum(['draft', 'live', 'paused', 'retired']).optional(),
  item_locations: ItemLocationsArray,
});
export const ItemInsertSchema = createInsertSchema(items);
// ItemSnapshotSchema is the contract sent to the external match-score scorer.
// The scorer knows nothing about item_locations — it expects flat scalar coords
// (item_latitude / item_longitude). The UI derives these from item_locations[0]
// before calling the API (see apps/ui/src/lib/match-score-api.ts itemToSnapshot).
export const ItemSnapshotSchema = ItemResponseSchema.omit({
  created_by: true,
  created_at: true,
  updated_at: true,
  item_locations: true,
}).extend({
  item_latitude: z.number().min(-90).max(90).nullable().optional(),
  item_longitude: z.number().min(-180).max(180).nullable().optional(),
});

export const CreateItemBodySchema = ItemInsertSchema.omit({
  created_by: true,
  item_id: true,
  item_instance_url: true,
  item_schema_url: true,
  item_private_state: true,
  created_at: true,
  updated_at: true,
  lifecycle_status: true,
}).extend({
  // Optional override used by admin / service callers to author items on
  // behalf of another user. Non-admin callers cannot supply this — see
  // create_item.ts.
  created_by: z.string().min(1).optional(),
  item_locations: ItemLocationsArray.optional(),
  consent: z
    .object({
      category: z.literal('profile_creation'),
      version: z.number().int().min(1),
      brand: z.string().min(1).nullish(),
    })
    .optional(),
});

const FetchItemsSchemaBase = z.object({
  item_id: z.uuid().optional(),
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1).optional(),

  item_instance_url: z.url().nullable().optional(),

  item_schema_url: z.url().nullable().optional(),

  item_state: z.record(z.string(), z.unknown()).optional(),
  item_latitude: z.coerce.number().optional(),
  item_longitude: z.coerce.number().optional(),
  radius_meters: z.coerce.number().positive().optional(),

  limit: z.coerce.number().int().min(1).max(1000).default(20),
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
  limit: z.number().int().min(1).max(1000),
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
  lifecycle_status: true,
})
  .extend({
    item_locations: ItemLocationsArray.optional(),
  })
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });
