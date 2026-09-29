import { and, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { item_actions } from '@dpg/database';

/**
 * The owner-scoped action row set shared by `GET /action/fetch` and
 * `POST /action/export` (#770). One builder, so the list view and an export
 * can never disagree about which rows belong to the caller.
 */
export interface OwnedActionsFilters {
  action_id?: string;
  action_ids?: string[];
  action_type?: string[];
  action_status?: string[];
  item_id?: string;
  /** Several of the caller's items; merged with `item_id`. */
  item_ids?: string[];
  ownership_role: 'all' | 'initiated' | 'received';
  updated_from?: Date;
  updated_to?: Date;
  /** Counterparty (the side the caller does NOT own) domain / item type. */
  counterparty_domain?: string;
  counterparty_item_type?: string;
}

/**
 * Condition on the counterparty side: when the caller owns the target the
 * counterparty is the source, and vice versa.
 */
function counterpartyEquals(
  userId: string,
  sourceCol: AnyPgColumn,
  targetCol: AnyPgColumn,
  value: string
): SQL | undefined {
  return or(
    and(eq(item_actions.target_item_owner, userId), eq(sourceCol, value)),
    and(eq(item_actions.source_item_owner, userId), eq(targetCol, value))
  );
}

/** Row filters that do not depend on which side the caller owns. */
function rowFilterConditions(filters: OwnedActionsFilters): Array<SQL | undefined> {
  const { action_id, action_ids, action_type, action_status, updated_from, updated_to } = filters;
  return [
    action_id ? eq(item_actions.action_id, action_id) : undefined,
    action_ids?.length ? inArray(item_actions.action_id, action_ids) : undefined,
    action_type?.length ? inArray(item_actions.action_type, action_type) : undefined,
    action_status?.length ? inArray(item_actions.action_status, action_status) : undefined,
    updated_from ? gte(item_actions.updated_at, updated_from) : undefined,
    updated_to ? lte(item_actions.updated_at, updated_to) : undefined,
  ];
}

/** Counterparty domain / item type, matched on the side the caller does not own. */
function counterpartyConditions(
  userId: string,
  filters: OwnedActionsFilters
): Array<SQL | undefined> {
  return [
    filters.counterparty_domain
      ? counterpartyEquals(
          userId,
          item_actions.source_item_domain,
          item_actions.target_item_domain,
          filters.counterparty_domain
        )
      : undefined,
    filters.counterparty_item_type
      ? counterpartyEquals(
          userId,
          item_actions.source_item_type,
          item_actions.target_item_type,
          filters.counterparty_item_type
        )
      : undefined,
  ];
}

/** Every item id the filter scopes to (`item_id` plus `item_ids`), deduplicated. */
export function scopedItemIds(filters: Pick<OwnedActionsFilters, 'item_id' | 'item_ids'>): string[] {
  return [...new Set([...(filters.item_id ? [filters.item_id] : []), ...(filters.item_ids ?? [])])];
}

/** The scoped item(s) narrowed to the side(s) the ownership role covers. */
function itemCondition(
  itemIds: string[],
  role: OwnedActionsFilters['ownership_role']
): SQL | undefined {
  if (itemIds.length === 0) return undefined;
  const on = (col: AnyPgColumn) =>
    itemIds.length === 1 ? eq(col, itemIds[0]) : inArray(col, itemIds);
  if (role === 'initiated') return on(item_actions.source_item_id);
  if (role === 'received') return on(item_actions.target_item_id);
  return or(on(item_actions.source_item_id), on(item_actions.target_item_id));
}

/** Ownership: caller owns the source (`initiated`), the target (`received`), or either. */
function ownerCondition(
  userId: string,
  role: OwnedActionsFilters['ownership_role']
): SQL | undefined {
  if (role === 'initiated') return eq(item_actions.source_item_owner, userId);
  if (role === 'received') return eq(item_actions.target_item_owner, userId);
  return or(eq(item_actions.source_item_owner, userId), eq(item_actions.target_item_owner, userId));
}

/**
 * WHERE clause for the caller's own actions under the given filters.
 *
 * Ownership is always applied: `initiated` = caller owns the source item,
 * `received` = caller owns the target, `all` = either. `item_id` narrows to
 * one of the caller's items on the same side(s). The caller must separately
 * verify `item_id` is theirs — this only builds the filter.
 */
export function buildOwnedActionsWhere(
  userId: string,
  filters: OwnedActionsFilters
): SQL | undefined {
  return and(
    ...rowFilterConditions(filters),
    ...counterpartyConditions(userId, filters),
    itemCondition(scopedItemIds(filters), filters.ownership_role),
    ownerCondition(userId, filters.ownership_role)
  );
}

/** The subset of an `item_actions` row the side resolvers need. */
export interface OwnedRowSides {
  source_item_id: string;
  target_item_id: string;
  target_item_owner: string | null;
}

/**
 * The item on the side of the action the caller does NOT own — the
 * counterparty. `received` ⇒ source, `initiated` ⇒ target; for `all` it is
 * resolved per row.
 */
export const counterpartyItemId = (row: OwnedRowSides, userId: string): string =>
  row.target_item_owner === userId ? row.source_item_id : row.target_item_id;

/** The caller's own item on the action — the side `counterpartyItemId` is not. */
export const ownItemId = (row: OwnedRowSides, userId: string): string =>
  row.target_item_owner === userId ? row.target_item_id : row.source_item_id;

/**
 * True when `state` matches every facet selection: `state[field]` (scalar or
 * array) intersects the selected values. Callers must pass only selections
 * already restricted to declared, non-private fields (`facet_guard`).
 */
export function stateMatchesFacets(
  state: Record<string, unknown>,
  selections: ReadonlyArray<{ field: string; values: readonly unknown[] }>
): boolean {
  return selections.every(({ field, values }) => {
    const raw = state[field];
    let asArray: string[];
    if (Array.isArray(raw)) {
      asArray = raw.map(String);
    } else if (raw == null) {
      asArray = [];
    } else {
      asArray = [String(raw as string | number | boolean)];
    }
    const wanted = new Set(values.map(String));
    return asArray.some((v) => wanted.has(v));
  });
}

/**
 * The facet selections that apply to a counterparty in `domain`: a selection
 * with no `domain` applies to every counterparty, one with a `domain` only to
 * counterparties in that domain. Shared by the list and the export so both
 * narrow the same rows.
 */
export function facetsForDomain<V>(
  selections: ReadonlyArray<{ domain?: string; field: string; values: V[] }>,
  domain: string
): Array<{ field: string; values: V[] }> {
  return selections
    .filter((s) => !s.domain || s.domain === domain)
    .map(({ field, values }) => ({ field, values }));
}

/**
 * Case-insensitive substring search over names the caller may already see.
 * Callers pass only UNMASKED names (a public name, or a private one revealed
 * on this row) — a masked value like "A***" must never be offered, or search
 * would let a caller probe hidden names letter by letter.
 */
export function matchesActionSearch(
  q: string | undefined,
  visibleNames: ReadonlyArray<string | null | undefined>
): boolean {
  const needle = q?.trim().toLowerCase();
  if (!needle) return true;
  return visibleNames.some((n) => typeof n === 'string' && n.toLowerCase().includes(needle));
}
