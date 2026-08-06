import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import z, {
  ActionSortKeySchema,
  FetchOwnedActionsQuerySchema,
  OwnedItemActionSchema,
  getInteractionPiiRevealStatuses,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';
import { getNetworkConfigById } from '@/network_configs';
import { resolve_display_name } from '@/services/metrics/resolve_display_name';
import { resolveAllowedFacetFilters, type FacetSelection } from '@/utils/facet_guard';
import { nearestDistanceMeters } from '@/utils/geo_distance';
import { decryptItemPrivate } from '@/utils/item_decrypt';

type FetchOwnedActionsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchOwnedActionsQuerySchema>;
}>;

const FetchOwnedActionsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    // Echoes back the filters/sort/facets actually applied to this page, so
    // the UI can render active-filter chips without re-deriving them from
    // the request it sent (#439).
    applied: z.object({
      sort: ActionSortKeySchema,
      statuses: z.string().array(),
      types: z.string().array(),
      facets: z
        .array(
          z.object({ field: z.string().min(1), values: z.array(z.string()).min(1) })
        )
        .default([]),
    }),
  }),
  actions: OwnedItemActionSchema.array(),
});

export const fetch_actions: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/fetch',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      query: FetchOwnedActionsQuerySchema,
      response: {
        200: FetchOwnedActionsResponseSchema,
      },
    },
    handler: fetch_actions_handler,
  });
};

const fetch_actions_handler = async (
  request: FetchOwnedActionsRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch actions',
    });
  }

  const {
    action_id,
    action_type,
    action_status,
    item_id,
    ownership_role,
    sort,
    facets,
    limit,
    offset,
  } = request.query;

  // Note: no partition pruning here (deliberate). This is an owner-scoped
  // fetch across the caller's own actions, not a single-network browse — there
  // is no one network to prune on, so we rely on the owner+status indexes
  // instead of inventing a network param.
  const conditions = [];

  if (action_id) conditions.push(eq(item_actions.action_id, action_id));
  if (action_type?.length) conditions.push(inArray(item_actions.action_type, action_type));
  if (action_status?.length)
    conditions.push(inArray(item_actions.action_status, action_status));

  if (item_id) {
    if (ownership_role === 'initiated') {
      conditions.push(eq(item_actions.source_item_id, item_id));
    } else if (ownership_role === 'received') {
      conditions.push(eq(item_actions.target_item_id, item_id));
    } else {
      conditions.push(
        or(
          eq(item_actions.source_item_id, item_id),
          eq(item_actions.target_item_id, item_id)
        )
      );
    }
  }

  if (ownership_role === 'initiated') {
    conditions.push(eq(item_actions.source_item_owner, userId));
  } else if (ownership_role === 'received') {
    conditions.push(eq(item_actions.target_item_owner, userId));
  } else {
    conditions.push(
      or(
        eq(item_actions.source_item_owner, userId),
        eq(item_actions.target_item_owner, userId)
      )
    );
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;

  // Sort fast path (#439 Task 6). 'distance' has no SQL-orderable column
  // here — distance is computed at read time from item locations in the
  // Task 7 enrichment stage, which re-sorts the page after fetch — so it
  // falls through to the 'recent' ordering below rather than getting its own
  // branch.
  const orderBy =
    sort === 'oldest'
      ? [asc(item_actions.updated_at), asc(item_actions.created_at)]
      : sort === 'match_score'
        ? [sql`${item_actions.match_score} DESC NULLS LAST`, desc(item_actions.updated_at)]
        : [desc(item_actions.updated_at), desc(item_actions.created_at)]; // 'recent' default (and 'distance' fallthrough)

  try {
    // Ownership guard (#439 Task 6, defense-in-depth): the owner filter below
    // already fails closed to an empty page for a foreign item_id, but that's
    // silent — a caller probing with someone else's item_id deserves a loud,
    // explicit rejection instead of an empty-but-200 response. A missing
    // item_id and a foreign one return the identical 403 body — no existence
    // leak. Mirrors the ownership check in perform_action.ts
    // (`sourceItemSnapshot.created_by === actor.effective_user_id`). Runs
    // inside this try (not before it) so a DB error from this query hits the
    // same structured-500 + logged catch as the count/rows queries below,
    // rather than rejecting unhandled (routes-never-throw).
    if (item_id) {
      const [ownedItem] = await db
        .select({ created_by: items.created_by })
        .from(items)
        .where(eq(items.item_id, item_id))
        .limit(1);
      if (!ownedItem || ownedItem.created_by !== userId) {
        return reply.code(403).send({
          error: 'FORBIDDEN_ITEM',
          message: 'item_id is not owned by the caller',
        });
      }
    }

    // #439 Task 7: two read paths over the same owner+status/type WHERE.
    // - Fast path (no facets, sort !== 'distance'): unchanged Task 6
    //   SQL LIMIT/OFFSET + count(*) — cheapest, and the common case.
    // - Enriched path (facets?.length or sort === 'distance'): facets are
    //   non-PII item_state fields and distance is derived from item
    //   locations — neither is a SQL-orderable/filterable column on
    //   item_actions, so this loads every row matching the WHERE (bounded —
    //   one profile's actions, no cross-profile scan), filters/sorts in
    //   memory, and slices the page itself. `total` becomes the *filtered*
    //   count, not the raw SQL match count.
    const facetsList: FacetSelection[] = facets ?? [];
    const useEnrichedPath = facetsList.length > 0 || sort === 'distance';

    let matchingRows;
    let total: number;

    if (!useEnrichedPath) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(item_actions)
        .where(whereClause);
      matchingRows = await db
        .select()
        .from(item_actions)
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset);
      total = Number(count);
    } else {
      // No SQL LIMIT/OFFSET here: facets and 'distance' sort are applied
      // in-memory below, so the count/pagination has to happen after that,
      // not before it.
      matchingRows = await db
        .select()
        .from(item_actions)
        .where(whereClause)
        .orderBy(...orderBy);
      total = 0; // set below, once filtered.
    }

    // Resolve a name + facet/geo metadata for every source + target item
    // touched by matchingRows (the page in the fast path; every matching row
    // in the enriched path — still bounded to this caller's own actions):
    // - Public display_name_field (e.g. provider organisation_name) → returned
    //   as-is, never masked.
    // - Private name (e.g. seeker beneficiary_name) → the schema-aware mask
    //   already lives in item_state (written via maskPrivateState at item
    //   create time, e.g. "M***"). Per-action consent gating happens below:
    //   reveal the real value only when action_status is in the network's
    //   schema-declared reveals_pii_on_status for this interaction; otherwise
    //   the already-masked value is used.
    // - `meta` (item_state + item_locations) is the non-PII facet/geo
    //   projection Task 7 filters and sorts on — never the masked name.
    const { names: resolvedNames, meta: itemMeta } = await resolveItemNames(matchingRows);

    // Pre-resolve reveals_pii_on_status per action row. Mirrors the gate used
    // by /api/v1/action/:id/contact-details so the list view never reveals a
    // status the contact-detail reveal would refuse. Resolution failures fall
    // back to an empty set (mask), matching the contact-details fail-closed
    // posture. Shared with the Task 7 facet-schema lookup below — both key off
    // network id.
    const networkConfigCache = new Map<
      string,
      Awaited<ReturnType<typeof getNetworkConfigById>> | null
    >();
    const getNetworkConfigCached = async (network: string) => {
      if (networkConfigCache.has(network)) {
        return networkConfigCache.get(network) ?? null;
      }
      try {
        const cfg = await getNetworkConfigById(network);
        networkConfigCache.set(network, cfg);
        return cfg;
      } catch {
        networkConfigCache.set(network, null);
        return null;
      }
    };

    // The counterparty is whichever side of the action the caller does NOT
    // own; `myId` is the other side. For 'received' this is source; for
    // 'initiated' it's target; for 'all' this still resolves the non-owned
    // side per row regardless of which query param scoped the fetch.
    const counterpartyId = (row: OwnedRowIds) =>
      row.target_item_owner === userId ? row.source_item_id : row.target_item_id;
    const myId = (row: OwnedRowIds) =>
      row.target_item_owner === userId ? row.target_item_id : row.source_item_id;

    const distanceFor = (row: OwnedRowIds): number | null =>
      nearestDistanceMeters(
        itemMeta.get(myId(row))?.item_locations,
        itemMeta.get(counterpartyId(row))?.item_locations,
      );

    // facet_guard: the allowed (declared, non-private) field set depends only
    // on the counterparty item's network/domain/item_type — cache it per
    // triple rather than re-resolving the schema for every row.
    const facetAllowedCache = new Map<string, ReturnType<typeof resolveAllowedFacetFilters>>();
    const allowedFacetsFor = async (cMeta: ItemMeta | undefined) => {
      if (!cMeta || facetsList.length === 0) return [];
      const cacheKey = `${cMeta.item_network}::${cMeta.item_domain}::${cMeta.item_type}`;
      const cached = facetAllowedCache.get(cacheKey);
      if (cached) return cached;
      let allowed: ReturnType<typeof resolveAllowedFacetFilters> = [];
      try {
        const cfg = await getNetworkConfigCached(cMeta.item_network);
        if (cfg) {
          allowed = resolveAllowedFacetFilters(
            cfg,
            cMeta.item_domain,
            cMeta.item_type,
            facetsList,
          );
        }
      } catch (err) {
        request.log.warn(
          { err, network: cMeta.item_network, domain: cMeta.item_domain, item_type: cMeta.item_type },
          'facet schema resolution failed in fetch_actions — dropping facets for this item type',
        );
      }
      facetAllowedCache.set(cacheKey, allowed);
      return allowed;
    };

    // A row passes when, for every ALLOWED selection (private/undeclared
    // fields are dropped by allowedFacetsFor — never filtered on, never
    // enumerable), the counterparty's item_state[field] intersects the
    // selected values. No counterparty metadata (e.g. item since deleted) →
    // nothing to filter on → passes (fail-open on the filter, not on PII:
    // there is no state to leak either way).
    const passesFacets = async (row: OwnedRowIds): Promise<boolean> => {
      if (facetsList.length === 0) return true;
      const cMeta = itemMeta.get(counterpartyId(row));
      const allowed = await allowedFacetsFor(cMeta);
      const state = cMeta?.item_state ?? {};
      return allowed.every(({ field, values }) => {
        const raw = state[field];
        const asArray = Array.isArray(raw)
          ? raw.map(String)
          : raw == null
            ? []
            : [String(raw)];
        const wanted = values.map(String);
        return asArray.some((v) => wanted.includes(v));
      });
    };

    let pageRows = matchingRows;
    const distanceByActionId = new Map<string, number | null>();

    if (useEnrichedPath) {
      const withComputed = await Promise.all(
        matchingRows.map(async (row) => ({
          row,
          distance_m: distanceFor(row),
          pass: await passesFacets(row),
        })),
      );
      let enriched = withComputed.filter((e) => e.pass);
      if (sort === 'distance') {
        // Stable sort: distance asc, nulls last, ties keep the SQL-supplied
        // recency order (Array.prototype.sort is stable in the Node engines
        // this runs on).
        enriched = enriched
          .map((e, i) => ({ e, i }))
          .sort((a, b) => {
            if (a.e.distance_m == null && b.e.distance_m == null) return a.i - b.i;
            if (a.e.distance_m == null) return 1;
            if (b.e.distance_m == null) return -1;
            return a.e.distance_m - b.e.distance_m || a.i - b.i;
          })
          .map(({ e }) => e);
      }
      total = enriched.length;
      const page = enriched.slice(offset, offset + limit);
      pageRows = page.map((e) => e.row);
      for (const e of page) distanceByActionId.set(e.row.action_id, e.distance_m);
    } else {
      for (const row of matchingRows) {
        distanceByActionId.set(row.action_id, distanceFor(row));
      }
    }

    const revealStatusesByAction = new Map<string, readonly string[]>();
    for (const row of pageRows) {
      if (revealStatusesByAction.has(row.action_id)) continue;
      let statuses: readonly string[] = [];
      try {
        const cfg = await getNetworkConfigCached(row.target_item_network);
        if (cfg) {
          statuses = getInteractionPiiRevealStatuses(cfg, {
            actionType: row.action_type,
            fromNetwork: row.source_item_network,
            fromDomain: row.source_item_domain,
            fromItemType: row.source_item_type,
            toNetwork: row.target_item_network,
            toDomain: row.target_item_domain,
            toItemType: row.target_item_type,
          });
        }
      } catch (err) {
        request.log.warn(
          { err, action_id: row.action_id, action_type: row.action_type },
          'pii reveal-status resolution failed in fetch_actions — defaulting to masked',
        );
      }
      revealStatusesByAction.set(row.action_id, statuses);
    }
    // Memoise decrypts per item — the same item can appear on multiple rows
    // (source on one action, target on another) and we only want to pay the
    // crypto cost once per page.
    const unmaskedCache = new Map<string, string | null>();
    const unmask = (id: string): string | null => {
      if (unmaskedCache.has(id)) return unmaskedCache.get(id) ?? null;
      const entry = resolvedNames.get(id);
      if (!entry || entry.kind !== 'private') {
        unmaskedCache.set(id, null);
        return null;
      }
      let value: string | null = null;
      try {
        const { mergedState } = decryptItemPrivate({
          item_state: entry.publicState,
          item_private_state: entry.encrypted,
        });
        const raw = mergedState[entry.fieldName];
        if (typeof raw === 'string' && raw.trim().length > 0) value = raw.trim();
      } catch (err) {
        request.log.warn(
          { err, item_id: id, field: entry.fieldName },
          'pii decrypt failed in fetch_actions — falling back to mask',
        );
      }
      unmaskedCache.set(id, value);
      return value;
    };

    const displayName = (
      id: string,
      actionId: string,
      status: string,
    ): string | null => {
      const entry = resolvedNames.get(id);
      if (!entry) return null;
      if (entry.kind === 'public') return entry.value;
      // Private field: schema-aware mask sits in item_state already; reveal
      // the real value only when this action's status is in the network's
      // schema-declared reveals_pii_on_status AND the named profile is live.
      // A paused/draft profile keeps its name masked even on an accepted
      // action — mirrors the contact-details reveal gate (#273).
      const revealStatuses = revealStatusesByAction.get(actionId) ?? [];
      if (revealStatuses.includes(status) && entry.lifecycle_status === 'live') {
        return unmask(id) ?? entry.masked;
      }
      return entry.masked;
    };

    return reply.code(200).send({
      meta: {
        total,
        limit,
        offset,
        applied: {
          sort,
          statuses: action_status ?? [],
          types: action_type ?? [],
          facets: facets ?? [],
        },
      },
      actions: pageRows.map((row) => ({
        ...row,
        created_at:
          row.created_at instanceof Date
            ? row.created_at
            : new Date(row.created_at),
        updated_at:
          row.updated_at instanceof Date
            ? row.updated_at
            : new Date(row.updated_at),
        source_item_name: displayName(
          row.source_item_id,
          row.action_id,
          row.action_status,
        ),
        target_item_name: displayName(
          row.target_item_id,
          row.action_id,
          row.action_status,
        ),
        ownership_roles: [
          ...(row.source_item_owner === userId ? (['initiated'] as const) : []),
          ...(row.target_item_owner === userId ? (['received'] as const) : []),
        ],
        // distance_m is computed at read time (#439 Task 7) from item
        // locations — null when either side has none.
        distance_m: distanceByActionId.get(row.action_id) ?? null,
      })),
    });
  } catch (err) {
    request.log.error({ err, query: request.query }, 'Failed to fetch actions');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch actions',
    });
  }
};

type ActionRow = {
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
};

// The subset of an item_actions row Task 7's counterparty/distance/facet
// helpers need — every real row (the full drizzle select) is a superset of
// this, so callers pass rows straight through with no mapping.
type OwnedRowIds = {
  action_id: string;
  source_item_id: string;
  target_item_id: string;
  source_item_owner: string | null;
  target_item_owner: string | null;
};

// Non-PII, facet/geo projection of an item — the counterpart to `ResolvedName`
// (which carries the display name, masked or not). `item_state` here is
// always the public projection already used for masking (never the
// encrypted private blob), and is only ever read through `facet_guard`'s
// declared-non-private allowlist, so it can't leak an undeclared/private
// field even though the whole object is held in memory.
type ItemMeta = {
  item_state: Record<string, unknown>;
  item_locations: Array<{ lat: number; lng: number; label?: string }>;
  item_network: string;
  item_domain: string;
  item_type: string;
};

type ResolvedName =
  | { kind: 'public'; value: string }
  | {
      kind: 'private';
      masked: string;
      fieldName: string;
      encrypted: string;
      publicState: Record<string, unknown>;
      // Reveal the real name only when this item is live. A paused/draft
      // profile keeps its name masked even on an accepted action (#273).
      lifecycle_status: string;
    };

// Conventional name properties to surface when an item schema declares no
// public `display_name_field`. The schema-aware mask in
// packages/schemas/item_state_masking applies to these at item-create time,
// so item_state already carries the masked value (e.g. "M***").
const PRIVATE_NAME_FIELDS = [
  'beneficiary_name',
  'full_name',
  'name',
  'contact_name',
];

/**
 * Batch-resolves a display name AND a non-PII facet/geo projection for every
 * source + target item on the page in one `items` query. `names` is either a
 * public name (rendered as-is) or a private-name reference carrying the
 * masked value + the encrypted blob, so the handler can lazily decrypt only
 * the rows whose action_status warrants a reveal. Items with no resolvable
 * name are absent from `names`; UI then renders the role-based fallback.
 * `meta` (#439 Task 7) carries `item_state`/`item_locations` for EVERY
 * resolved item regardless of name outcome — it's what the facet filter and
 * distance sort/display read, never the masked name.
 */
async function resolveItemNames(
  rows: ActionRow[]
): Promise<{ names: Map<string, ResolvedName>; meta: Map<string, ItemMeta> }> {
  const names = new Map<string, ResolvedName>();
  const meta = new Map<string, ItemMeta>();
  if (rows.length === 0) return { names, meta };

  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.source_item_id);
    ids.add(r.target_item_id);
  }

  const itemRows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_state: items.item_state,
      item_locations: items.item_locations,
      item_private_state: items.item_private_state,
      lifecycle_status: items.lifecycle_status,
    })
    .from(items)
    .where(inArray(items.item_id, [...ids]));

  const configCache = new Map<
    string,
    Awaited<ReturnType<typeof getNetworkConfigById>> | null
  >();
  const getConfig = async (network: string) => {
    if (configCache.has(network)) return configCache.get(network) ?? null;
    try {
      const cfg = await getNetworkConfigById(network);
      configCache.set(network, cfg);
      return cfg;
    } catch {
      configCache.set(network, null);
      return null;
    }
  };

  for (const item of itemRows) {
    const cfg = await getConfig(item.item_network);
    const domain = cfg?.domains.find((d) => d.id === item.item_domain);
    const schema = domain?.item_schemas?.[item.item_type] as
      | { display_name_field?: string; properties?: Record<string, unknown> }
      | undefined;
    const publicState = (item.item_state ?? {}) as Record<string, unknown>;

    // #439 Task 7: non-PII facet/geo projection, populated for every item
    // regardless of how (or whether) its name resolves below.
    meta.set(item.item_id, {
      item_state: publicState,
      item_locations: Array.isArray(item.item_locations)
        ? (item.item_locations as Array<{ lat: number; lng: number; label?: string }>)
        : [],
      item_network: item.item_network,
      item_domain: item.item_domain,
      item_type: item.item_type,
    });

    // 1. Public display name (provider org name etc.). Never masked.
    const publicName = resolve_display_name({
      schema: schema ?? {},
      item_state: publicState,
      item_id: item.item_id,
    });
    if (publicName !== item.item_id) {
      names.set(item.item_id, { kind: 'public', value: publicName });
      continue;
    }

    // 2. Private name — pulled from item_state, where maskPrivateState has
    //    already pre-masked private fields (e.g. "M***"). Keep a reference to
    //    the encrypted blob so the handler can reveal post-accept.
    let masked: string | null = null;
    let fieldName: string | null = null;
    for (const f of PRIVATE_NAME_FIELDS) {
      const v = publicState[f];
      if (typeof v === 'string' && v.trim().length > 0) {
        masked = v.trim();
        fieldName = f;
        break;
      }
    }
    if (!masked || !fieldName) continue;

    const encrypted = item.item_private_state;
    if (typeof encrypted !== 'string' || encrypted.length === 0) {
      // No ciphertext (legacy row?) — surface the masked value only.
      names.set(item.item_id, {
        kind: 'private',
        masked,
        fieldName,
        encrypted: '',
        publicState,
        lifecycle_status: item.lifecycle_status,
      });
      continue;
    }
    names.set(item.item_id, {
      kind: 'private',
      masked,
      fieldName,
      encrypted,
      publicState,
      lifecycle_status: item.lifecycle_status,
    });
  }

  return { names, meta };
}
