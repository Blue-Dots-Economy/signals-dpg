import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from './item_decrypt';
import { getNetworkConfigById } from '@/network_configs';

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
   * Per-field `item_state` filter values. A **scalar** value (string/number/
   * boolean) keeps the original exact-match semantics — all such entries are
   * combined into one `item_state @> {...}` containment check (unchanged
   * behavior, pre-#203). An **array** value is a multi-value facet filter
   * (#203 Task 3, closing the "documented follow-up" noted at
   * `apps/ui/src/lib/network-api.ts`'s `item_state[field]` comment): it is
   * applied as `item_state->>'field' = ANY(values)`, which only Task 1's
   * per-field expression btree indexes accelerate (a `@>` containment check
   * cannot express "any of these values" for one key). SECURITY: an array
   * value is only honored when the network config declares that field
   * `filterable: true` AND not `private: true` for the item's domain — see
   * `resolveAllowedFacetFields` below — otherwise it is dropped silently
   * (never surfaced as a 4xx) so a caller can't use found/not-found responses
   * to enumerate a private field's values.
   */
  item_state?: Record<string, unknown>;
  /**
   * Free-text value-match search (#394 map native text search). `q` is the
   * raw search term; `fields` is the SERVER-resolved allowlist of non-private
   * `item_state` field keys to match against — resolved by the route handler
   * via `resolveAllowedFacetFields` (facet_guard.ts) from the network
   * config, never from the client. `buildWhereClause` below ANDs this into
   * whatever bbox/radius condition is already present, so a text match is
   * inherently viewport-scoped — no separate geo logic needed here. An empty
   * `fields` (no non-private field declared for the domain/item_type) makes
   * the match unsatisfiable by design rather than matching everything.
   */
  text_search?: { q: string; fields: string[] };
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  // Bounding-box viewport search (#203 Task 2 schema, Task 3 SQL), mutually
  // exclusive with the radius-center params above — see
  // withGeoSearchRefinement in packages/schemas/src/api/item_schemas.ts.
  // Consumed by buildWhereClause below (Option B: item_search.geo join).
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

/**
 * #203 Task 3 security guard: resolves the set of `item_state` field names a
 * caller is allowed to facet-filter on for a given network/domain — exactly
 * those schema properties (across every item_type declared for the domain)
 * marked `filterable: true` AND NOT `private: true`. Sourced from the network
 * config (the same `getNetworkConfigById` cache used elsewhere in the app),
 * never from the request — a client cannot expand its own allowed facet set
 * by naming more fields.
 *
 * Fails closed: an unconfigured network/domain (bad `item_network`/
 * `item_domain`, or a network config load error) yields an empty set, so
 * every facet filter for that request is dropped rather than applied
 * unvalidated.
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
      const declared = definition as { filterable?: unknown; private?: unknown };
      if (declared.filterable === true && declared.private !== true) {
        allowed.add(field);
      }
    }
  }

  return allowed;
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
    // Split the requested item_state entries: array values are a #203 Task 3
    // multi-value facet filter (`= ANY`, guarded below); scalar values keep
    // the pre-existing exact-match containment behavior.
    const scalarState: Record<string, unknown> = {};
    const facetEntries: Array<[string, unknown[]]> = [];

    for (const [field, value] of Object.entries(filters.item_state)) {
      if (Array.isArray(value)) {
        facetEntries.push([field, value]);
      } else {
        scalarState[field] = value;
      }
    }

    if (Object.keys(scalarState).length > 0) {
      conditions.push(
        sql`${items.item_state} @> ${JSON.stringify(scalarState)}::jsonb`
      );
    }

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
            'Dropping item_state facet filter: field is not declared filterable and non-private for this domain'
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
        conditions.push(
          sql`${items.item_state} ->> ${field} = ANY(ARRAY[${valuesArrayLiteral}])`
        );
      }
    }
  }

  if (filters.text_search) {
    const { q, fields } = filters.text_search;

    if (fields.length === 0) {
      // No non-private field is declared for this domain/item_type (e.g. an
      // unconfigured item_type, or a schema with no public fields at all) —
      // the match is unsatisfiable rather than silently matching every row.
      conditions.push(sql`false`);
    } else {
      // Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) in the raw user
      // query so `q` can never inject its own wildcards into the pattern —
      // only a literal substring match is ever performed.
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
    // #203 Task 3 — bbox viewport search (Option B): join the GiST-indexed
    // `item_search.geo` (geography MultiPoint) rather than filtering
    // `items.item_locations` directly. `&&` (bounding-box overlap) is what
    // `item_search_geo_gist` accelerates, but `&&` only compares the
    // ENVELOPE of `geo` (the bbox around every point of a multi-location
    // item) against the viewport envelope — for a multi-location item whose
    // individual points straddle the viewport such that their aggregate
    // envelope overlaps it but no single point actually falls inside, `&&`
    // alone false-positives (wrong pin + inflated meta.total). `&&` stays as
    // the index-served pre-filter; `ST_Intersects` is the exact recheck that
    // corrects it to genuine "any location in the box" — the same guarantee
    // the radius branch above already gives via per-location `earth_box`/
    // `earth_distance`. Single-location items were already exact under `&&`
    // alone (a single point's envelope IS the point), so this only changes
    // behavior for multi-location items.
    if (filters.min_lat >= filters.max_lat || filters.min_lng >= filters.max_lng) {
      // Inverted/degenerate box (e.g. swapped corners): defined as an empty
      // result rather than an error, so a malformed viewport never 500s —
      // it just shows no markers.
      conditions.push(sql`false`);
    } else {
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM item_search s
            WHERE s.item_network = ${items.item_network} AND s.item_id = ${items.item_id}
              AND s.lifecycle_status = 'live'
              AND s.geo && ST_MakeEnvelope(${filters.min_lng}, ${filters.min_lat}, ${filters.max_lng}, ${filters.max_lat}, 4326)::geography
              AND ST_Intersects(s.geo, ST_MakeEnvelope(${filters.min_lng}, ${filters.min_lat}, ${filters.max_lng}, ${filters.max_lat}, 4326)::geography)
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

export async function fetchLocalItems(filters: ItemFetchFilters, log?: ItemFetchLog) {
  const whereClause = await buildWhereClause(filters, log);
  const total = await countLocalItems(filters, log);
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
