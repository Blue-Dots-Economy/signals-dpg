import { and, eq, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { mergeItemStateWithPrivate } from '@dpg/schemas';

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
  includePrivateState?: boolean;
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
  item_latitude: items.item_latitude,
  item_longitude: items.item_longitude,
  created_by: items.created_by,
  created_at: items.created_at,
  updated_at: items.updated_at,
};

function buildWhereClause(filters: Omit<ItemFetchFilters, 'limit' | 'offset'>) {
  const conditions = [];

  if (filters.item_id) {
    conditions.push(eq(items.item_id, filters.item_id));
  }

  conditions.push(eq(items.item_network, filters.item_network));
  conditions.push(eq(items.item_domain, filters.item_domain));

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

  if (
    filters.item_latitude !== undefined &&
    filters.item_longitude !== undefined &&
    filters.radius_meters !== undefined
  ) {
    conditions.push(
      sql`
        earth_box(
          ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
          ${filters.radius_meters}
        ) @> ll_to_earth(${items.item_latitude}, ${items.item_longitude})
      `
    );

    conditions.push(
      sql`
        earth_distance(
          ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
          ll_to_earth(${items.item_latitude}, ${items.item_longitude})
        ) <= ${filters.radius_meters}
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

export async function fetchLocalItems(filters: ItemFetchFilters) {
  const whereClause = buildWhereClause(filters);
  const total = await countLocalItems(filters);
  const result = await db
    .select(itemResponseColumns)
    .from(items)
    .where(whereClause)
    .orderBy(sql`${items.created_at} DESC`)
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

      return {
        ...responseItem,
        item_state: filters.includePrivateState
          ? mergeItemStateWithPrivate(item.item_state, item_private_state)
          : item.item_state,
      };
    }),
  };
}
