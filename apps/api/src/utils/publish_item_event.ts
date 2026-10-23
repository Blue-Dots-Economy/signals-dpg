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

/** An item's identity without the operation. */
export type ItemEventKey = Omit<ItemEvent, 'op'>;

type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

/**
 * Best-effort publish of an item mutation to the search ingestion stream.
 * Never throws: a Redis outage must not break the item write; the
 * signals-search reconciliation sweep is the backstop.
 */
export async function publishItemEvent(event: ItemEvent, logger?: WarnLogger): Promise<void> {
  try {
    await redis.xadd(
      databasesConfig.ingest_stream,
      // Approximate trim keeps the stream bounded cheaply (INGEST_STREAM_MAXLEN).
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
 * Publishes the same op for several items, de-duplicated by full key, for
 * paths that change more than one item (e.g. an age write that promotes
 * drafts alongside the requested item). Best-effort per item: one failure
 * does not stop the rest.
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
