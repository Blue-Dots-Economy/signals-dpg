import { count } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import { getActionInteraction, type NetworkConfigDocument } from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { buildOwnedActionsWhere } from '@/services/actions/owned_actions';

export interface OwnedActionViewCounts {
  all: number;
  needs_response: number;
  ready_to_export: number;
  sent: number;
}

interface CountOptions {
  action_type?: string[];
  item_ids?: string[];
  getNetworkConfig: (network: string) => Promise<NetworkConfigDocument | null>;
  onError?: (err: unknown) => void;
}

/**
 * Totals for the My Actions saved views, over the caller's own actions scoped
 * by profile and action type only — status, direction, search and facets are
 * what the views themselves vary, so they are not applied here. One grouped
 * query; each group's interaction decides which statuses count:
 *
 * - `needs_response`: received, and the status is in the interaction's
 *   `metric_categories.create` bucket (a request still waiting on the caller).
 * - `ready_to_export`: the caller's side may export this interaction
 *   (`export.requester_domains`) and the status reveals the counterparty.
 * - `sent`: initiated by the caller, any status.
 *
 * A group whose interaction cannot be resolved still counts toward `all` /
 * `sent`, never toward the status-dependent views (fail closed).
 */
interface CountGroup {
  action_type: string;
  action_status: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  initiated: boolean;
  received: boolean;
  n: number;
}

/** The status-dependent views one group counts toward, per its interaction. */
function addStatusViews(counts: OwnedActionViewCounts, g: CountGroup, cfg: NetworkConfigDocument): void {
  const interaction = getActionInteraction(cfg, {
    actionType: g.action_type,
    fromNetwork: g.source_item_network,
    fromDomain: g.source_item_domain,
    fromItemType: g.source_item_type,
    toNetwork: g.target_item_network,
    toDomain: g.target_item_domain,
    toItemType: g.target_item_type,
  });
  if (g.received && (interaction.metric_categories?.create ?? []).includes(g.action_status)) {
    counts.needs_response += g.n;
  }
  const requesters = interaction.export?.requester_domains ?? [];
  const mySides = [
    ...(g.received ? [g.target_item_domain] : []),
    ...(g.initiated ? [g.source_item_domain] : []),
  ];
  if (
    mySides.some((d) => requesters.includes(d)) &&
    interaction.reveals_pii_on_status.includes(g.action_status)
  ) {
    counts.ready_to_export += g.n;
  }
}

export async function countOwnedActionsForViews(
  userId: string,
  opts: CountOptions
): Promise<OwnedActionViewCounts> {
  // Grouped by the owner columns themselves (not `owner = $n` expressions —
  // Postgres treats two placeholders as different expressions, so an
  // expression in both SELECT and GROUP BY is rejected). Sides are derived below.
  const groups = await db
    .select({
      action_type: item_actions.action_type,
      action_status: item_actions.action_status,
      source_item_network: item_actions.source_item_network,
      source_item_domain: item_actions.source_item_domain,
      source_item_type: item_actions.source_item_type,
      target_item_network: item_actions.target_item_network,
      target_item_domain: item_actions.target_item_domain,
      target_item_type: item_actions.target_item_type,
      source_item_owner: item_actions.source_item_owner,
      target_item_owner: item_actions.target_item_owner,
      n: count(),
    })
    .from(item_actions)
    .where(
      buildOwnedActionsWhere(userId, {
        action_type: opts.action_type,
        item_ids: opts.item_ids,
        ownership_role: 'all',
      })
    )
    .groupBy(
      item_actions.action_type,
      item_actions.action_status,
      item_actions.source_item_network,
      item_actions.source_item_domain,
      item_actions.source_item_type,
      item_actions.target_item_network,
      item_actions.target_item_domain,
      item_actions.target_item_type,
      item_actions.source_item_owner,
      item_actions.target_item_owner
    );

  const counts: OwnedActionViewCounts = { all: 0, needs_response: 0, ready_to_export: 0, sent: 0 };
  for (const row of groups) {
    const g: CountGroup = {
      ...row,
      n: Number(row.n),
      initiated: row.source_item_owner === userId,
      received: row.target_item_owner === userId,
    };
    counts.all += g.n;
    if (g.initiated) counts.sent += g.n;
    try {
      const cfg = await opts.getNetworkConfig(g.target_item_network);
      if (cfg) addStatusViews(counts, g, cfg);
    } catch (err) {
      opts.onError?.(err);
    }
  }
  return counts;
}
