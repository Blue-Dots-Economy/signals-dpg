import type { db } from '@api/db/postgres/drizzle_config';

/**
 * The "db client or open transaction" executor type. A leaf module so
 * `default_aggregator.ts` can use it without an import cycle through
 * `item_service.ts`.
 *
 * `import type` only: this module must never pull the configured db client into
 * a runtime graph, so standalone ops scripts (own pool, no API env validation)
 * can import anything that uses it.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbOrTx = typeof db | Tx;
