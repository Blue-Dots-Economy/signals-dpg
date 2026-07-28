import { randomUUID } from 'node:crypto';
import z from '@dpg/schemas';
import { signalsSearchConfig } from '@/config';

/**
 * Client for the signals-search `/v1/search` service (#203 List PR, discover
 * BFF). signals-search cannot be run locally — every test mocks this module
 * or its `fetch` call rather than hitting a real instance.
 *
 * Envelope shape confirmed from the signals-search repo (`src/api/schemas.ts`
 * + `openapi.json`, see `.superpowers/sdd/progress.md`): a Beckn-style
 * `context`/`message` request, single `s_dwithin` spatial clause max, filter
 * clauses targeting `item_state.<field>`.
 *
 * Response shape revised for signals-search PR #87: `/v1/search` now returns
 * the FULL item row per result (not just `item_id` + masked `item_state`), so
 * the discover BFF (`discover.ts`) maps each result directly to the DPG item
 * response shape — no local-DB hydrate/re-read by id.
 */

const SIGNALS_SEARCH_TIMEOUT_MS = 5000;
const MAX_PAGE_SIZE = 100;

export type FacetValue = string | number | boolean;

export interface SignalsSearchFacetInput {
  /** Bare field name — the client prefixes it to `item_state.<field>`. */
  field: string;
  values: FacetValue[];
  /**
   * Whether `item_state.<field>` is a JSON Schema array. Multi-value
   * selections on an array field map to `contains_any`; everything else
   * (scalar fields, and any single-value selection) maps to `in`.
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
  limit: number;
  offset: number;
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

const SignalsSearchSpatialClauseSchema = z.object({
  op: z.literal('s_dwithin'),
  geometry: z.object({
    type: z.literal('Point'),
    // GeoJSON order — [lng, lat], not [lat, lng].
    coordinates: z.tuple([z.number(), z.number()]),
  }),
  distanceMeters: z.number().optional(),
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
  // Full item fields (PR #87 on signals-search): `/v1/search` now returns the
  // whole item row, not just id + state, so the discover BFF can map directly
  // to the DPG item response shape without a local-DB hydrate round trip.
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
    }),
  }),
});

export interface SearchSignalsResult {
  items: SignalsSearchItem[];
  meta: { total: number; limit: number; offset: number };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

function clampOffset(offset: number): number {
  return Math.max(Math.trunc(offset), 0);
}

function buildFilterClause(facet: SignalsSearchFacetInput) {
  const useContainsAny = Boolean(facet.arrayValued) && facet.values.length > 1;

  return {
    op: useContainsAny ? ('contains_any' as const) : ('in' as const),
    target: `item_state.${facet.field}`,
    value: facet.values,
  };
}

function buildSpatialClause(input: SearchSignalsInput) {
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

/**
 * Builds the Beckn-envelope request body for `/v1/search`. Exported
 * separately from `searchSignals` so envelope construction (facet/spatial
 * mapping, pagination clamping, messageId presence) is unit-testable without
 * mocking `fetch`.
 */
export function buildSignalsSearchRequest(
  input: SearchSignalsInput
): SignalsSearchRequest {
  const filters = (input.filters ?? []).map(buildFilterClause);
  const spatial = buildSpatialClause(input);

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
 * response, or an invalid response body — this task's BFF (discover.ts)
 * catches and converts that into a clean error reply; the native fallback
 * (Task 3) is what makes a search-service failure non-fatal for callers.
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
    throw new Error(
      `signals-search /v1/search error ${response.status}: ${
        errorBody?.message ?? response.statusText
      }`
    );
  }

  const parsed = SignalsSearchResponseSchema.parse(await response.json());
  return parsed.message;
}
