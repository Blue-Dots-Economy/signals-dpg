import type { FetchItemsQuery, FetchItemsResponse, Item, ItemLocation } from './item-api';
import type { DotNetworkSchema } from '../engine/types';
import { createApiClient } from './api-client';
import { getRuntimeEnv } from '@/lib/runtime-env';

interface CachedSchemaEntry {
  cache_key: string;
  kind: 'network_config' | 'domain_item_schema' | 'instance_custom_item_schema' | 'item_schema_url' | 'consent_config';
  network?: string;
  domain?: string;
  item_type?: string;
  schema_url?: string;
  brand?: string;
  schema: DotNetworkSchema;
}

const networkApiClient = createApiClient();

// Page size for network-wide profile browse fetches (home page and the tourist
// UI). Override via runtime `VITE_PROFILE_FETCH_LIMIT`; falls back to 1000 when
// unset or invalid.
const DEFAULT_PROFILE_FETCH_LIMIT = 1000;

export function resolveProfileFetchLimit(): number {
  const raw = getRuntimeEnv('VITE_PROFILE_FETCH_LIMIT');
  if (raw === undefined || raw === '') return DEFAULT_PROFILE_FETCH_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROFILE_FETCH_LIMIT;
  return parsed;
}

export const PROFILE_FETCH_LIMIT = resolveProfileFetchLimit();

const DEFAULT_PROFILE_PAGE_SIZE = 50;

export function resolveProfilePageSize(): number {
  const raw = import.meta.env.VITE_PROFILE_PAGE_SIZE;
  if (raw === undefined || raw === '') return DEFAULT_PROFILE_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROFILE_PAGE_SIZE;
  return parsed;
}

export const PROFILE_PAGE_SIZE = resolveProfilePageSize();

// Cap for map-viewport marker fetches. Override via build-time
// `VITE_MAP_FETCH_LIMIT`; falls back to 25000. Must not exceed the server
// markers cap (25000 in `packages/schemas`) or the request is rejected.
const DEFAULT_MAP_FETCH_LIMIT = 25000;

export function resolveMapFetchLimit(): number {
  const raw = import.meta.env.VITE_MAP_FETCH_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_MAP_FETCH_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAP_FETCH_LIMIT;
  return parsed;
}

export const MAP_FETCH_LIMIT = resolveMapFetchLimit();

export interface FetchNetworkItemsQuery
  extends Omit<FetchItemsQuery, 'created_by_me'> {
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  cache_ttl_seconds?: number;
}

export async function fetchNetworkItems(
  query: FetchNetworkItemsQuery,
  signal?: AbortSignal
): Promise<FetchItemsResponse> {
  const params = new URLSearchParams();

  params.set('item_network', query.item_network);
  params.set('item_domain', query.item_domain);

  if (query.item_type) params.set('item_type', query.item_type);
  if (query.item_id) params.set('item_id', query.item_id);
  if (query.item_instance_url) {
    params.set('item_instance_url', query.item_instance_url);
  }
  if (query.item_schema_url) params.set('item_schema_url', query.item_schema_url);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.item_latitude !== undefined) {
    params.set('item_latitude', String(query.item_latitude));
  }
  if (query.item_longitude !== undefined) {
    params.set('item_longitude', String(query.item_longitude));
  }
  if (query.radius_meters !== undefined) {
    params.set('radius_meters', String(query.radius_meters));
  }
  if (query.cache_ttl_seconds !== undefined) {
    params.set('cache_ttl_seconds', String(query.cache_ttl_seconds));
  }

  const response = await networkApiClient.get<FetchItemsResponse>(
    '/api/v1/network/item/fetch',
    { params, signal }
  );
  return response.data;
}

export interface Marker {
  item_id: string;
  item_domain: string;
  item_instance_url: string | null;
  item_locations: ItemLocation[];
}

export interface MarkersResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
    partial: boolean;
    unavailable_instances: string[];
  };
  markers: Marker[];
}

export interface FetchNetworkMarkersQuery {
  item_network: string;
  item_domain: string;
  item_type?: string;
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  /**
   * Bbox alternative to `item_latitude`/`item_longitude`/`radius_meters`; the
   * server rejects both together. The map sends the bbox; the list's distance
   * path and the tourist app send the radius params.
   */
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  /**
   * Facet filter, one entry per `item_state.<field>`. A value is a scalar or a
   * `string[]` (multi-select), serialized below as repeated params.
   */
  item_state?: Record<string, unknown>;
  /** Free-text search over public `item_state` fields, scoped to the viewport. */
  q?: string;
  limit?: number;
  offset?: number;
  cache_ttl_seconds?: number;
}

export async function fetchNetworkMarkers(
  query: FetchNetworkMarkersQuery,
  signal?: AbortSignal
): Promise<MarkersResponse> {
  const params = new URLSearchParams();

  params.set('item_network', query.item_network);
  params.set('item_domain', query.item_domain);

  if (query.item_type) params.set('item_type', query.item_type);
  if (query.item_latitude !== undefined) {
    params.set('item_latitude', String(query.item_latitude));
  }
  if (query.item_longitude !== undefined) {
    params.set('item_longitude', String(query.item_longitude));
  }
  if (query.radius_meters !== undefined) {
    params.set('radius_meters', String(query.radius_meters));
  }
  if (query.min_lat !== undefined) params.set('min_lat', String(query.min_lat));
  if (query.min_lng !== undefined) params.set('min_lng', String(query.min_lng));
  if (query.max_lat !== undefined) params.set('max_lat', String(query.max_lat));
  if (query.max_lng !== undefined) params.set('max_lng', String(query.max_lng));
  // Serialize item_state as qs bracket notation (`item_state[field]=value`),
  // which the server's `fastify-qs` parser decodes into the nested object
  // `MarkersQuerySchema.item_state` accepts. A scalar becomes one param (a
  // jsonb containment filter server-side). An array must reach the server as a
  // real array, so the same key is appended once per value; `qs` turns
  // repeated keys back into `string[]` for the `= ANY(...)` facet filter.
  // `String(array)` would send an inert comma-joined string.
  if (query.item_state !== undefined) {
    for (const [field, value] of Object.entries(query.item_state)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          params.append(`item_state[${field}]`, String(v));
        }
      } else {
        params.set(`item_state[${field}]`, String(value));
      }
    }
  }
  if (query.q) params.set('q', query.q);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.cache_ttl_seconds !== undefined) {
    params.set('cache_ttl_seconds', String(query.cache_ttl_seconds));
  }

  const response = await networkApiClient.get<MarkersResponse>(
    '/api/v1/network/item/markers',
    { params, signal }
  );
  return response.data;
}

// The discover BFF's per-field facet selection, mirroring
// `DiscoverFacetFilterSchema` in `packages/schemas`. The BFF re-validates the
// field against the schema's declared, non-private facets and picks the match
// op itself, so the client only sends the raw value set.
export interface DiscoverFacetFilter {
  field: string;
  values: (string | number | boolean)[];
}

export interface FetchDiscoverQuery {
  item_network: string;
  item_domain: string;
  item_type: string;
  q?: string;
  filters?: DiscoverFacetFilter[];
  item_latitude?: number;
  item_longitude?: number;
  distance_meters?: number;
  // Viewport area mode: the exact rectangle the map shows. Mutually exclusive
  // with the radius trio above; all four travel or none do (else 400).
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  limit?: number;
  offset?: number;
  // The active profile's item id, sent as `anchor_item_id`; the BFF maps it to
  // `intent.item.id` for signals-search relevance-to-profile ranking.
  anchor_item_id?: string;
  // Optional; the BFF defaults it and reports what it applied in `meta.sort_applied`.
  sort?: DiscoverSortMode;
  // The ordering centre for `sort: 'nearest'`. Unlike `item_latitude`/
  // `item_longitude` (the area filter), these order the whole network
  // nearest-first without bounding it.
  ordering_latitude?: number;
  ordering_longitude?: number;
}

export type DiscoverSource = 'signals_search' | 'native_fallback';

export type DiscoverSortMode = 'relevance' | 'newest' | 'nearest';

export interface DiscoverResponse {
  items: Item[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    source: DiscoverSource;
    degraded: boolean;
    // Effective radius in meters applied to the search; present only when the
    // request carried a location. Used for the "within X km" list note.
    distance_meters?: number;
    // The order the server actually applied. The UI labels from this, never
    // from what it requested. Absent means unknown; do not default it to the
    // requested sort.
    sort_applied?: DiscoverSortMode;
    /**
     * Whether the sent `anchor_item_id` was used (false when none was sent).
     *
     * A typed `q` filters only alongside an anchor and merely ranks without
     * one, so a rejected anchor turns a filtered answer into an unfiltered one.
     * signals-search rejects an anchor whose profile has only private fields
     * (nothing to embed), which is a normal state, not an edge case.
     */
    anchor_applied: boolean;
  };
}

/**
 * The optional fields `fetchDiscover` forwards: an explicit allowlist. A field
 * missing here is silently dropped, so keep it as one named list where an
 * omission is visible. `satisfies` makes a renamed field a build error.
 */
const OPTIONAL_DISCOVER_BODY_KEYS = [
  'q',
  'filters',
  'item_latitude',
  'item_longitude',
  'distance_meters',
  'min_lat',
  'min_lng',
  'max_lat',
  'max_lng',
  'limit',
  'offset',
  'anchor_item_id',
  'sort',
  'ordering_latitude',
  'ordering_longitude',
] as const satisfies readonly (keyof FetchDiscoverQuery)[];

/**
 * Raw cosine → the 0-100 scale the rest of the UI uses.
 *
 * signals-search's `/v1/relevance` (behind match-score, the modal) returns
 * 0-100, but `/v1/search` (behind `/discover`, this feed) returns raw cosine
 * (~0-1). Rescaling happens here, in one place, rather than in the two
 * consumers (`resolveCardMetric`, `seedFromDiscoverScore`). The BFF passes the
 * search backend's score through unchanged so it agrees with signals-search for
 * other consumers. Clamped because cosine can be negative.
 */
function toPercentScale(score: number): number {
  return Math.min(100, Math.max(0, score * 100));
}

/** Discover items carry a relevance score on a different scale — see `toPercentScale`. */
function normalizeDiscoverItemScore(item: Item): Item {
  // A missing score means "never scored"; coercing it to 0 would badge "0%".
  if (typeof item.score !== 'number') return item;
  return { ...item, score: toPercentScale(item.score) };
}

export async function fetchDiscover(
  query: FetchDiscoverQuery,
  signal?: AbortSignal
): Promise<DiscoverResponse> {
  const body: Record<string, unknown> = {
    item_network: query.item_network,
    item_domain: query.item_domain,
    item_type: query.item_type,
  };

  for (const key of OPTIONAL_DISCOVER_BODY_KEYS) {
    const value = query[key];
    // An empty string or empty array counts as "not asked for"; numeric 0
    // does not (`offset: 0` is the first page and must travel).
    if (value === undefined) continue;
    if (value === '' || (Array.isArray(value) && value.length === 0)) continue;
    body[key] = value;
  }

  const response = await networkApiClient.post<DiscoverResponse>(
    '/api/v1/network/item/discover',
    body,
    { signal }
  );
  return {
    ...response.data,
    items: (response.data.items ?? []).map(normalizeDiscoverItemScore),
  };
}

export async function fetchNetworkConfigs(): Promise<DotNetworkSchema[]> {
  const response = await networkApiClient.get<CachedSchemaEntry[]>(
    '/api/v1/network/schemas'
  );
  const configs = response.data.filter((e) => e.kind === 'network_config');
  return configs.map((c) => c.schema);
}

export async function fetchNetworkConfig(
  networkId: string
): Promise<DotNetworkSchema> {
  const response = await networkApiClient.get<CachedSchemaEntry[]>(
    '/api/v1/network/schemas',
    { params: { network: networkId } }
  );
  const config = response.data.find((e) => e.kind === 'network_config');
  if (!config) {
    throw new Error(`Network "${networkId}" not found`);
  }
  return config.schema;
}
