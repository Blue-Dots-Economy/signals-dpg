import { Pool } from 'pg';
import type { E2EConfig } from './config.js';

/**
 * Thin Postgres access for row-level assertions and cleanup.
 *
 * The suite is black-box by default; this is the one seam that reaches behind
 * the API, and it exists because several invariants are only observable in the
 * rows (retire's PII scrub, the consent ledger's append-only shape, the
 * cleanup residue check). Gated by the `db` capability so a shared dev target
 * skips-and-reports rather than failing.
 */

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export class DbNotConfiguredError extends Error {
  override name = 'DbNotConfiguredError';
}

export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url, max: 2 });
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    close: () => pool.end(),
  };
}

export function requireDb(cfg: E2EConfig): Db {
  if (!cfg.db.url) {
    throw new DbNotConfiguredError(
      'direct DB access is not configured — set E2E_DB_URL (or config.db.url) ' +
        'to the local Postgres URL. Gate the caller with requireCapabilities(test, caps, ["db"]).',
    );
  }
  return openDb(cfg.db.url);
}
