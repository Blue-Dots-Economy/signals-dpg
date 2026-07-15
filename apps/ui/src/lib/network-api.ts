import type { FetchItemsQuery, FetchItemsResponse, ItemLocation } from './item-api';
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
// to 5000 when unset, empty, or invalid. Mirrors `resolveProfileFetchLimit`.
const DEFAULT_MAP_FETCH_LIMIT = 5000;

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
  // NOTE: no existing fetcher in this file serializes an object-shaped query
  // param, so there is no established encoding to mirror. Serialized as a
  // JSON string here per #203 P4 Task 3 brief; the server's `fastify-qs`
  // query parser does not itself JSON-decode string values, so the
  // `MarkersQuerySchema.item_state` (a `z.record`) will reject this as-is.
  // Whoever wires this fetcher up (Task 6+) needs to either add a
  // JSON-string preprocess to `MarkersQuerySchema.item_state` server-side, or
  // switch to bracket-notation (`qs`-style) serialization here. Left
  // unresolved intentionally — this task is additive/no-consumers.
  if (query.item_state !== undefined) {
    params.set('item_state', JSON.stringify(query.item_state));
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
