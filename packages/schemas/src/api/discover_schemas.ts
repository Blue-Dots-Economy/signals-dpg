import z from 'zod';
import { ItemResponseSchema } from './item_schemas';

/**
 * Public `/network/item/discover` BFF. Ranks via signals-search `/v1/search`,
 * whose results carry the full item row and are mapped directly to the item
 * response shape. Live items only. Field names follow `FetchItemsBodySchema` /
 * `MarkersBodySchema`.
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

/**
 * List ordering. When omitted the BFF defaults to `relevance` if an anchor or
 * `q` is sent, else `newest`; `meta.sort_applied` reports what was applied.
 *
 * `relevance` = cosine against the anchor (or the typed text when there is no
 * anchor); `newest` = `items.created_at DESC` (not `item_search.indexed_at`,
 * an ingestion artifact); `nearest` = distance ascending with no radius bound.
 */
export const DiscoverSortSchema = z.enum(['relevance', 'newest', 'nearest']);
export type DiscoverSort = z.infer<typeof DiscoverSortSchema>;

const DiscoverItemsBodyBase = z.object({
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  q: z.string().trim().min(1).optional(),
  filters: z.array(DiscoverFacetFilterSchema).optional(),
  sort: DiscoverSortSchema.optional(),
  // Radius area filter (with `distance_meters`). signals-search applies a
  // spatial clause as a hard `s_dwithin` predicate, so send these only to
  // bound the list; omitting all three spans the whole network.
  item_latitude: z.number().min(-90).max(90).optional(),
  item_longitude: z.number().min(-180).max(180).optional(),
  // Viewport area filter: the exact rectangle the map shows. Mutually
  // exclusive with the radius filter (see the refine below).
  min_lat: z.number().min(-90).max(90).optional(),
  min_lng: z.number().min(-180).max(180).optional(),
  max_lat: z.number().min(-90).max(90).optional(),
  max_lng: z.number().min(-180).max(180).optional(),
  distance_meters: z.number().positive().optional(),
  // Ordering centre for `sort: 'nearest'`, separate from the area filters: it
  // orders without bounding the candidate set, and never sets
  // `meta.distance_meters`.
  ordering_latitude: z.number().min(-90).max(90).optional(),
  ordering_longitude: z.number().min(-180).max(180).optional(),
  // The viewer's own profile item_id, forwarded to signals-search as the Beckn
  // `intent.item.id` anchor for profile-relevance ranking.
  anchor_item_id: z.string().uuid().optional(),
  // Matches the signals-search /v1/search page limit; oversized requests are
  // rejected rather than clamped.
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const DiscoverItemsBodySchema = DiscoverItemsBodyBase.refine(
  (data) => (data.item_latitude === undefined) === (data.item_longitude === undefined),
  {
    message: 'item_latitude and item_longitude must be provided together',
    path: ['item_longitude'],
  }
).refine(
  (data) =>
    (data.ordering_latitude === undefined) === (data.ordering_longitude === undefined),
  {
    message: 'ordering_latitude and ordering_longitude must be provided together',
    path: ['ordering_longitude'],
  }
)
  .refine(
    (data) => {
      const sides = [data.min_lat, data.min_lng, data.max_lat, data.max_lng];
      const given = sides.filter((v) => v !== undefined).length;
      // A partial box is rejected, never defaulted: a defaulted side would
      // search an area the caller did not ask about.
      return given === 0 || given === 4;
    },
    {
      message: 'min_lat, min_lng, max_lat and max_lng must be provided together',
      path: ['max_lng'],
    }
  )
  .refine(
    (data) =>
      data.min_lat === undefined ||
      data.max_lat === undefined ||
      data.min_lng === undefined ||
      data.max_lng === undefined ||
      (data.min_lat < data.max_lat && data.min_lng < data.max_lng),
    {
      // A transposed box is rejected rather than swapped, since it is a caller
      // bug. This also rejects antimeridian crossings, which signals-search
      // does not support.
      message:
        'min_lat must be less than max_lat and min_lng less than max_lng (antimeridian crossing is not supported)',
      path: ['min_lng'],
    }
  )
  .refine(
    (data) =>
      data.min_lat === undefined ||
      (data.item_latitude === undefined && data.distance_meters === undefined),
    {
      // signals-search accepts one spatial clause; caught here so the caller
      // gets a message naming both modes.
      message: 'a bounding box and a radius are mutually exclusive area modes',
      path: ['min_lat'],
    }
  );

// signals-search returns a serialized copy of the item (ISO date strings, and
// nullable item_instance_url/item_schema_url/created_by), so those fields are
// widened. `z.coerce.date()` accepts the strings and serializes back to the
// same ISO format as a native row.
export const DiscoverResponseItemSchema = ItemResponseSchema.extend({
  item_instance_url: z.string().nullable(),
  item_schema_url: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  // Optional so a row missing it cannot turn the outage fallback into a
  // serialization 500.
  lifecycle_status: z.string().optional(),
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

// When signals-search throws, times out or is unconfigured, the BFF falls back
// to the native item fetch (`native_fallback`, `degraded: true`) so an outage
// never surfaces as a 5xx. `q` and `filters` still apply there (`q` to local
// rows only); only relevance ranking is lost.
export const DiscoverSourceSchema = z.enum(['signals_search', 'native_fallback']);

export const DiscoverResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    source: DiscoverSourceSchema,
    degraded: z.boolean(),
    // Radius in meters applied to this search: the request's
    // `distance_meters`, else SIGNALS_SEARCH_DISTANCE_METERS, else the
    // signals-search default. Present only when a radius area filter was
    // applied (`item_latitude`/`item_longitude`); absent for viewport and
    // ordering-only requests.
    distance_meters: z.number().optional(),
    // The order actually applied after defaulting and fallbacks; the UI labels
    // the list from this, not from what it requested. Absent means unknown: an
    // older signals-search ignores `intent.sort` and does not report it, and
    // the api and search images are versioned independently.
    sort_applied: DiscoverSortSchema.optional(),
    /**
     * Whether the request's `anchor_item_id` was used for this result. False
     * when no anchor was sent, when the native fallback served the request, or
     * when signals-search rejected the anchor and the BFF retried without it.
     *
     * The retry otherwise looks like a normal 200, but on signals-search a
     * typed `q` filters only when an anchor accompanies it and merely ranks
     * otherwise, so `false` means the page is not text-filtered. A profile
     * whose populated fields are all private has no embedding, so its anchor
     * is rejected.
     */
    anchor_applied: z.boolean(),
  }),
  items: DiscoverResponseItemSchema.array(),
});
