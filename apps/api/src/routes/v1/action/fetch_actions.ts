import { asc, desc, inArray, sql } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import z, {
  ActionFacetSelectionSchema,
  ActionSortKeySchema,
  FetchOwnedActionsQuerySchema,
  OwnedActionCountsSchema,
  OwnedItemActionSchema,
  getDomainItemSchema,
  getInteractionPiiRevealStatuses,
  getInteractionColumnFields,
  interactionInputOf,
} from '@dpg/schemas';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';
import { resolve_display_name } from '@/services/metrics/resolve_display_name';
import {
  resolveAllowedFacetFields,
  resolveAllowedFacetFilters,
  type FacetSelection,
} from '@/utils/facet_guard';
import { nearestDistanceMeters } from '@/utils/geo_distance';
import {
  buildOwnedActionsWhere,
  counterpartyItemId,
  facetsForDomain,
  matchesActionSearch,
  ownItemId,
  scopedItemIds,
  stateMatchesFacets,
} from '@/services/actions/owned_actions';
import { countOwnedActionsForViews } from '@/services/actions/owned_action_counts';
import { PRIVATE_NAME_FIELDS, privateNameShown } from '@/services/actions/visible_name';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { memoizeNetworkConfigs } from '@/utils/network_config_memo';

type FetchOwnedActionsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchOwnedActionsQuerySchema>;
}>;

const FetchOwnedActionsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    // Echoes the filters/sort/facets applied to this page, so the UI can
    // render active-filter chips without re-deriving them.
    applied: z.object({
      sort: ActionSortKeySchema,
      statuses: z.string().array(),
      types: z.string().array(),
      facets: z.array(ActionFacetSelectionSchema).default([]),
      q: z.string().optional(),
    }),
    // `include=counts` only.
    counts: OwnedActionCountsSchema.optional(),
  }),
  actions: OwnedItemActionSchema.array(),
});

export const fetch_actions: FastifyPluginAsyncZod = function (fastify) {
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
  // Plugins return a promise; nothing here awaits (routes register synchronously).
  return Promise.resolve();
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
    item_ids,
    ownership_role,
    q,
    sort,
    facets,
    include,
    limit,
    offset,
  } = request.query;
  const scopedIds = scopedItemIds({ item_id, item_ids });
  const includes: readonly string[] = include ?? [];

  // No partition pruning: an owner-scoped fetch across the caller's own
  // actions has no single network to prune on, so it relies on the
  // owner+status indexes.
  const whereClause = buildOwnedActionsWhere(userId, {
    action_id,
    action_type,
    action_status,
    item_ids: scopedIds,
    ownership_role,
  });

  // 'distance' has no SQL-orderable column: it is computed from item locations
  // in the enrichment stage, which re-sorts, so here it falls through to
  // 'recent'.
  const nonOldestOrderBy =
    sort === 'match_score'
      ? [sql`${item_actions.match_score} DESC NULLS LAST`, desc(item_actions.updated_at)]
      : [desc(item_actions.updated_at), desc(item_actions.created_at)]; // 'recent' default (and 'distance' fallthrough)
  const orderBy =
    sort === 'oldest'
      ? [asc(item_actions.updated_at), asc(item_actions.created_at)]
      : nonOldestOrderBy;

  try {
    // Ownership guard (defence in depth): the owner filter below already
    // yields an empty page for a foreign item_id, but a probe gets an explicit
    // 403 instead. Missing and foreign item_ids get the identical body, so
    // existence does not leak. Inside the try so a DB error gets the same
    // logged 500 as the queries below.
    if (scopedIds.length > 0) {
      const owned = await db
        .select({ item_id: items.item_id, created_by: items.created_by })
        .from(items)
        .where(inArray(items.item_id, scopedIds));
      const ownedIds = new Set(
        owned.filter((o) => o.created_by === userId).map((o) => o.item_id),
      );
      if (!scopedIds.every((id) => ownedIds.has(id))) {
        return reply.code(403).send({
          error: 'FORBIDDEN_ITEM',
          message: 'item_id is not owned by the caller',
        });
      }
    }

    // Two read paths over the same owner+status/type WHERE:
    // - Fast path (no facets, sort !== 'distance'): SQL LIMIT/OFFSET +
    //   count(*).
    // - Enriched path (facets or sort === 'distance'): neither is a SQL
    //   column on item_actions, so every matching row is loaded (bounded to
    //   one caller's actions), filtered/sorted in memory, and paged here.
    //   `total` is then the filtered count.
    const facetsList: Array<FacetSelection & { domain?: string }> = facets ?? [];
    const useEnrichedPath = facetsList.length > 0 || sort === 'distance' || Boolean(q);

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
      // No SQL LIMIT/OFFSET: paging happens after the in-memory filter/sort.
      matchingRows = await db
        .select()
        .from(item_actions)
        .where(whereClause)
        .orderBy(...orderBy);
      total = 0; // set below, once filtered.
    }

    // Resolve a name + facet/geo metadata for every source + target item in
    // matchingRows:
    // - Public display_name_field (e.g. provider organisation_name): returned
    //   as-is.
    // - Private name (e.g. seeker beneficiary_name): item_state already holds
    //   the mask (e.g. "M***"); the real value is revealed only when
    //   action_status is in the interaction's reveals_pii_on_status.
    // - `meta` (item_state + item_locations): the non-PII facet/geo projection
    //   the enriched path filters and sorts on.
    const { names: resolvedNames, meta: itemMeta } = await resolveItemNames(matchingRows, request.log);

    // Pre-resolve reveals_pii_on_status per action row, mirroring the
    // contact-details gate so the list never reveals what that would refuse.
    // A resolution failure falls back to an empty set (mask).
    const getNetworkConfigCached = memoizeNetworkConfigs((err, network) =>
      request.log.warn({ err, network }, 'network config unavailable in fetch_actions — masking'),
    );

    // The counterparty is whichever side of the action the caller does NOT
    // own; `myId` is the other side. For 'received' this is source; for
    // 'initiated' it's target; for 'all' this still resolves the non-owned
    // side per row regardless of which query param scoped the fetch.
    const counterpartyId = (row: OwnedRowIds) => counterpartyItemId(row, userId);
    const myId = (row: OwnedRowIds) => ownItemId(row, userId);

    const distanceFor = (row: OwnedRowIds): number | null =>
      nearestDistanceMeters(
        itemMeta.get(myId(row))?.item_locations,
        itemMeta.get(counterpartyId(row))?.item_locations,
      );

    // The allowed (declared, non-private) facet fields depend only on the
    // counterparty's network/domain/item_type, so they are cached per triple.
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
            facetsForDomain(facetsList, cMeta.item_domain),
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

    // A row passes when, for every allowed selection (private/undeclared
    // fields are dropped by allowedFacetsFor), the counterparty's
    // item_state[field] intersects the selected values. No counterparty
    // metadata (e.g. item deleted) passes: fail-open on the filter only, with
    // no state to leak.
    const passesFacets = async (row: OwnedRowIds): Promise<boolean> => {
      if (facetsList.length === 0) return true;
      const cMeta = itemMeta.get(counterpartyId(row));
      const allowed = await allowedFacetsFor(cMeta);
      const state = cMeta?.item_state ?? {};
      return stateMatchesFacets(state, allowed);
    };

    const revealStatusesByAction = new Map<string, readonly string[]>();
    const resolveRevealStatuses = async (rows: typeof matchingRows) => {
    const pending = rows.filter((row) => !revealStatusesByAction.has(row.action_id));
    // Every network's config first (memoised, in parallel), then the rows.
    const configs = new Map(
      await Promise.all(
        [...new Set(pending.map((r) => r.target_item_network))].map(
          async (network) => [network, await getNetworkConfigCached(network)] as const,
        ),
      ),
    );
    for (const row of pending) {
      let statuses: readonly string[] = [];
      try {
        const cfg = configs.get(row.target_item_network);
        if (cfg) {
          statuses = getInteractionPiiRevealStatuses(cfg, interactionInputOf(row));
        }
      } catch (err) {
        request.log.warn(
          { err, action_id: row.action_id, action_type: row.action_type },
          'pii reveal-status resolution failed in fetch_actions — defaulting to masked',
        );
      }
      revealStatusesByAction.set(row.action_id, statuses);
    }
    };

    // Memoise decrypts per item: the same item can appear on several rows.
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

    // The name as this caller may see it on this row: a public name, or a
    // private one revealed by this action's status on a live profile. null for
    // a name that stays masked — search only ever matches these.
    const visibleName = (id: string, actionId: string, status: string): string | null => {
      const entry = resolvedNames.get(id);
      if (!entry) return null;
      if (entry.kind === 'public') return entry.value;
      if (privateNameShown(revealStatusesByAction.get(actionId) ?? [], status, entry.lifecycle_status)) {
        return unmask(id);
      }
      return null;
    };

    const displayName = (
      id: string,
      actionId: string,
      status: string,
    ): string | null => {
      const entry = resolvedNames.get(id);
      if (!entry) return null;
      if (entry.kind === 'public') return entry.value;
      // Private field: reveal only when this action's status is in
      // reveals_pii_on_status and the named profile is live (as the
      // contact-details gate does); a paused/draft profile stays masked.
      if (privateNameShown(revealStatusesByAction.get(actionId) ?? [], status, entry.lifecycle_status)) {
        return unmask(id) ?? entry.masked;
      }
      return entry.masked;
    };

    const passesSearch = (row: typeof matchingRows[number]): boolean =>
      matchesActionSearch(q, [
        visibleName(counterpartyId(row), row.action_id, row.action_status),
        visibleName(myId(row), row.action_id, row.action_status),
      ]);

    let pageRows = matchingRows;
    const distanceByActionId = new Map<string, number | null>();

    if (useEnrichedPath) {
      if (q) await resolveRevealStatuses(matchingRows);
      const withComputed = await Promise.all(
        matchingRows.map(async (row) => ({
          row,
          distance_m: distanceFor(row),
          pass: await passesFacets(row),
        })),
      );
      let enriched = withComputed.filter((e) => e.pass && passesSearch(e.row));
      if (sort === 'distance') {
        // Stable sort: distance asc, nulls last, ties keep the SQL recency order.
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

    await resolveRevealStatuses(pageRows);

    const counterpartyFor = async (row: typeof matchingRows[number]) => {
      const cMeta = itemMeta.get(counterpartyId(row));
      if (!cMeta) return null;
      let values: Record<string, unknown> = {};
      try {
        const cfg = await getNetworkConfigCached(row.target_item_network);
        const counterpartyCfg = await getNetworkConfigCached(cMeta.item_network);
        if (cfg && counterpartyCfg) {
          const fields = getInteractionColumnFields(
            cfg,
            interactionInputOf(row),
            counterpartyId(row) === row.source_item_id ? 'from' : 'to',
          );
          // Only declared, non-private fields ever leave the server, whatever
          // the config lists — so the values carry no personal data.
          const allowed = resolveAllowedFacetFields(
            getDomainItemSchema(counterpartyCfg, cMeta.item_domain, cMeta.item_type) as Record<
              string,
              unknown
            >,
          );
          values = Object.fromEntries(
            fields
              .filter((f) => allowed.has(f) && cMeta.item_state[f] != null && cMeta.item_state[f] !== '')
              .map((f) => [f, cMeta.item_state[f]]),
          );
        }
      } catch (err) {
        request.log.warn(
          { err, action_id: row.action_id },
          'column field resolution failed in fetch_actions — no column values',
        );
      }
      return {
        network: cMeta.item_network,
        domain: cMeta.item_domain,
        item_type: cMeta.item_type,
        column_fields: values,
      };
    };
    const counterparties = includes.includes('column_fields')
      ? new Map(
          await Promise.all(pageRows.map(async (r) => [r.action_id, await counterpartyFor(r)] as const)),
        )
      : null;

    const counts = includes.includes('counts')
      ? await countOwnedActionsForViews(userId, {
          action_type,
          item_ids: scopedIds,
          getNetworkConfig: getNetworkConfigCached,
          onError: (err) =>
            request.log.warn({ err }, 'saved-view count resolution failed for a group'),
        })
      : undefined;

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
          ...(q ? { q } : {}),
        },
        ...(counts ? { counts } : {}),
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
        // Computed from item locations; null when either side has none.
        distance_m: distanceByActionId.get(row.action_id) ?? null,
        ...(counterparties ? { counterparty: counterparties.get(row.action_id) ?? null } : {}),
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

// The subset of an item_actions row the counterparty/distance/facet helpers
// need; a full row is a superset, so callers pass rows straight through.
type OwnedRowIds = {
  action_id: string;
  source_item_id: string;
  target_item_id: string;
  source_item_owner: string | null;
  target_item_owner: string | null;
};

// Non-PII facet/geo projection of an item. `item_state` is the public
// (masked) projection, never the private blob, and is only read through
// `facet_guard`'s declared-non-private allowlist.
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
      // Reveal the real name only when this item is live.
      lifecycle_status: string;
    };


/**
 * Batch-resolves a display name and a non-PII facet/geo projection for every
 * source + target item in one `items` query. `names` holds either a public
 * name or a private-name reference (masked value + encrypted blob) so the
 * handler decrypts only rows whose action_status warrants a reveal; items with
 * no resolvable name are absent and the UI shows a role-based fallback. `meta`
 * is populated for every resolved item.
 */
async function resolveItemNames(
  rows: ActionRow[],
  log: FastifyBaseLogger,
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

  // A missing config leaves the item unnamed (masked), never an error.
  const getConfig = memoizeNetworkConfigs((err, network) =>
    log.warn({ err, network }, 'network config unavailable while resolving action names'),
  );

  for (const item of itemRows) {
    const cfg = await getConfig(item.item_network);
    const domain = cfg?.domains.find((d) => d.id === item.item_domain);
    const schema = domain?.item_schemas?.[item.item_type] as
      | { display_name_field?: string; properties?: Record<string, unknown> }
      | undefined;
    const publicState = (item.item_state ?? {}) as Record<string, unknown>;

    // Populated for every item, whether or not its name resolves below.
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

    // 2. Private name: item_state holds the mask (e.g. "M***"); keep the
    //    encrypted blob so the handler can reveal post-accept.
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
