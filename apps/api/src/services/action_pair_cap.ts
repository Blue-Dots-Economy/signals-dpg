import { and, or, eq, notInArray, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import type { NetworkConfig } from '@dpg/config';
import { CANONICAL_BUCKETS } from '@/services/metrics/buckets';

// metric_categories buckets that mean an action is no longer open: every
// canonical bucket except `create`. Shared with the metrics module.
const TERMINAL_BUCKETS = CANONICAL_BUCKETS.filter((b) => b !== 'create');

/**
 * Max concurrent open actions per item pair. The cap is bidirectional (A→B and
 * B→A count the same) and type-agnostic (`apply` and `connect` share it), set
 * network-wide via `max_actions_per_pair` (default 1). Once an action reaches a
 * terminal status the pair frees up.
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
 * Network-wide statuses that don't count toward the pair cap: every
 * interaction's non-`create` metric buckets, plus common terminal names for
 * interactions with no `metric_categories`.
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
 * Race-safe pair-cap guard. Must run in the same transaction as the action
 * insert: a pair-scoped advisory lock serializes concurrent submits, then the
 * open actions for the unordered pair are recounted. Throws
 * {@link ActionPairCapError} at or over `cap`; existing over-cap pairs are
 * left as they are.
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
  // Sorted so A→B and B→A share one lock. Code-point comparator, not
  // `localeCompare`: the key needs a locale-independent order (and it
  // satisfies typescript:S2871).
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
