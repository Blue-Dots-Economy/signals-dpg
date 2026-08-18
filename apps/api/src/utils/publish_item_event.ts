import { redis } from '@api/db/secondary/redis';
import { databasesConfig } from '@/config';

export type ItemEventOp = 'upsert' | 'delete';

export interface ItemEvent {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  op: ItemEventOp;
}

/** An item's identity without the operation — what a caller carries around when
 *  it knows an item changed but not yet why. See `publishItemEvents`. */
export type ItemEventKey = Omit<ItemEvent, 'op'>;

type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

/**
 * Best-effort publish of an item mutation to the search ingestion stream.
 * Mirrors invalidateItemFetchCache: never throws — a Redis outage must not
 * break the item write. The signals-search reconciliation sweep is the backstop.
 */
export async function publishItemEvent(event: ItemEvent, logger?: WarnLogger): Promise<void> {
  try {
    await redis.xadd(
      databasesConfig.ingest_stream,
      // Approximate trim (`~`) keeps the stream bounded without the per-call
      // cost of exact trimming; acked entries would otherwise accumulate
      // forever in the shared Redis. See INGEST_STREAM_MAXLEN.
      'MAXLEN', '~', databasesConfig.ingest_stream_maxlen,
      '*',
      'item_network', event.item_network,
      'item_domain', event.item_domain,
      'item_type', event.item_type,
      'item_id', event.item_id,
      'op', event.op,
      'occurred_at', new Date().toISOString(),
    );
  } catch (err) {
    (logger ?? console).warn({ err, item_id: event.item_id }, 'publishItemEvent failed (best-effort)');
  }
}

/**
 * Publish the same op for several items, de-duplicated by full key (#557).
 *
 * For paths that change more than one item in a request — e.g. an age write that
 * promotes every eligible draft the user owns (`promoteEligibleDraftsForUser`)
 * alongside the item the request itself touched. De-duplication matters because
 * those two sets overlap: the worker is idempotent, but a duplicate event still
 * costs a needless read.
 *
 * Sequential, and best-effort per item like `publishItemEvent` — one item's Redis
 * failure must not stop the rest from being published.
 */
export async function publishItemEvents(
  keys: readonly ItemEventKey[],
  op: ItemEventOp,
  logger?: WarnLogger,
): Promise<void> {
  const seen = new Set<string>();
  for (const key of keys) {
    const id = `${key.item_network}/${key.item_domain}/${key.item_type}/${key.item_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    await publishItemEvent({ ...key, op }, logger);
  }
}
