import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { databasesConfig } from '../../src/config';
import { Pool, types as pgTypes } from '@dpg/database';

// Force node-postgres to coerce every timestamp shape into a JS Date — match
// Drizzle's high-level query-builder behavior even when we drop down to raw
// db.execute(sql`...`) for hand-written queries (e.g. metrics recompute).
//
// Without this, raw SQL results come back as strings for some pg builds /
// type-parser overrides, and date arithmetic downstream throws
// `getTime is not a function`. See `to_date` in
// apps/api/src/services/metrics/recompute.ts for the per-call defensive
// coercion that backstops this parser config.
//
//   1082 = DATE
//   1114 = TIMESTAMP (without time zone)
//   1184 = TIMESTAMPTZ
const toDateOrNull = (v: string | null): Date | null => (v === null ? null : new Date(v));
pgTypes.setTypeParser(1082, toDateOrNull as unknown as (val: string) => Date);
pgTypes.setTypeParser(1114, toDateOrNull as unknown as (val: string) => Date);
pgTypes.setTypeParser(1184, toDateOrNull as unknown as (val: string) => Date);

const pool = new Pool({
  connectionString: databasesConfig.pg_url,
  ssl: false,
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });
