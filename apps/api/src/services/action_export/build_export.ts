import {
  getDomainItemSchema,
  getInteractionExportRequesterDomains,
  getInteractionPiiRevealStatuses,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import { counterpartyItemId, ownItemId, stateMatchesFacets } from '@/services/actions/owned_actions';
import { resolveAllowedFacetFilters } from '@/utils/facet_guard';
import { resolveProfileColumns, valueAtPath, type ProfileColumn } from './columns';

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

const emptyCounts = (): ExportCounts => ({
  row_count: 0,
  revealed_count: 0,
  masked_count: 0,
  skipped_cross_instance: 0,
  skipped_missing: 0,
  skipped_self: 0,
  skipped_not_enabled: 0,
});

/**
 * Export rule set of one row's interaction: who may export it and which
 * statuses reveal PII. An undeclared interaction or missing config ⇒ nobody.
 */
function interactionRules(
  input: BuildExportInput,
  row: ExportActionRow
): { requesters: readonly string[]; revealStatuses: readonly string[] } {
  // Same config lookup as fetch_actions / contact-details (target network).
  const cfg = input.getNetworkConfig(row.target_item_network);
  if (!cfg) return { requesters: [], revealStatuses: [] };
  try {
    return {
      requesters: getInteractionExportRequesterDomains(cfg, interactionInput(row)),
      revealStatuses: getInteractionPiiRevealStatuses(cfg, interactionInput(row)),
    };
  } catch {
    return { requesters: [], revealStatuses: [] };
  }
}

/** The caller's own domain and the counterparty's owner / instance on a row. */
function sidesOf(row: ExportActionRow, userId: string) {
  return row.target_item_owner === userId
    ? {
        cpOwner: row.source_item_owner,
        cpInstance: row.source_item_instance_url,
        ownDomain: row.target_item_domain,
      }
    : {
        cpOwner: row.target_item_owner,
        cpInstance: row.target_item_instance_url,
        ownDomain: row.source_item_domain,
      };
}

/**
 * Step 1: eligibility, counterparty resolution and skips. Mutates `counts`
 * with every skip, so no row silently disappears.
 */
function collectCandidates(
  input: BuildExportInput,
  counts: ExportCounts
): { candidates: Candidate[]; eligible: number } {
  const { userId } = input;
  let eligible = 0;
  const candidates: Candidate[] = [];
  for (const row of input.rows) {
    const { cpOwner, cpInstance, ownDomain } = sidesOf(row, userId);

    // Legacy two-domain accounts can own both sides; never export oneself.
    if (cpOwner === userId) {
      counts.skipped_self++;
      continue;
    }
    const { requesters, revealStatuses } = interactionRules(input, row);
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
  return { candidates, eligible };
}

/** Facets restricted to the counterparty's declared, non-private fields. */
function passesFacets(input: BuildExportInput, c: Candidate): boolean {
  const selections = input.filters.facets ?? [];
  if (selections.length === 0) return true;
  const cfg = input.getNetworkConfig(c.counterparty.item_network);
  if (!cfg) return true;
  let allowed: ReturnType<typeof resolveAllowedFacetFilters> = [];
  try {
    allowed = resolveAllowedFacetFilters(
      cfg,
      c.counterparty.item_domain,
      c.counterparty.item_type,
      selections.map((f) => ({ field: f.field, values: f.values }))
    );
  } catch {
    allowed = [];
  }
  return stateMatchesFacets(c.counterparty.item_state, allowed);
}

/** Step 2: facets plus the requested counterparty domain / item type. */
function selectCandidates(input: BuildExportInput, candidates: Candidate[]): Candidate[] {
  const { counterparty_domain: domain, counterparty_item_type: itemType } = input.filters;
  return candidates.filter(
    (c) =>
      passesFacets(input, c) &&
      (!domain || c.counterparty.item_domain === domain) &&
      (!itemType || c.counterparty.item_type === itemType)
  );
}

/** Distinct counterparty types among the selected rows, sorted. */
function counterpartyTypes(selected: Candidate[]): CounterpartyType[] {
  const types = new Map<string, CounterpartyType>();
  for (const { counterparty: cp } of selected) {
    const t = { network: cp.item_network, domain: cp.item_domain, item_type: cp.item_type };
    types.set(typeKey(t), t);
  }
  return [...types.values()].sort((a, b) => typeKey(a).localeCompare(typeKey(b)));
}

/**
 * Step 5: one CSV record, with the reveal gate applied. Mirrors
 * contact-details: status reveals AND both profiles live (a non-local own
 * item counts as live). A failed decrypt exports the row masked.
 */
function buildRecord(
  input: BuildExportInput,
  c: Candidate,
  columns: ProfileColumn[],
  withMatchScore: boolean,
  counts: ExportCounts
): unknown[] {
  const { row, counterparty: cp, own } = c;
  let revealed =
    c.revealStatuses.includes(row.action_status) &&
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

  return [
    row.action_id,
    row.action_type,
    row.action_status,
    row.target_item_owner === input.userId ? 'received' : 'initiated',
    cp.item_id,
    cp.item_domain,
    cp.item_type,
    row.created_at,
    row.updated_at,
    revealed,
    ...(withMatchScore ? [row.match_score ?? null] : []),
    ...columns.map((col) => valueAtPath(state, col.path)),
  ];
}

/** Builds the export table, or the client error that prevents it. */
export function buildExport(input: BuildExportInput): BuildExportResult {
  const counts = emptyCounts();
  const { candidates, eligible } = collectCandidates(input, counts);

  if (eligible === 0 && counts.skipped_not_enabled > 0) {
    return {
      ok: false,
      status: 403,
      error: 'EXPORT_NOT_ENABLED',
      message: 'Bulk export is not enabled for your profile type on these engagements',
    };
  }

  const selected = selectCandidates(input, candidates);
  const types = counterpartyTypes(selected);
  if (types.length > 1) {
    return {
      ok: false,
      status: 400,
      error: 'MIXED_COUNTERPARTY_TYPES',
      message:
        'These engagements span more than one counterparty type; request one at a time with filters.counterparty_domain',
      details: {
        counterparty_domains: [...new Set(types.map((t) => t.domain))].sort((a, b) =>
          a.localeCompare(b)
        ),
        counterparty_types: types,
      },
    };
  }

  const withMatchScore = input.include.includes('match_score');
  const extraColumns = withMatchScore ? ['match_score'] : [];
  const counterparty = types[0];
  if (!counterparty) {
    return { ok: true, header: [...FIXED_COLUMNS, ...extraColumns], records: [], counts };
  }

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

  const records = selected.map((c) =>
    buildRecord(input, c, columns.columns, withMatchScore, counts)
  );
  counts.row_count = records.length;

  return {
    ok: true,
    counterparty,
    header: [...FIXED_COLUMNS, ...extraColumns, ...columns.columns.map((c) => c.header)],
    records,
    counts,
  };
}
