import {
  getDomainItemSchema,
  getInteractionExportRequesterDomains,
  getInteractionPiiRevealStatuses,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import { counterpartyItemId, ownItemId, stateMatchesFacets } from '@/services/actions/owned_actions';
import { resolveAllowedFacetFilters } from '@/utils/facet_guard';
import { resolveProfileColumns, valueAtPath } from './columns';

/**
 * Pure core of `POST /api/v1/action/export` (#770): turns the caller's action
 * rows plus the items they touch into one CSV table of COUNTERPARTY profiles.
 *
 * It owns every rule of the export — eligibility (`export.requester_domains`),
 * counterparty resolution, the per-row PII reveal gate (mirrors
 * `get_action_contact_details`), skips, one counterparty type per file, and
 * the columns — and does no I/O: the route supplies rows, items, configs and
 * the decrypt function, so the rules are unit-testable without a database.
 */

/** Columns every export starts with, before profile fields. */
export const FIXED_COLUMNS = [
  'action_id',
  'action_type',
  'action_status',
  'direction',
  'counterparty_item_id',
  'counterparty_domain',
  'counterparty_item_type',
  'created_at',
  'updated_at',
  'pii_revealed',
] as const;

/** The `item_actions` fields the export reads. */
export interface ExportActionRow {
  action_id: string;
  action_type: string;
  action_status: string;
  created_at: Date | string;
  updated_at: Date | string;
  match_score?: number | null;
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  source_item_owner: string | null;
  source_item_instance_url: string;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_instance_url: string;
}

/** The `items` fields the export reads. `item_state` is the masked public view. */
export interface ExportItem {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_private_state: string;
  lifecycle_status: string;
}

export interface BuildExportInput {
  userId: string;
  currentInstanceUrl: string;
  /** Owner-scoped rows, in the order they should appear in the file. */
  rows: readonly ExportActionRow[];
  /** Every local item any row touches, keyed by item_id. */
  items: ReadonlyMap<string, ExportItem>;
  /** Pre-resolved network configs; null when unavailable. */
  getNetworkConfig: (networkId: string) => NetworkConfigDocument | null;
  filters: {
    counterparty_domain?: string;
    counterparty_item_type?: string;
    facets?: ReadonlyArray<{ field: string; values: string[] }>;
  };
  projection: { fields: '*' | readonly string[] };
  include: ReadonlyArray<'match_score'>;
  /** Returns the counterparty's merged (decrypted) state. May throw. */
  decrypt: (item: ExportItem) => Record<string, unknown>;
  /** Called when a permitted decrypt fails; the row is exported masked. */
  onDecryptError?: (err: unknown, itemId: string) => void;
}

export interface ExportCounts {
  row_count: number;
  revealed_count: number;
  masked_count: number;
  skipped_cross_instance: number;
  skipped_missing: number;
  skipped_self: number;
  skipped_not_enabled: number;
}

export interface CounterpartyType {
  network: string;
  domain: string;
  item_type: string;
}

export type BuildExportResult =
  | {
      ok: true;
      /** Undefined only when no row survived (header = fixed columns). */
      counterparty?: CounterpartyType;
      header: string[];
      records: unknown[][];
      counts: ExportCounts;
    }
  | {
      ok: false;
      status: 400 | 403;
      error: 'EXPORT_NOT_ENABLED' | 'MIXED_COUNTERPARTY_TYPES' | 'UNKNOWN_FIELD';
      message: string;
      details?: Record<string, unknown>;
    };

interface Candidate {
  row: ExportActionRow;
  counterparty: ExportItem;
  own: ExportItem | undefined;
  revealStatuses: readonly string[];
}

const typeKey = (t: CounterpartyType) => `${t.network}::${t.domain}::${t.item_type}`;

function interactionInput(row: ExportActionRow) {
  return {
    actionType: row.action_type,
    fromNetwork: row.source_item_network,
    fromDomain: row.source_item_domain,
    fromItemType: row.source_item_type,
    toNetwork: row.target_item_network,
    toDomain: row.target_item_domain,
    toItemType: row.target_item_type,
  };
}

/** Builds the export table, or the client error that prevents it. */
export function buildExport(input: BuildExportInput): BuildExportResult {
  const { userId, filters } = input;
  const counts: ExportCounts = {
    row_count: 0,
    revealed_count: 0,
    masked_count: 0,
    skipped_cross_instance: 0,
    skipped_missing: 0,
    skipped_self: 0,
    skipped_not_enabled: 0,
  };

  // 1. Eligibility, counterparty resolution, skips.
  let eligible = 0;
  const candidates: Candidate[] = [];
  for (const row of input.rows) {
    const callerIsTarget = row.target_item_owner === userId;
    const cpOwner = callerIsTarget ? row.source_item_owner : row.target_item_owner;
    const cpInstance = callerIsTarget ? row.source_item_instance_url : row.target_item_instance_url;
    const ownDomain = callerIsTarget ? row.target_item_domain : row.source_item_domain;

    // Legacy two-domain accounts can own both sides; never export oneself.
    if (cpOwner === userId) {
      counts.skipped_self++;
      continue;
    }

    // Same config lookup as fetch_actions / contact-details (target network).
    // An undeclared interaction or missing config is not exportable.
    const cfg = input.getNetworkConfig(row.target_item_network);
    let requesters: readonly string[] = [];
    let revealStatuses: readonly string[] = [];
    if (cfg) {
      try {
        requesters = getInteractionExportRequesterDomains(cfg, interactionInput(row));
        revealStatuses = getInteractionPiiRevealStatuses(cfg, interactionInput(row));
      } catch {
        requesters = [];
      }
    }
    if (!requesters.includes(ownDomain)) {
      counts.skipped_not_enabled++;
      continue;
    }
    eligible++;

    if (cpInstance !== input.currentInstanceUrl) {
      counts.skipped_cross_instance++;
      continue;
    }
    const counterparty = input.items.get(counterpartyItemId(row, userId));
    if (!counterparty) {
      counts.skipped_missing++;
      continue;
    }
    candidates.push({
      row,
      counterparty,
      own: input.items.get(ownItemId(row, userId)),
      revealStatuses,
    });
  }

  if (eligible === 0 && counts.skipped_not_enabled > 0) {
    return {
      ok: false,
      status: 403,
      error: 'EXPORT_NOT_ENABLED',
      message: 'Bulk export is not enabled for your profile type on these engagements',
    };
  }

  // 2. Facets — declared non-private fields of the counterparty only.
  const facetSelections = filters.facets ?? [];
  const passesFacets = (c: Candidate) => {
    if (facetSelections.length === 0) return true;
    const cfg = input.getNetworkConfig(c.counterparty.item_network);
    if (!cfg) return true;
    let allowed: ReturnType<typeof resolveAllowedFacetFilters> = [];
    try {
      allowed = resolveAllowedFacetFilters(
        cfg,
        c.counterparty.item_domain,
        c.counterparty.item_type,
        facetSelections.map((f) => ({ field: f.field, values: f.values }))
      );
    } catch {
      allowed = [];
    }
    return stateMatchesFacets(c.counterparty.item_state, allowed);
  };

  // 3. Counterparty type selection.
  const selected = candidates.filter(
    (c) =>
      passesFacets(c) &&
      (!filters.counterparty_domain || c.counterparty.item_domain === filters.counterparty_domain) &&
      (!filters.counterparty_item_type ||
        c.counterparty.item_type === filters.counterparty_item_type)
  );

  const types = new Map<string, CounterpartyType>();
  for (const c of selected) {
    const t = {
      network: c.counterparty.item_network,
      domain: c.counterparty.item_domain,
      item_type: c.counterparty.item_type,
    };
    types.set(typeKey(t), t);
  }
  if (types.size > 1) {
    const list = [...types.values()].sort((a, b) => typeKey(a).localeCompare(typeKey(b)));
    return {
      ok: false,
      status: 400,
      error: 'MIXED_COUNTERPARTY_TYPES',
      message:
        'These engagements span more than one counterparty type; request one at a time with filters.counterparty_domain',
      details: {
        counterparty_domains: [...new Set(list.map((t) => t.domain))].sort(),
        counterparty_types: list,
      },
    };
  }

  const extraColumns = input.include.includes('match_score') ? ['match_score'] : [];
  const counterparty = [...types.values()][0];
  if (!counterparty) {
    return { ok: true, header: [...FIXED_COLUMNS, ...extraColumns], records: [], counts };
  }

  // 4. Columns from the counterparty schema.
  const cpCfg = input.getNetworkConfig(counterparty.network);
  if (!cpCfg) throw new Error(`network config "${counterparty.network}" unavailable`);
  const schema = getDomainItemSchema(cpCfg, counterparty.domain, counterparty.item_type) as Record<
    string,
    unknown
  >;
  const columns = resolveProfileColumns(schema, input.projection.fields);
  if (!columns.ok) {
    return {
      ok: false,
      status: 400,
      error: 'UNKNOWN_FIELD',
      message: `Unknown field(s) for ${counterparty.domain}/${counterparty.item_type}: ${columns.unknown.join(', ')}`,
      details: { fields: columns.unknown },
    };
  }

  // 5. Rows, with the reveal gate per row.
  const records = selected.map(({ row, counterparty: cp, own, revealStatuses }) => {
    // Mirrors contact-details: status reveals AND both profiles live. A
    // non-local own item is treated as live, as there.
    let revealed =
      revealStatuses.includes(row.action_status) &&
      cp.lifecycle_status === 'live' &&
      (own ? own.lifecycle_status === 'live' : true);
    let state = cp.item_state;
    if (revealed) {
      try {
        state = input.decrypt(cp);
      } catch (err) {
        input.onDecryptError?.(err, cp.item_id);
        revealed = false;
      }
    }
    if (revealed) counts.revealed_count++;
    else counts.masked_count++;

    const direction = row.target_item_owner === userId ? 'received' : 'initiated';
    return [
      row.action_id,
      row.action_type,
      row.action_status,
      direction,
      cp.item_id,
      cp.item_domain,
      cp.item_type,
      row.created_at,
      row.updated_at,
      revealed,
      ...(extraColumns.length ? [row.match_score ?? null] : []),
      ...columns.columns.map((c) => valueAtPath(state, c.path)),
    ];
  });
  counts.row_count = records.length;

  return {
    ok: true,
    counterparty,
    header: [...FIXED_COLUMNS, ...extraColumns, ...columns.columns.map((c) => c.header)],
    records,
    counts,
  };
}
