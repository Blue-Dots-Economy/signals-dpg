import { randomUUID } from 'node:crypto';
import z, { type DiscoverSort } from '@dpg/schemas';
import { signalsSearchConfig } from '@/config';

/**
 * Client for the signals-search `/v1/search` service, used by the discover BFF.
 * Tests mock this module or `fetch`; signals-search cannot run locally.
 *
 * The request is a Beckn-style `context`/`message` envelope with at most one
 * spatial clause and filter clauses targeting `item_state.<field>`. Each
 * result is a full item row, so `discover.ts` maps it to the DPG item shape
 * without re-reading the local DB.
 */

const SIGNALS_SEARCH_TIMEOUT_MS = 5000;
const MAX_PAGE_SIZE = 100;

export type FacetValue = string | number | boolean;

export interface SignalsSearchFacetInput {
  /** Bare field name — the client prefixes it to `item_state.<field>`. */
  field: string;
  values: FacetValue[];
  /**
   * Whether `item_state.<field>` is a JSON Schema array. Array fields always
   * map to `contains_any` (jsonb `?|`), scalar fields to `in`, whatever the
   * selection count: signals-search's `in` compares `item_state->>field`, the
   * array serialised as text, so it never matches an array field.
   */
  arrayValued?: boolean;
}

export interface SearchSignalsInput {
  network: string;
  domain: string;
  itemType: string;
  q?: string;
  filters?: SignalsSearchFacetInput[];
  lat?: number;
  lng?: number;
  distanceMeters?: number;
  /**
   * Viewport rectangle the map is showing. Mutually exclusive with
   * `lat`/`lng`/`distanceMeters`; all four bounds are set or none, enforced by
   * `DiscoverItemsBodySchema`.
   */
  minLat?: number;
  minLng?: number;
  maxLat?: number;
  maxLng?: number;
  limit: number;
  offset: number;
  /**
   * The viewer's own profile `item_id`, sent as `intent.item.id` so
   * signals-search ranks results by relevance to that profile. Omitted (not
   * `null`) when there is no anchor.
   */
  anchorItemId?: string;
  /**
   * Forwarded as `intent.sort`. When omitted, signals-search infers the order
   * (cosine → distance → recency).
   */
  sort?: DiscoverSort;
  /**
   * Ordering centre, sent as `intent.orderingCenter`. It orders only and never
   * becomes a spatial filter; named apart from `lat`/`lng` (which filter) so
   * call sites cannot confuse them.
   */
  orderingLat?: number;
  orderingLng?: number;
}

const SignalsSearchFilterClauseSchema = z.object({
  op: z.enum([
    'in',
    'contains_any',
    'eq',
    'neq',
    'contains',
    'gt',
    'gte',
    'lt',
    'lte',
  ]),
  target: z.string(),
  value: z.unknown(),
});

// Discriminated on `op` so adding an op makes the compiler flag every site
// that has to branch on it.
const SignalsSearchSpatialClauseSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('s_dwithin'),
    geometry: z.object({
      type: z.literal('Point'),
      // GeoJSON order — [lng, lat], not [lat, lng].
      coordinates: z.tuple([z.number(), z.number()]),
    }),
    distanceMeters: z.number().optional(),
  }),
  // Named fields rather than a GeoJSON [west,south,east,north] tuple:
  // `orderingCenter` already carries one [lng,lat] transposition hazard and a
  // second was not worth the brevity. camelCase matches signals-search's wire
  // convention; the UI's snake_case `min_lat` etc. map straight across.
  z.object({
    op: z.literal('bbox'),
    minLat: z.number(),
    minLng: z.number(),
    maxLat: z.number(),
    maxLng: z.number(),
  }),
]);

// Separate schema from the spatial clause: signals-search turns `spatial`
// into a hard ST_DWithin predicate, so an ordering centre sent there would
// silently truncate results to the default radius.
const SignalsSearchOrderingCenterSchema = z.object({
  type: z.literal('Point'),
  // GeoJSON order — [lng, lat], not [lat, lng].
  coordinates: z.tuple([z.number(), z.number()]),
});

const SignalsSearchRequestSchema = z.object({
  context: z.object({
    version: z.literal('1.0.0'),
    messageId: z.string(),
    networkId: z.string(),
    domain: z.string(),
    itemType: z.string(),
  }),
  message: z.object({
    intent: z.object({
      textSearch: z.string().optional(),
      filters: z.array(SignalsSearchFilterClauseSchema).optional(),
      spatial: z.array(SignalsSearchSpatialClauseSchema).max(1).optional(),
      item: z.object({ id: z.string() }).optional(),
      // Inside `intent` because signals-search's result cache key hashes the
      // intent; on `message` two different sorts would share a cache entry.
      sort: z.enum(['relevance', 'newest', 'nearest']).optional(),
      orderingCenter: SignalsSearchOrderingCenterSchema.optional(),
    }),
    pagination: z.object({
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
      offset: z.number().int().min(0),
    }),
  }),
});

export type SignalsSearchRequest = z.infer<typeof SignalsSearchRequestSchema>;

const SignalsSearchItemLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  label: z.string().optional(),
});

const SignalsSearchItemSchema = z.object({
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_id: z.string(),
  // Masked public projection — signals-search never sees item_private_state.
  item_state: z.record(z.string(), z.unknown()),
  item_locations: z.array(SignalsSearchItemLocationSchema),
  item_instance_url: z.string().nullable(),
  item_schema_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string().nullable(),
  lifecycle_status: z.string(),
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

export type SignalsSearchItem = z.infer<typeof SignalsSearchItemSchema>;

const SignalsSearchResponseSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  message: z.object({
    items: z.array(SignalsSearchItemSchema),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      // The order signals-search applied. Optional because older
      // signals-search deployments omit it; the BFF then assumes the sort it
      // requested.
      sort_applied: z.enum(['relevance', 'newest', 'nearest']).optional(),
    }),
  }),
});

export interface SearchSignalsResult {
  items: SignalsSearchItem[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    /** Absent from signals-search versions without sort support. */
    sort_applied?: DiscoverSort;
  };
}

/**
 * Thrown by `searchSignals` for a non-2xx `/v1/search` response. Carries the
 * upstream HTTP `status` and `error` code (e.g. `'ANCHOR_NOT_FOUND'` for an
 * unindexed anchor) so the discover BFF can retry without the anchor.
 */
export class SignalsSearchError extends Error {
  status?: number;
  code?: string;
  override name = 'SignalsSearchError';
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

function clampOffset(offset: number): number {
  return Math.max(Math.trunc(offset), 0);
}

function buildFilterClause(facet: SignalsSearchFacetInput) {
  // See SignalsSearchFacetInput.arrayValued for why the op ignores the count.
  const useContainsAny = Boolean(facet.arrayValued);

  return {
    op: useContainsAny ? ('contains_any' as const) : ('in' as const),
    target: `item_state.${facet.field}`,
    value: facet.values,
  };
}

/**
 * The single spatial clause, or none. A bbox wins over a radius; both at once
 * is already rejected by `DiscoverItemsBodySchema`.
 */
function buildSpatialClause(input: SearchSignalsInput) {
  if (
    input.minLat !== undefined &&
    input.minLng !== undefined &&
    input.maxLat !== undefined &&
    input.maxLng !== undefined
  ) {
    return {
      op: 'bbox' as const,
      minLat: input.minLat,
      minLng: input.minLng,
      maxLat: input.maxLat,
      maxLng: input.maxLng,
    };
  }

  if (input.lat === undefined || input.lng === undefined) {
    return undefined;
  }

  return {
    op: 's_dwithin' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [input.lng, input.lat] as [number, number],
    },
    ...(input.distanceMeters !== undefined
      ? { distanceMeters: input.distanceMeters }
      : {}),
  };
}

// Kept apart from `buildSpatialClause` so an ordering centre can never become
// an `s_dwithin` clause.
function buildOrderingCenter(input: SearchSignalsInput) {
  if (input.orderingLat === undefined || input.orderingLng === undefined) {
    return undefined;
  }

  return {
    type: 'Point' as const,
    coordinates: [input.orderingLng, input.orderingLat] as [number, number],
  };
}

/**
 * Builds the `/v1/search` request body. Exported so envelope construction is
 * testable without mocking `fetch`.
 */
export function buildSignalsSearchRequest(
  input: SearchSignalsInput
): SignalsSearchRequest {
  const filters = (input.filters ?? []).map(buildFilterClause);
  const spatial = buildSpatialClause(input);
  const orderingCenter = buildOrderingCenter(input);

  return SignalsSearchRequestSchema.parse({
    context: {
      version: '1.0.0',
      messageId: randomUUID(),
      networkId: input.network,
      domain: input.domain,
      itemType: input.itemType,
    },
    message: {
      intent: {
        ...(input.q ? { textSearch: input.q } : {}),
        ...(filters.length > 0 ? { filters } : {}),
        ...(spatial ? { spatial: [spatial] } : {}),
        ...(input.anchorItemId ? { item: { id: input.anchorItemId } } : {}),
        ...(input.sort ? { sort: input.sort } : {}),
        ...(orderingCenter ? { orderingCenter } : {}),
      },
      pagination: {
        limit: clampLimit(input.limit),
        offset: clampOffset(input.offset),
      },
    },
  });
}

/**
 * Calls signals-search `/v1/search`. Throws on missing config, a non-2xx
 * response (`SignalsSearchError`), a timeout, or an invalid response body;
 * the discover BFF catches these and falls back to the native item fetch.
 */
export async function searchSignals(
  input: SearchSignalsInput
): Promise<SearchSignalsResult> {
  if (!signalsSearchConfig.url || !signalsSearchConfig.api_key) {
    throw new Error(
      'signals-search is not configured (SIGNALS_SEARCH_URL/SIGNALS_SEARCH_API_KEY unset)'
    );
  }

  const requestBody = buildSignalsSearchRequest(input);
  const target = new URL('/v1/search', signalsSearchConfig.url);

  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': signalsSearchConfig.api_key,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(SIGNALS_SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    const searchError = new SignalsSearchError(
      `signals-search /v1/search error ${response.status}: ${
        errorBody?.message ?? response.statusText
      }`
    );
    searchError.status = response.status;
    searchError.code = errorBody?.error;
    throw searchError;
  }

  const parsed = SignalsSearchResponseSchema.parse(await response.json());
  return parsed.message;
}
