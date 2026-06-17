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
