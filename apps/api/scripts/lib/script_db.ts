/**
 * Shared plumbing for the standalone ops scripts.
 *
 * Every script in `apps/api/scripts/` builds its own pg pool rather than
 * importing the API's db client, so it doesn't have to satisfy the API's full
 * env validation to run a one-off migration or backfill. That is deliberate —
 * but it had been copy-pasted into every script, along with a hand-rolled
 * `--flag=value` parser. Both live here now.
 *
 * The six pre-existing scripts still carry their own copies; they can adopt
 * this without behaviour change (the connection-string precedence below is
 * exactly theirs), but this change does not touch them.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Connect using the same precedence every script uses: an explicit
 * `POSTGRES_URL`, else assembled from the discrete `POSTGRES_*` vars.
 *
 * @param envPath - Path to the root `.env`, relative to the script's cwd
 *   (`apps/api` when run through the package scripts). Defaults to the
 *   repo-root `.env` the other scripts read.
 */
export function createScriptDb(envPath = '../../.env') {
  dotenv.config({ path: envPath });

  const pgUrl =
    process.env.POSTGRES_URL ??
    `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

  const pool = new Pool({ connectionString: pgUrl, ssl: false });
  const db = drizzle(pool);

  /** Run a statement and get its rows, typed by the caller. */
  const rows = async <T = Record<string, unknown>>(query: SQL): Promise<T[]> => {
    const result = (await db.execute(query)) as unknown as { rows?: T[] };
    return result.rows ?? [];
  };

  return { db, pool, rows };
}

/**
 * A `text[]` bind for drizzle's `sql` template.
 *
 * Interpolating a JS array directly (`${ids}::text[]`) renders a record —
 * `($1, $2, $3)` — which Postgres rejects with `cannot cast type record to
 * text[]` (SQLSTATE 42846). Each element has to be its own parameter inside an
 * `ARRAY[...]` constructor.
 */
export const textArray = (values: string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/**
 * Reader for the `--flag` / `--flag=value` argv style the scripts use.
 *
 * @param argv - Usually `process.argv.slice(2)`.
 */
export function argReader(argv: string[]) {
  return {
    /** The value of `--name=value`, or undefined. */
    value: (name: string): string | undefined =>
      argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    /** Whether the bare `--name` flag is present. */
    flag: (name: string): boolean => argv.includes(`--${name}`),
    /** A numeric `--name=value`, or `fallback` when absent or unparseable. */
    number: (name: string, fallback: number): number => {
      const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      const parsed = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    },
  };
}

/**
 * Wrap a script's `main` so a crash always closes the pool and exits non-zero,
 * instead of leaving a hung process.
 */
export function runScript(main: () => Promise<void>, pool: Pool, label: string): void {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error(`${label} failed:`, err);
      await pool.end();
      process.exit(1);
    });
}
