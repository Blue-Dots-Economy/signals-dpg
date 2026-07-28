import z from 'zod';
import { ItemResponseSchema } from './item_schemas';

/**
 * Public `/network/item/discover` BFF (#203 List PR, P-follow-3). Ranks via
 * signals-search `/v1/search` then hydrates full item rows locally
 * (see `apps/api/src/routes/v1/network/item/discover.ts`) — single-instance,
 * live-only, so unlike `/network/item/fetch` there is no cross-instance
 * `partial`/`unavailable_instances` in the response meta.
 *
 * Field naming mirrors the existing `FetchItemsBodySchema` /
 * `MarkersBodySchema` convention (`item_latitude`/`item_longitude`,
 * `limit`/`offset`) rather than inventing new camelCase names, so the UI's
 * discover client reads like its native browse/marker counterparts.
 */
export const DiscoverFacetValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

export const DiscoverFacetFilterSchema = z.object({
  field: z.string().min(1),
  values: z.array(DiscoverFacetValueSchema).min(1),
});

const DiscoverItemsBodyBase = z.object({
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  q: z.string().trim().min(1).optional(),
  filters: z.array(DiscoverFacetFilterSchema).optional(),
  item_latitude: z.number().min(-90).max(90).optional(),
  item_longitude: z.number().min(-180).max(180).optional(),
  distance_meters: z.number().positive().optional(),
  // Capped at 100 to match the signals-search /v1/search pagination limit —
  // reject oversized requests at the door rather than silently clamping.
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const DiscoverItemsBodySchema = DiscoverItemsBodyBase.refine(
  (data) => (data.item_latitude === undefined) === (data.item_longitude === undefined),
  {
    message: 'item_latitude and item_longitude must be provided together',
    path: ['item_longitude'],
  }
);

export const DiscoverResponseItemSchema = ItemResponseSchema.extend({
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

export const DiscoverResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  items: DiscoverResponseItemSchema.array(),
});
