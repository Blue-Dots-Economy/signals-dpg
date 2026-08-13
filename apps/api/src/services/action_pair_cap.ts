import { and, or, eq, notInArray, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import type { NetworkConfig } from '@dpg/config';
import { CANONICAL_BUCKETS } from '@/services/metrics/buckets';

// The metric_categories buckets that mean an action is DONE (no longer open):
// every canonical bucket except `create`. Reused from the metrics module so the
// two stay in lockstep if the bucket set ever changes.
const TERMINAL_BUCKETS = CANONICAL_BUCKETS.filter((b) => b !== 'create');

/**
 * Max concurrent OPEN actions per item pair (#370, original #422). One rule for
 * the whole pair — **bidirectional** (an open action A→B *or* B→A counts the
 * same) and **type-agnostic** (an open `apply` and an open `connect` between the
 * same two items share the one budget). Configured network-wide via
 * `max_actions_per_pair`; unset → 1.
 *
 * "Open" = not terminal. Terminal statuses (an action here no longer counts, so
 * the pair frees up) are the accept/reject/cancel buckets of every interaction's
 * `metric_categories`, plus a fallback set for interactions that declare none.
 * So once an existing action is accepted / completed / cancelled / rejected, a
 * fresh action between the pair is allowed again — matching #422.
 */

/** Thrown inside the perform transaction when the pair is already at the cap. */
export class ActionPairCapError extends Error {
  constructor() {
    super('ACTION_LIMIT_REACHED');
    this.name = 'ActionPairCapError';
  }
}

export function maxActionsPerPair(cfg: Pick<NetworkConfig, 'max_actions_per_pair'>): number {
  const n = cfg.max_actions_per_pair;
  return typeof n === 'number' && n > 0 ? n : 1;
}

/**
 * Network-wide set of statuses that DON'T count toward the pair cap. Union of
 * every interaction's accept/reject/cancel buckets, plus common terminal names
 * as a fallback for interactions with no `metric_categories` (e.g. blue_dot's
 * `connect` provider→provider).
 */
export function terminalStatuses(cfg: NetworkConfig): string[] {
  const set = new Set<string>([
    'accepted',
    'completed',
    'cancelled',
    'rejected',
    'declined',
    'withdrawn',
  ]);
  for (const action of Object.values(cfg.actions ?? {})) {
    for (const interaction of action.interactions ?? []) {
      const mc = (interaction as { metric_categories?: Record<string, string[] | undefined> | null })
        .metric_categories;
      if (!mc) continue;
      for (const bucket of TERMINAL_BUCKETS) {
        for (const status of mc[bucket] ?? []) set.add(status);
      }
    }
  }
  return [...set];
}

type TxLike = Parameters<Parameters<typeof import('@api/db/postgres/drizzle_config').db.transaction>[0]>[0];

/**
 * Race-safe pair-cap guard. MUST run inside the same transaction as the action
 * insert: it takes a pair-scoped advisory lock (so concurrent submits for the
 * same pair serialize), recounts the OPEN actions for the unordered
 * `{source, target}` pair regardless of type/direction, and throws
 * {@link ActionPairCapError} if the pair is already at/over `cap`. Existing
 * over-cap pairs are simply blocked from new actions — nothing is mutated.
 */
export async function assertPairCapAvailable(
  tx: TxLike,
  args: {
    network: string;
    sourceItemId: string;
    targetItemId: string;
    cap: number;
    terminal: string[];
  },
): Promise<void> {
  // Stable, order-independent lock key for the pair (sorted so A→B and B→A map
  // to the same lock). hashtextextended → bigint for pg_advisory_xact_lock.
  // Explicit codepoint comparator (not the default `.sort()`, and not
  // `localeCompare`): a lock key needs a locale-independent, stable total
  // order, and it satisfies typescript:S2871.
  const [a, b] = [args.sourceItemId, args.targetItemId].sort((x, y) => {
    if (x < y) return -1;
    return x > y ? 1 : 0;
  });
  const lockKey = `action_pair:${args.network}:${a}:${b}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  const rows = await tx
    .select({ open: sql<number>`count(*)::int` })
    .from(item_actions)
    .where(
      and(
        eq(item_actions.partition_network, args.network),
        or(
          and(
            eq(item_actions.source_item_id, args.sourceItemId),
            eq(item_actions.target_item_id, args.targetItemId),
          ),
          and(
            eq(item_actions.source_item_id, args.targetItemId),
            eq(item_actions.target_item_id, args.sourceItemId),
          ),
        ),
        notInArray(item_actions.action_status, args.terminal),
      ),
    );
  const open = Number(rows[0]?.open ?? 0);
  if (open >= args.cap) throw new ActionPairCapError();
}
