import z from 'zod';
import { ItemResponseSchema } from './item_schemas';

/**
 * Public `/network/item/discover` BFF (#203 List PR, P-follow-3). Ranks via
 * signals-search `/v1/search`, which (as of signals-search PR #87) returns
 * the full item row per result — this BFF maps each result DIRECTLY to the
 * DPG item response shape (see `apps/api/src/routes/v1/network/item/discover.ts`),
 * no local-DB hydrate/re-read by id. Single-instance, live-only, so unlike
 * `/network/item/fetch` there is no cross-instance `partial`/
 * `unavailable_instances` in the response meta.
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

// Overrides beyond ItemResponseSchema's DB-derived shape: signals-search's
// item is a serialized-over-the-wire copy (ISO date strings, and it declares
// item_instance_url/item_schema_url/created_by as nullable even though the
// local `items` table itself never stores nulls there) rather than a live DB
// row, so those fields are widened here to accept what signals-search
// actually sends. `z.coerce.date()` accepts the ISO strings signals-search
// sends while still serializing back to the same wire format as a native
// Date-typed row (JSON.stringify(Date) => ISO string), so the UI sees an
// identical shape either way.
export const DiscoverResponseItemSchema = ItemResponseSchema.extend({
  item_instance_url: z.string().nullable(),
  item_schema_url: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  // Optional (defense-in-depth): the base `ItemResponseSchema` keeps
  // `lifecycle_status` optional to avoid a serialization 500 if a row omits it.
  // Both live paths project it today (native `itemResponseColumns`; discover
  // forces `live_only` and signals-search always returns it), but keeping it
  // optional here means a future native path that stops projecting the column
  // can't turn the "never 5xx on outage" fallback into a serialization 500.
  lifecycle_status: z.string().optional(),
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

// `source`/`degraded` (#203 List PR, Task 3): signals-search is the happy
// path; when it throws, times out, or is unconfigured, the BFF falls back to
// the native `/network/item/fetch` path (distance/recency ordered) so a
// search-service outage never surfaces as a 5xx. The native fallback has no
// server-side facet/text-search support, so `q`/`filters` are NOT applied
// when `source === 'native_fallback'` — the UI (Task 6) uses this flag,
// together with whether it sent `q`/`filters`, to decide between a subtle
// note (no filters requested) and a banner ("filters temporarily
// unavailable").
export const DiscoverSourceSchema = z.enum(['signals_search', 'native_fallback']);

export const DiscoverResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    source: DiscoverSourceSchema,
    degraded: z.boolean(),
  }),
  items: DiscoverResponseItemSchema.array(),
});
