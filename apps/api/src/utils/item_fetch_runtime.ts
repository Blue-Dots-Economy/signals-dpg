import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from './item_decrypt';
import { getNetworkConfigById } from '@/network_configs';
import { splitLngRange } from '@/utils/lng_chunks';

/** Minimal pino-compatible surface (`request.log`) for debug-level diagnostics. */
export interface ItemFetchLog {
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

export type ItemFetchFilters = {
  item_id?: string;
  item_network: string;
  item_domain: string;
  item_type?: string;
  created_by?: string;
  item_instance_url?: string | null;
  item_schema_url?: string | null;
  /**
   * Per-field facet filter; a scalar is treated as a one-element array.
   * Only declared, non-private fields are applied; others are dropped
   * silently so a caller cannot enumerate private values.
   * Design: docs/architecture/api-fetch-native-filters.md
   */
  item_state?: Record<string, unknown>;
  /**
   * Free-text substring match. `fields` is the server-resolved allowlist of
   * non-private field keys, never client input; empty `fields` matches nothing.
   */
  text_search?: { q: string; fields: string[] };
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  /**
   * `'distance'` needs coordinates; `'created_at'` ignores them so an area
   * filter can narrow without reordering. Omitted: coordinates present means
   * nearest first (`/network/item/fetch` and markers rely on this).
   */
  order_by?: 'distance' | 'created_at';
  // Bounding-box search, mutually exclusive with the radius params above.
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
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
  /**
   * Excludes `retired` items. Opt-in, because contact-details must still
   * resolve a retired item to message the counterparty.
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

/**
 * Fields a caller may facet-filter on for a network/domain: every declared
 * item-schema property that is not `private: true`, read from network config,
 * never from the request. The private check is the enumeration guard.
 * Fails closed: an unknown network/domain or config error yields an empty set.
 */
async function resolveAllowedFacetFields(
  networkId: string,
  domain: string
): Promise<Set<string>> {
  const allowed = new Set<string>();

  let networkConfig;
  try {
    networkConfig = await getNetworkConfigById(networkId);
  } catch {
    return allowed;
  }

  const domainConfig = networkConfig.domains.find((entry) => entry.id === domain);
  if (!domainConfig) {
    return allowed;
  }

  for (const schema of Object.values(domainConfig.item_schemas)) {
    const properties = (schema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') continue;

    for (const [field, definition] of Object.entries(
      properties as Record<string, unknown>
    )) {
      if (!definition || typeof definition !== 'object') continue;
      const declared = definition as { private?: unknown };
      if (declared.private !== true) {
        allowed.add(field);
      }
    }
  }

  return allowed;
}

/**
 * Whether the signals-search worker has indexed anything for this
 * network+domain. `item_search` is empty where no worker runs, and the bbox
 * branch would then exclude every item. Index-only probe, cheap enough to run
 * per call without a cache.
 */
async function hasSearchIndexRows(
  item_network: string,
  item_domain: string
): Promise<boolean> {
  const result = await db.execute<{ has_rows: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM item_search
      WHERE item_network = ${item_network} AND item_domain = ${item_domain}
    ) AS has_rows
  `);
  const rows: Array<{ has_rows: boolean }> = Array.isArray(result)
    ? (result as Array<{ has_rows: boolean }>)
    : ((result as { rows?: Array<{ has_rows: boolean }> }).rows ?? []);
  return rows[0]?.has_rows === true;
}

async function buildWhereClause(
  filters: Omit<ItemFetchFilters, 'limit' | 'offset'>,
  log?: ItemFetchLog
) {
  const conditions = [];

  if (filters.item_id) {
    conditions.push(eq(items.item_id, filters.item_id));
  }

  conditions.push(eq(items.item_network, filters.item_network));
  conditions.push(eq(items.item_domain, filters.item_domain));

  // Opt-in: contact-details must still resolve a retired item.
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
    // Scalars are normalised to one-element arrays; every entry goes through
    // the same guarded path.
    const facetEntries: Array<[string, unknown[]]> = Object.entries(
      filters.item_state
    ).map(([field, value]) => [field, Array.isArray(value) ? value : [value]]);

    if (facetEntries.length > 0) {
      const allowedFacetFields = await resolveAllowedFacetFields(
        filters.item_network,
        filters.item_domain
      );

      for (const [field, values] of facetEntries) {
        if (!allowedFacetFields.has(field)) {
          log?.debug(
            {
              item_network: filters.item_network,
              item_domain: filters.item_domain,
              field,
            },
            'Dropping item_state facet filter: field is not declared and non-private for this domain'
          );
          continue;
        }

        if (values.length === 0) {
          // An explicit empty value set matches nothing — distinct from
          // "field not present", which applies no restriction at all.
          conditions.push(sql`false`);
          continue;
        }

        const valuesArrayLiteral = sql.join(
          values.map((value) => sql`${value}`),
          sql.raw(', ')
        );

        // `->>` equality covers scalar fields (btree expression indexes); `@>`
        // covers array-typed fields, where `->>` yields the whole array as text
        // (GIN index). One `@>` per value, OR'd: a multi-element `@>` would
        // mean "contains all".
        const arrayContainment = sql.join(
          values.map(
            (value) => sql`${items.item_state} -> ${field} @> to_jsonb(${value}::text)`
          ),
          sql.raw(' OR ')
        );

        conditions.push(
          sql`(${items.item_state} ->> ${field} = ANY(ARRAY[${valuesArrayLiteral}]) OR ${arrayContainment})`
        );
      }
    }
  }

  if (filters.text_search) {
    const { q, fields } = filters.text_search;

    if (fields.length === 0) {
      // No non-private field to match against: unsatisfiable, not match-all.
      conditions.push(sql`false`);
    } else {
      // Escape LIKE metacharacters so `q` is always a literal substring.
      const likePattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const fieldsArrayLiteral = sql.join(
        fields.map((field) => sql`${field}`),
        sql.raw(', ')
      );

      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM jsonb_each_text(${items.item_state}) e
            WHERE e.key = ANY(ARRAY[${fieldsArrayLiteral}])
              AND e.value ILIKE ${likePattern} ESCAPE '\\'
          )
        `
      );
    }
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
  } else if (
    filters.min_lat !== undefined &&
    filters.min_lng !== undefined &&
    filters.max_lat !== undefined &&
    filters.max_lng !== undefined
  ) {
    // `&&` is the GiST pre-filter on the envelope; `ST_Intersects` is the exact
    // recheck for multi-location items. Design: docs/architecture/api-fetch-native-filters.md
    if (filters.min_lat >= filters.max_lat || filters.min_lng >= filters.max_lng) {
      // Inverted/degenerate box: empty result rather than an error.
      conditions.push(sql`false`);
    } else if (await hasSearchIndexRows(filters.item_network, filters.item_domain)) {
      // `::geography` resolves a span wider than 180° as the complement of the
      // box, so longitude is split into narrower chunks, OR'd.
      const lngChunks = splitLngRange(filters.min_lng, filters.max_lng);
      const chunkClauses = lngChunks.map(
        (chunk) => sql`(
          s.geo && ST_MakeEnvelope(${chunk.minLng}, ${filters.min_lat!}, ${chunk.maxLng}, ${filters.max_lat!}, 4326)::geography
          AND ST_Intersects(s.geo, ST_MakeEnvelope(${chunk.minLng}, ${filters.min_lat!}, ${chunk.maxLng}, ${filters.max_lat!}, 4326)::geography)
        )`
      );
      // Seeded with `false` so an empty chunk list cannot make `reduce` throw.
      const geoClause = chunkClauses.reduce(
        (acc, clause) => sql`${acc} OR ${clause}`,
        sql`false`
      );
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM item_search s
            WHERE s.item_network = ${items.item_network} AND s.item_id = ${items.item_id}
              AND s.lifecycle_status = 'live'
              AND (${geoClause})
          )
        `
      );
    } else {
      // Fallback when item_search has no rows for this network+domain: a
      // numeric range check on items.item_locations. It has no lifecycle
      // predicate; callers wanting live-only must pass `lifecycle_filter`.
      log?.debug(
        { item_network: filters.item_network, item_domain: filters.item_domain },
        'bbox: item_search has no rows for this network+domain — falling back to items.item_locations'
      );
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(${items.item_locations}) loc
            WHERE (loc->>'lat')::float8 BETWEEN ${filters.min_lat} AND ${filters.max_lat}
              AND (loc->>'lng')::float8 BETWEEN ${filters.min_lng} AND ${filters.max_lng}
          )
        `
      );
    }
  }

  return conditions.length ? and(...conditions) : undefined;
}

export async function countLocalItems(
  filters: Omit<ItemFetchFilters, 'limit' | 'offset' | 'includePrivateState'>,
  log?: ItemFetchLog
) {
  const whereClause = await buildWhereClause(filters, log);
  const [{ count }] = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(items)
    .where(whereClause);

  return Number(count);
}

/**
 * ORDER BY shared by fetchLocalItems and fetchLocalMarkers so the two cannot
 * drift. An explicit `order_by` wins; when omitted, coordinates present means
 * distance order (callers other than discover depend on that).
 */
function buildDistanceOrderBy(
  filters: Pick<ItemFetchFilters, 'item_latitude' | 'item_longitude' | 'order_by'>
) {
  const hasCenter =
    filters.item_latitude !== undefined && filters.item_longitude !== undefined;
  const byDistance =
    filters.order_by === 'distance' || (filters.order_by === undefined && hasCenter);

  // A distance order without coordinates degrades to recency rather than
  // emitting SQL that cannot run.
  if (!byDistance || !hasCenter) {
    return sql`${items.created_at} DESC, ${items.item_id} ASC`;
  }

  return sql`
    (
      SELECT MIN(
        earth_distance(
          ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
          ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
        )
      )
      FROM jsonb_array_elements(${items.item_locations}) loc
    ) ASC NULLS LAST,
    ${items.created_at} DESC,
    ${items.item_id} ASC
  `;
}

const markerColumns = {
  item_id: items.item_id,
  item_domain: items.item_domain,
  item_instance_url: items.item_instance_url,
  item_locations: items.item_locations,
};

export async function fetchLocalItems(filters: ItemFetchFilters, log?: ItemFetchLog) {
  const whereClause = await buildWhereClause(filters, log);
  const total = await countLocalItems(filters, log);
  const result = await db
    .select(itemResponseColumns)
    .from(items)
    .where(whereClause)
    // Live items first, so a live profile leads "My Profiles"; a no-op for
    // live-only discovery.
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
 * Slim marker projection with the same WHERE and ORDER BY as fetchLocalItems.
 */
export async function fetchLocalMarkers(filters: ItemFetchFilters, log?: ItemFetchLog) {
  const whereClause = await buildWhereClause(filters, log);
  const total = await countLocalItems(filters, log);
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
