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

/**
 * Explicit list ordering (#644). Optional on the wire: the BFF defaults it
 * (`relevance` when an anchor is sent, else `newest`) and always reports what
 * it actually applied via `meta.sort_applied`, so the UI can never claim an
 * order it did not get.
 *
 * `relevance` = cosine against the anchor (or the typed text when there is no
 * anchor); `newest` = `items.created_at DESC` (NOT `item_search.indexed_at`,
 * which is an ingestion artifact); `nearest` = distance ascending with NO
 * radius bound.
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
  // AREA FILTER, opt-in (#644). Sent ONLY in `radius` area mode; the default
  // `anywhere` mode sends none of the three, so no spatial clause is built and
  // the list spans the whole network. There is no `area_mode` field — absence
  // IS `anywhere`.
  //
  // Before #644 the UI forwarded the resolved viewer location unconditionally
  // and signals-search treats a spatial clause as a hard `s_dwithin`
  // predicate, so every signed-in viewer with a location silently saw only
  // items within ~30 km, with no control to widen it.
  item_latitude: z.number().min(-90).max(90).optional(),
  item_longitude: z.number().min(-180).max(180).optional(),
  distance_meters: z.number().positive().optional(),
  // ORDERING CENTRE for `sort: 'nearest'` — DISTINCT from the area filter
  // above. Sending only these two orders the whole network nearest-first
  // WITHOUT bounding the candidate set, which is exactly the capability #644
  // needs: location may sort, but must not truncate. Never contributes a
  // spatial clause, and never sets `meta.distance_meters`.
  ordering_latitude: z.number().min(-90).max(90).optional(),
  ordering_longitude: z.number().min(-180).max(180).optional(),
  // The viewer's own profile item_id (#394), forwarded to signals-search as
  // the Beckn `intent.item.id` anchor for profile-relevance ranking. Optional
  // — omitted entirely means "no anchor," not ranked-by-relevance-to-nothing.
  anchor_item_id: z.string().uuid().optional(),
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
).refine(
  (data) =>
    (data.ordering_latitude === undefined) === (data.ordering_longitude === undefined),
  {
    message: 'ordering_latitude and ordering_longitude must be provided together',
    path: ['ordering_longitude'],
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
    // Effective spatial radius (meters, #394) actually applied to this
    // search — the configured `SIGNALS_SEARCH_DISTANCE_METERS` env, the
    // request's own `distance_meters` override, or DEFAULT_SEARCH_DISTANCE_METERS
    // when neither is set (mirroring signals-search's own default).
    //
    // #644: present ONLY when an AREA FILTER was actually applied (the request
    // carried `item_latitude`/`item_longitude`). It previously keyed off "a
    // location was sent", which conflated filtering with ordering — an
    // ordering centre bounds nothing, so reporting a radius for one would be a
    // lie and would make the UI print a "within X km" note for an unbounded
    // search.
    distance_meters: z.number().optional(),
    // The order actually applied, after the BFF's defaulting and fallbacks
    // (#644). Always present. A `relevance` request with neither an anchor nor
    // typed text degrades to `newest`, so the UI must label from THIS rather
    // than from what it asked for.
    sort_applied: DiscoverSortSchema,
  }),
  items: DiscoverResponseItemSchema.array(),
});
