import type { DotNetworkSchema } from '@/engine/types';
import type { Action, FetchMyActionsQuery } from '@/lib/action-api';

/**
 * View model of the My Actions page: one list of the caller's sent and
 * received actions, filtered, sorted and paged server-side. Everything the
 * page shows is derived from `MyActionsFilter`, which round-trips through the
 * URL so a view is shareable and survives a refresh.
 */

export type Direction = 'all' | 'received' | 'sent';
export type ActionSortKey = NonNullable<FetchMyActionsQuery['sort']>;
export const SORT_KEYS: readonly ActionSortKey[] = ['recent', 'oldest', 'match_score', 'distance'];
export const PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 10;

export interface FacetSelection {
  /** Counterparty domain the field belongs to. */
  domain: string;
  field: string;
  values: string[];
}

export interface MyActionsFilter {
  /** The caller's own profiles to include; empty = all of them. */
  profiles: string[];
  statuses: string[];
  direction: Direction;
  types: string[];
  facets: FacetSelection[];
  q: string;
  sort: ActionSortKey;
  page: number;
  per: number;
}

export const EMPTY_FILTER: MyActionsFilter = {
  profiles: [],
  statuses: [],
  direction: 'all',
  types: [],
  facets: [],
  q: '',
  sort: 'recent',
  page: 1,
  per: DEFAULT_PAGE_SIZE,
};

const list = (v: string | null) =>
  v ? v.split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean) : [];
const joinList = (values: readonly string[]) => values.map(encodeURIComponent).join(',');

/** URL → filter. Unknown/invalid values fall back to the defaults. */
export function parseFilter(params: URLSearchParams): MyActionsFilter {
  const direction = params.get('dir');
  const sort = params.get('sort');
  const page = Number(params.get('page'));
  const per = Number(params.get('per'));
  const facets: FacetSelection[] = [];
  for (const [key, value] of params.entries()) {
    // f_<domain>.<field>=v1,v2
    if (!key.startsWith('f_')) continue;
    const [domain, ...rest] = key.slice(2).split('.');
    const field = rest.join('.');
    const values = list(value);
    if (domain && field && values.length > 0) facets.push({ domain, field, values });
  }
  return {
    profiles: list(params.get('profiles')),
    statuses: list(params.get('status')),
    direction: direction === 'received' || direction === 'sent' ? direction : 'all',
    types: list(params.get('type')),
    facets,
    q: params.get('q') ?? '',
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? '') ? (sort as ActionSortKey) : 'recent',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    per: (PAGE_SIZES as readonly number[]).includes(per) ? per : DEFAULT_PAGE_SIZE,
  };
}

/** Filter → URL, keeping unrelated params (network, …) and omitting defaults. */
export function writeFilter(prev: URLSearchParams, f: MyActionsFilter): URLSearchParams {
  const next = new URLSearchParams(prev);
  const staleFacetKeys = Array.from(next.keys()).filter((key) => key.startsWith('f_'));
  staleFacetKeys.forEach((key) => next.delete(key));
  const set = (key: string, value: string, isDefault: boolean) =>
    isDefault ? next.delete(key) : next.set(key, value);
  set('profiles', joinList(f.profiles), f.profiles.length === 0);
  set('status', joinList(f.statuses), f.statuses.length === 0);
  set('dir', f.direction, f.direction === 'all');
  set('type', joinList(f.types), f.types.length === 0);
  set('q', f.q, f.q.trim() === '');
  set('sort', f.sort, f.sort === 'recent');
  set('page', String(f.page), f.page === 1);
  set('per', String(f.per), f.per === DEFAULT_PAGE_SIZE);
  for (const facet of f.facets) {
    if (facet.values.length > 0) next.set(`f_${facet.domain}.${facet.field}`, joinList(facet.values));
  }
  next.delete('profile'); // the pre-revamp single-profile param
  return next;
}

const OWNERSHIP_ROLE: Record<Direction, NonNullable<FetchMyActionsQuery['ownership_role']>> = {
  all: 'all',
  received: 'received',
  sent: 'initiated',
};

/** Filter → `GET /action/fetch` query. */
export function toFetchQuery(
  f: MyActionsFilter,
  include: FetchMyActionsQuery['include'] = ['counts', 'column_fields'],
): FetchMyActionsQuery {
  return {
    ownership_role: OWNERSHIP_ROLE[f.direction],
    item_ids: f.profiles.length > 0 ? f.profiles : undefined,
    action_status: f.statuses.length > 0 ? f.statuses : undefined,
    action_type: f.types.length > 0 ? f.types : undefined,
    facets: f.facets.length > 0 ? f.facets : undefined,
    q: f.q.trim() || undefined,
    sort: f.sort,
    limit: f.per,
    offset: (f.page - 1) * f.per,
    include,
  };
}

/** The filter with one facet value removed (and the facet, once empty). */
export function withoutFacetValue(
  f: MyActionsFilter,
  domain: string,
  field: string,
  value: string,
): MyActionsFilter {
  const facets = f.facets
    .map((x) => (x.domain === domain && x.field === field ? { ...x, values: x.values.filter((v) => v !== value) } : x))
    .filter((x) => x.values.length > 0);
  return { ...f, facets };
}

/** Number of active filters, for the Filter button badge (profiles/search excluded). */
export function activeFilterCount(f: MyActionsFilter, statusOptions: readonly StatusOption[] = []): number {
  return (
    selectedStatusOptions(f.statuses, statusOptions).length +
    f.types.length +
    (f.direction === 'all' ? 0 : 1) +
    f.facets.reduce((n, facet) => n + facet.values.length, 0)
  );
}

// ─── Network-derived vocabulary ────────────────────────────────────────────

const interactions = (network: DotNetworkSchema | null | undefined) =>
  Object.values(network?.actions ?? {}).flatMap((a) => a.interactions ?? []);

/** Every action status the network's interactions declare, in declaration order. */
export function actionStatuses(network: DotNetworkSchema | null | undefined): string[] {
  const out: string[] = [];
  for (const i of interactions(network)) {
    const statusEnum = (i.event_schema?.properties as Record<string, { enum?: unknown[] }> | undefined)
      ?.status?.enum;
    for (const s of statusEnum ?? []) {
      if (typeof s === 'string' && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Statuses still waiting on the receiver (the `create` metric bucket). */
export function pendingStatuses(network: DotNetworkSchema | null | undefined): string[] {
  const out = new Set<string>();
  for (const i of interactions(network)) for (const s of i.metric_categories?.create ?? []) out.add(s);
  return [...out];
}

/** One entry in the Status filter: a single status, or the pending group. */
export interface StatusOption {
  id: string;
  statuses: string[];
}

/** Id of the grouped "Pending" status option. */
export const PENDING_OPTION = 'pending';

/**
 * Status filter options. Every status still waiting on the receiver
 * (created, submitted, invited…) folds into one "Pending" option — they mean
 * the same thing to the person filtering — and the rest stay one per status.
 */
export function statusOptions(statuses: readonly string[], pending: readonly string[]): StatusOption[] {
  const grouped = statuses.filter((s) => pending.includes(s));
  const rest = statuses.filter((s) => !pending.includes(s)).map((s) => ({ id: s, statuses: [s] }));
  return grouped.length > 0 ? [{ id: PENDING_OPTION, statuses: grouped }, ...rest] : rest;
}

/**
 * The options a status selection touches. A status no option covers (e.g.
 * set by hand in the URL) counts as its own option, so nothing is hidden.
 */
export function selectedStatusOptions(selected: readonly string[], options: readonly StatusOption[]): StatusOption[] {
  const touched = options.filter((o) => o.statuses.some((s) => selected.includes(s)));
  const covered = new Set(options.flatMap((o) => o.statuses));
  return [...touched, ...selected.filter((s) => !covered.has(s)).map((s) => ({ id: s, statuses: [s] }))];
}

/** Ticks or unticks a whole option. Partly ticked counts as unticked. */
export function toggleStatusOption(selected: readonly string[], option: StatusOption): string[] {
  const on = option.statuses.every((s) => selected.includes(s));
  return on
    ? selected.filter((s) => !option.statuses.includes(s))
    : [...selected, ...option.statuses.filter((s) => !selected.includes(s))];
}

/** Action types the network declares (e.g. apply, connect). */
export function actionTypes(network: DotNetworkSchema | null | undefined): string[] {
  return Object.keys(network?.actions ?? {});
}

// ─── Saved views ───────────────────────────────────────────────────────────

export type SavedViewId = 'all' | 'needs_response' | 'ready_to_export' | 'sent';

/** A saved view is a preset of status + direction; everything else is kept. */
export function applySavedView(
  f: MyActionsFilter,
  view: SavedViewId,
  vocab: { pending: string[]; exportable: string[] },
): MyActionsFilter {
  const base = { ...f, page: 1 };
  switch (view) {
    case 'needs_response':
      return { ...base, direction: 'received', statuses: vocab.pending };
    case 'ready_to_export':
      return { ...base, direction: 'all', statuses: vocab.exportable };
    case 'sent':
      return { ...base, direction: 'sent', statuses: [] };
    default:
      return { ...base, direction: 'all', statuses: [] };
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

/** Which saved view the filter currently equals, or null for a custom view. */
export function currentSavedView(
  f: MyActionsFilter,
  vocab: { pending: string[]; exportable: string[] },
): SavedViewId | null {
  if (f.direction === 'all' && f.statuses.length === 0) return 'all';
  if (f.direction === 'received' && vocab.pending.length > 0 && sameSet(f.statuses, vocab.pending)) {
    return 'needs_response';
  }
  if (f.direction === 'all' && vocab.exportable.length > 0 && sameSet(f.statuses, vocab.exportable)) {
    return 'ready_to_export';
  }
  if (f.direction === 'sent' && f.statuses.length === 0) return 'sent';
  return null;
}

// ─── Row helpers ───────────────────────────────────────────────────────────

export interface ActionSides {
  direction: 'received' | 'sent';
  mine: { itemId: string; domain: string };
  other: {
    itemId: string;
    domain: string;
    itemType: string;
    network: string;
    name: string | null | undefined;
  };
}

/** Which side of an action is the caller's, from `ownership_roles`. */
export function sidesOf(a: Action): ActionSides {
  const received = a.ownership_roles.includes('received');
  return received
    ? {
        direction: 'received',
        mine: { itemId: a.target_item_id, domain: a.target_item_domain },
        other: {
          itemId: a.source_item_id,
          domain: a.source_item_domain,
          itemType: a.source_item_type,
          network: a.source_item_network,
          name: a.source_item_name,
        },
      }
    : {
        direction: 'sent',
        mine: { itemId: a.source_item_id, domain: a.source_item_domain },
        other: {
          itemId: a.target_item_id,
          domain: a.target_item_domain,
          itemType: a.target_item_type,
          network: a.target_item_network,
          name: a.target_item_name,
        },
      };
}

/** A pending request the caller received — needs their Accept / Reject. */
export function needsResponse(a: Action, pending: readonly string[]): boolean {
  return a.ownership_roles.includes('received') && pending.includes(a.action_status);
}

/** Page numbers to show, with '…' gaps (first, last, current ±1). */
export function pageList(page: number, pages: number): Array<number | '…'> {
  const out: Array<number | '…'> = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) out.push(p);
    else if (out.at(-1) !== '…') out.push('…');
  }
  return out;
}

/**
 * The first-use ("no actions yet") message key and English fallback, worded
 * for the action types the network actually has.
 */
export function firstUseCopy(types: readonly string[]): [key: string, fallback: string] {
  const apply = types.includes('apply');
  const connect = types.includes('connect');
  const tail = 'What you send and what you receive shows up here.';
  if (apply && connect) {
    return ['my_actions.first_use_body_apply_connect', `Apply or connect with someone on the map. ${tail}`];
  }
  if (connect) return ['my_actions.first_use_body_connect', `Connect with someone on the map. ${tail}`];
  if (apply) return ['my_actions.first_use_body_apply', `Apply to an opportunity on the map. ${tail}`];
  return ['my_actions.first_use_body', `Find someone on the map and reach out. ${tail}`];
}

/**
 * The statuses a view can export: its status filter narrowed to the
 * exportable ones, or every exportable status when it has none. Empty means
 * the view shows nothing exportable — never widen that to "all".
 */
export function viewExportableStatuses(
  filterStatuses: readonly string[],
  exportable: readonly string[],
): string[] {
  return filterStatuses.length > 0 ? filterStatuses.filter((s) => exportable.includes(s)) : [...exportable];
}
