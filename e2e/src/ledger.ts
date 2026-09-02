import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// Explicit `.ts` extension, unlike the rest of src/ (see schema.ts for the
// normal `.js`-specifier convention): this module is reached directly by
// `node --experimental-strip-types` via ledger.test.ts, which has no bundler
// resolving `.js` specifiers back to their `.ts` source — a `.js` specifier
// here resolves to nothing and throws ERR_MODULE_NOT_FOUND at test time
// (verified). Playwright's own TS loader resolves an explicit `.ts` path
// just as well, so this works in both run modes.
import { RUN_ID } from './identities.ts';

/**
 * A record of every row this run created, so teardown is exact rather than a
 * guess.
 *
 * Tagging identifiers (identities.ts) reaches most rows, but not all: a
 * `consent_record` row carries no name to tag, and an `item_actions` row
 * written by the counterparty during a bulk flow was never ours to name. This
 * ledger is the second scope; the row-count snapshot diff in cleanup.sh is the
 * third, and the only one that catches something we forgot to do both.
 *
 * Append-only JSONL because a killed run must still leave a readable file —
 * readLedger drops a truncated final line rather than throwing.
 */

/**
 * Reverse-dependency order: children before the parents they reference.
 *
 * This list is the union of every table cleanup.sh knows how to snapshot and
 * (once ledgered) delete — not every table here is ledgered by this task yet.
 * Only `items` and `user` are recorded so far (see flows.ts / auth.ts); the
 * rest are still reached only via cleanup.sh's tag sweep and residue check
 * (scope 2 / scope 3), and stay in this order so a later task can start
 * calling `recordCreated` for them without reordering anything.
 *
 * `item_locations` and `session` are deliberately NOT here: neither exists as
 * a table. `item_locations` is a jsonb column on `items` (see
 * apps/api/db/postgres/schema.sql), and better-auth here stores sessions in
 * Redis via `secondaryStorage` (packages/auth/src/config.ts), not Postgres —
 * confirmed by querying the live schema (`\dt` on the shared `dpg-db`
 * container lists no `session` relation). Listing either here would make
 * cleanup.sh issue a `DELETE`/`SELECT count(*)` against a table that does not
 * exist, which is exactly the silently-swallowed failure this task exists to
 * prevent.
 */
export const CLEANUP_TABLES = [
  'action_events',
  'item_actions',
  'item_search',
  'item_metrics',
  'consent_record',
  'items',
  'account',
  'verification',
  'member',
  'organization',
  'user',
] as const;

export function ledgerPath(runId: string = RUN_ID): string {
  return resolve(import.meta.dirname, '..', 'run', runId, 'created.jsonl');
}

export function recordCreated(table: string, pk: string, runId: string = RUN_ID): void {
  const path = ledgerPath(runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ table, pk })}\n`);
}

export function readLedger(runId: string = RUN_ID): Array<{ table: string; pk: string }> {
  const path = ledgerPath(runId);
  if (!existsSync(path)) return [];
  const out: Array<{ table: string; pk: string }> = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as { table: string; pk: string });
    } catch {
      // A killed run can leave a partial final line. Dropping it is correct:
      // the row it described may not have been created either.
    }
  }
  return out;
}
