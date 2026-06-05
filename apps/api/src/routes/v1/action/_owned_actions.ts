import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import { getInteractionPiiRevealStatuses } from '@dpg/schemas';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { getNetworkConfigById } from '@/network_configs';
import { resolve_display_name } from '@/services/metrics/resolve_display_name';
import { decryptItemPrivate } from '@/utils/item_decrypt';

export type OwnershipRole = 'all' | 'initiated' | 'received';

export type OwnedActionsFilters = {
  action_id?: string;
  action_type?: string;
  action_status?: string;
  item_id?: string;
  ownership_role: OwnershipRole;
};

/**
 * Query + enrich the actions owned by `ownerId` on THIS instance's DB.
 *
 * Used by the authenticated GET /api/v1/action/fetch handler (ownerId =
 * session user). The read is local-only: cross-instance actions are mirrored
 * to the initiator's home instance at write time (see
 * /api/v1/network/action/store_local), so the owner's rows always live here.
 *
 * `ownerId` here is the network-wide user id stored on the action row
 * (source_item_owner / target_item_owner). For a cross-instance action the
 * mirrored row carries the initiator's home-instance user id verbatim.
 */
export async function collectOwnedActions(opts: {
  ownerId: string;
  filters: OwnedActionsFilters;
  limit: number;
  offset: number;
  log: FastifyBaseLogger;
}): Promise<{ count: number; actions: EnrichedAction[] }> {
  const { ownerId, filters, limit, offset, log } = opts;
  const { action_id, action_type, action_status, item_id, ownership_role } =
    filters;

  const conditions = [];

  if (action_id) conditions.push(eq(item_actions.action_id, action_id));
  if (action_type) conditions.push(eq(item_actions.action_type, action_type));
  if (action_status)
    conditions.push(eq(item_actions.action_status, action_status));

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
    conditions.push(eq(item_actions.source_item_owner, ownerId));
  } else if (ownership_role === 'received') {
    conditions.push(eq(item_actions.target_item_owner, ownerId));
  } else {
    conditions.push(
      or(
        eq(item_actions.source_item_owner, ownerId),
        eq(item_actions.target_item_owner, ownerId)
      )
    );
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(item_actions)
    .where(whereClause);

  const rows = await db
    .select()
    .from(item_actions)
    .where(whereClause)
    .orderBy(desc(item_actions.updated_at), desc(item_actions.created_at))
    .limit(limit)
    .offset(offset);

  const resolvedNames = await resolveItemNames(rows);

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

  const revealStatusesByAction = new Map<string, readonly string[]>();
  for (const row of rows) {
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
      log.warn(
        { err, action_id: row.action_id, action_type: row.action_type },
        'pii reveal-status resolution failed in collectOwnedActions — defaulting to masked'
      );
    }
    revealStatusesByAction.set(row.action_id, statuses);
  }

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
      log.warn(
        { err, item_id: id, field: entry.fieldName },
        'pii decrypt failed in collectOwnedActions — falling back to mask'
      );
    }
    unmaskedCache.set(id, value);
    return value;
  };

  const displayName = (
    id: string,
    actionId: string,
    status: string
  ): string | null => {
    const entry = resolvedNames.get(id);
    if (!entry) return null;
    if (entry.kind === 'public') return entry.value;
    const revealStatuses = revealStatusesByAction.get(actionId) ?? [];
    if (revealStatuses.includes(status)) return unmask(id) ?? entry.masked;
    return entry.masked;
  };

  const actions: EnrichedAction[] = rows.map((row) => ({
    ...row,
    created_at:
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at:
      row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    source_item_name: displayName(
      row.source_item_id,
      row.action_id,
      row.action_status
    ),
    target_item_name: displayName(
      row.target_item_id,
      row.action_id,
      row.action_status
    ),
    ownership_roles: [
      ...(row.source_item_owner === ownerId ? (['initiated'] as const) : []),
      ...(row.target_item_owner === ownerId ? (['received'] as const) : []),
    ],
  }));

  return { count: Number(count), actions };
}

type ItemActionRow = typeof item_actions.$inferSelect;

export type EnrichedAction = Omit<ItemActionRow, 'created_at' | 'updated_at'> & {
  created_at: Date;
  updated_at: Date;
  source_item_name: string | null;
  target_item_name: string | null;
  ownership_roles: Array<'initiated' | 'received'>;
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

type ResolvedName =
  | { kind: 'public'; value: string }
  | {
      kind: 'private';
      masked: string;
      fieldName: string;
      encrypted: string;
      publicState: Record<string, unknown>;
    };

const PRIVATE_NAME_FIELDS = [
  'beneficiary_name',
  'full_name',
  'name',
  'contact_name',
];

async function resolveItemNames(
  rows: ActionRow[]
): Promise<Map<string, ResolvedName>> {
  const result = new Map<string, ResolvedName>();
  if (rows.length === 0) return result;

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
      item_private_state: items.item_private_state,
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

    const publicName = resolve_display_name({
      schema: schema ?? {},
      item_state: publicState,
      item_id: item.item_id,
    });
    if (publicName !== item.item_id) {
      result.set(item.item_id, { kind: 'public', value: publicName });
      continue;
    }

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
      result.set(item.item_id, {
        kind: 'private',
        masked,
        fieldName,
        encrypted: '',
        publicState,
      });
      continue;
    }
    result.set(item.item_id, {
      kind: 'private',
      masked,
      fieldName,
      encrypted,
      publicState,
    });
  }

  return result;
}
