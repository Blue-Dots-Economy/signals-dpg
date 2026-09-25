import { and, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
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
  ownership_role: 'all' | 'initiated' | 'received';
  updated_from?: Date;
  updated_to?: Date;
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
  const { action_id, action_ids, action_type, action_status, item_id, ownership_role } =
    filters;
  const conditions: Array<SQL | undefined> = [];

  if (action_id) conditions.push(eq(item_actions.action_id, action_id));
  if (action_ids?.length) conditions.push(inArray(item_actions.action_id, action_ids));
  if (action_type?.length) conditions.push(inArray(item_actions.action_type, action_type));
  if (action_status?.length)
    conditions.push(inArray(item_actions.action_status, action_status));
  if (filters.updated_from) conditions.push(gte(item_actions.updated_at, filters.updated_from));
  if (filters.updated_to) conditions.push(lte(item_actions.updated_at, filters.updated_to));

  if (item_id) {
    if (ownership_role === 'initiated') {
      conditions.push(eq(item_actions.source_item_id, item_id));
    } else if (ownership_role === 'received') {
      conditions.push(eq(item_actions.target_item_id, item_id));
    } else {
      conditions.push(
        or(eq(item_actions.source_item_id, item_id), eq(item_actions.target_item_id, item_id))
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

  return and(...conditions);
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
