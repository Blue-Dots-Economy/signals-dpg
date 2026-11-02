import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { databasesConfig } from '../../src/config';
import { Pool, types as pgTypes } from '@dpg/database';

// Coerce every timestamp type into a JS Date, matching Drizzle's query builder
// even for raw db.execute(sql`...`) queries (e.g. metrics recompute); otherwise
// they can come back as strings and date arithmetic throws. `to_date` in
// src/services/metrics/recompute.ts is the per-call backstop.
//
//   1082 = DATE
//   1114 = TIMESTAMP (without time zone)
//   1184 = TIMESTAMPTZ
const toDateOrNull = (v: string | null): Date | null => (v === null ? null : new Date(v));
pgTypes.setTypeParser(1082, toDateOrNull as unknown as (val: string) => Date);
pgTypes.setTypeParser(1114, toDateOrNull as unknown as (val: string) => Date);
pgTypes.setTypeParser(1184, toDateOrNull as unknown as (val: string) => Date);

// Exported so graceful shutdown can drain the connection pool (`pool.end()`).
export const pool = new Pool({
  connectionString: databasesConfig.pg_url,
  ssl: false,
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });
