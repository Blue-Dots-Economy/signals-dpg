import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from './item_decrypt';

export type ItemFetchFilters = {
  item_id?: string;
  item_network: string;
  item_domain: string;
  item_type?: string;
  created_by?: string;
  item_instance_url?: string | null;
  item_schema_url?: string | null;
  item_state?: Record<string, unknown>;
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  limit: number;
  offset: number;
  /**
   * When true, the encrypted item_private_state blob is decrypted and merged
   * over item_state. Callers MUST verify ownership/authorization before passing
   * true.
   */
  includePrivateState?: boolean;
  /**
   * When 'live_only', restricts results to items with lifecycle_status = 'live'.
   * Defaults to returning all lifecycle states when undefined.
   */
  lifecycle_filter?: 'live_only' | 'all';
  /**
   * When true, excludes `retired` items (#347). Set by the owner "My Profiles"
   * fetch so a retired profile never lists there. Other reads (e.g. the
   * contact-details masked view) must still be able to see a retired item to
   * message the counterparty, so this is opt-in — NOT a blanket filter.
   */
  exclude_retired?: boolean;
};

const itemResponseColumns = {
  item_network: items.item_network,
  item_domain: items.item_domain,
  item_type: items.item_type,
  item_id: items.item_id,
  item_instance_url: items.item_instance_url,
  item_schema_url: items.item_schema_url,
  item_state: items.item_state,
  item_private_state: items.item_private_state,
  item_locations: items.item_locations,
  created_by: items.created_by,
  created_at: items.created_at,
  updated_at: items.updated_at,
  lifecycle_status: items.lifecycle_status,
};

function buildWhereClause(filters: Omit<ItemFetchFilters, 'limit' | 'offset'>) {
  const conditions = [];

  if (filters.item_id) {
    conditions.push(eq(items.item_id, filters.item_id));
  }

  conditions.push(eq(items.item_network, filters.item_network));
  conditions.push(eq(items.item_domain, filters.item_domain));

  // A retired profile is permanently removed (#347). Opt-in exclusion — the
  // owner "My Profiles" fetch sets this so a retired profile never lists there.
  // Not blanket: contact-details must still resolve a retired item to message
  // the counterparty. Discovery paths already restrict to live via
  // lifecycle_filter, so they're unaffected either way.
  if (filters.exclude_retired) {
    conditions.push(ne(items.lifecycle_status, 'retired'));
  }

  if (filters.item_type) {
    conditions.push(eq(items.item_type, filters.item_type));
  }

  if (filters.created_by) {
    conditions.push(eq(items.created_by, filters.created_by));
  }

  if (filters.item_instance_url) {
    conditions.push(eq(items.item_instance_url, filters.item_instance_url));
  }

  if (filters.item_schema_url) {
    conditions.push(eq(items.item_schema_url, filters.item_schema_url));
  }

  if (filters.item_state) {
    conditions.push(
      sql`${items.item_state} @> ${JSON.stringify(filters.item_state)}::jsonb`
    );
  }

  if (filters.lifecycle_filter === 'live_only') {
    conditions.push(eq(items.lifecycle_status, 'live'));
  }

  if (
    filters.item_latitude !== undefined &&
    filters.item_longitude !== undefined &&
    filters.radius_meters !== undefined
  ) {
    conditions.push(
      sql`
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(${items.item_locations}) loc
          WHERE earth_box(ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}), ${filters.radius_meters})
                  @> ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
            AND earth_distance(ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
                  ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)) <= ${filters.radius_meters}
        )
      `
    );
  }

  return conditions.length ? and(...conditions) : undefined;
}

export async function countLocalItems(
  filters: Omit<ItemFetchFilters, 'limit' | 'offset' | 'includePrivateState'>
) {
  const whereClause = buildWhereClause(filters);
  const [{ count }] = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(items)
    .where(whereClause);

  return Number(count);
}

/**
 * §4.1/§4.3 shared ORDER BY: nearest-first when a lat/lng center is present
 * (ties broken by created_at DESC; no-location rows sort last), otherwise
 * plain created_at DESC. Shared by fetchLocalItems and fetchLocalMarkers so
 * the ordering behavior can never drift between the two projections.
 */
function buildDistanceOrderBy(
  filters: Pick<ItemFetchFilters, 'item_latitude' | 'item_longitude'>
) {
  return filters.item_latitude !== undefined && filters.item_longitude !== undefined
    ? sql`
        (
          SELECT MIN(
            earth_distance(
              ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
              ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
            )
          )
          FROM jsonb_array_elements(${items.item_locations}) loc
        ) ASC NULLS LAST,
        ${items.created_at} DESC
      `
    : sql`${items.created_at} DESC`;
}

const markerColumns = {
  item_id: items.item_id,
  item_domain: items.item_domain,
  item_instance_url: items.item_instance_url,
  item_locations: items.item_locations,
};

export async function fetchLocalItems(filters: ItemFetchFilters) {
  const whereClause = buildWhereClause(filters);
  const total = await countLocalItems(filters);
  const result = await db
    .select(itemResponseColumns)
    .from(items)
    .where(whereClause)
    // Live profiles first, then the shared distance/created ordering within each
    // group — so a live profile floats to the top of "My Profiles" while
    // discovery (live_only) is unaffected (the first key is a no-op there).
    .orderBy(sql`(${items.lifecycle_status} = 'live') DESC, ${buildDistanceOrderBy(filters)}`)
    .limit(filters.limit)
    .offset(filters.offset);

  return {
    meta: {
      total,
      limit: filters.limit,
      offset: filters.offset,
    },
    items: result.map((item) => {
      const { item_private_state, ...responseItem } = item;
      if (!filters.includePrivateState) {
        return responseItem;
      }
      return {
        ...responseItem,
        item_state: decryptItemPrivate({
          item_state: item.item_state,
          item_private_state: item_private_state ?? '',
        }).mergedState,
      };
    }),
  };
}

/**
 * §4.3 slim projection for map markers: item_id/item_domain/item_instance_url/
 * item_locations only. Same WHERE + ORDER BY as fetchLocalItems (via
 * buildWhereClause / buildDistanceOrderBy) so filtering and nearest-first
 * ordering behave identically — just without the heavier item_state payload.
 */
export async function fetchLocalMarkers(filters: ItemFetchFilters) {
  const whereClause = buildWhereClause(filters);
  const total = await countLocalItems(filters);
  const markers = await db
    .select(markerColumns)
    .from(items)
    .where(whereClause)
    .orderBy(buildDistanceOrderBy(filters))
    .limit(filters.limit)
    .offset(filters.offset);

  return {
    meta: {
      total,
      limit: filters.limit,
      offset: filters.offset,
    },
    markers,
  };
}
