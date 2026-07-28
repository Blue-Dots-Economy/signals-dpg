import type { FetchItemsQuery, FetchItemsResponse, Item, ItemLocation } from './item-api';
import type { DotNetworkSchema } from '../engine/types';
import { createApiClient } from './api-client';

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

// Default page size for network-wide profile browse fetches (Signals home page
// and the orange-dots tourist UI). Override via `VITE_PROFILE_FETCH_LIMIT`
// (e.g. `"500"`). Falls back to 1000 when unset, empty, or invalid.
const DEFAULT_PROFILE_FETCH_LIMIT = 1000;

export function resolveProfileFetchLimit(): number {
  const raw = import.meta.env.VITE_PROFILE_FETCH_LIMIT;
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

// Default cap for map-viewport marker fetches (Signals map/marker layer,
// #203 P4). Override via `VITE_MAP_FETCH_LIMIT` (e.g. `"2000"`). Falls back
// to 25000 when unset, empty, or invalid. Mirrors `resolveProfileFetchLimit`.
// Must not exceed the server markers cap (`MarkersBodySchema` /
// `MarkersQuerySchema` in `packages/schemas`, currently 25000) or the request
// is rejected.
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
  item_state?: Record<string, unknown>;
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
  // Serialize item_state as qs bracket notation (`item_state[field]=value`),
  // which the server's `fastify-qs` parser decodes to a nested object that
  // `MarkersQuerySchema.item_state` (a `z.record`) accepts and buildWhereClause
  // applies as an `item_state @> jsonb` filter. Single value per field (the map
  // enum filter's single-select case, #203 P4 §D1); multi-value-per-field
  // filtering is a documented follow-up.
  if (query.item_state !== undefined) {
    for (const [field, value] of Object.entries(query.item_state)) {
      params.set(`item_state[${field}]`, String(value));
    }
  }
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

// The discover BFF's per-field facet selection (#203 List PR Task 4). Shape
// mirrors `DiscoverFacetFilterSchema` in `packages/schemas/src/api/discover_schemas.ts`
// exactly (`field` + a non-empty `values` array) — the BFF re-validates the
// field against the schema's declared, non-private facets server-side
// (`resolveAllowedFacetFilters`) and maps the array to an `in`/`contains_any`
// op depending on whether the field itself is array-valued, so the client
// only ever sends the raw value set, never an op.
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
  limit?: number;
  offset?: number;
}

export type DiscoverSource = 'signals_search' | 'native_fallback';

export interface DiscoverResponse {
  items: Item[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    source: DiscoverSource;
    degraded: boolean;
  };
}

/**
 * POST `/api/v1/network/item/discover` (#203 List PR Task 4). Field names
 * mirror the BFF's `DiscoverItemsBodySchema` exactly (`item_latitude`/
 * `item_longitude`/`distance_meters`, `limit`/`offset`), same convention as
 * `fetchNetworkItems`'s query params. `items` are the SAME `Item` shape
 * `fetchNetworkItems` returns — the list renders both uniformly.
 */
export async function fetchDiscover(
  query: FetchDiscoverQuery,
  signal?: AbortSignal
): Promise<DiscoverResponse> {
  const body: Record<string, unknown> = {
    item_network: query.item_network,
    item_domain: query.item_domain,
    item_type: query.item_type,
  };

  if (query.q) body.q = query.q;
  if (query.filters !== undefined && query.filters.length > 0) body.filters = query.filters;
  if (query.item_latitude !== undefined) body.item_latitude = query.item_latitude;
  if (query.item_longitude !== undefined) body.item_longitude = query.item_longitude;
  if (query.distance_meters !== undefined) body.distance_meters = query.distance_meters;
  if (query.limit !== undefined) body.limit = query.limit;
  if (query.offset !== undefined) body.offset = query.offset;

  const response = await networkApiClient.post<DiscoverResponse>(
    '/api/v1/network/item/discover',
    body,
    { signal }
  );
  return response.data;
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
