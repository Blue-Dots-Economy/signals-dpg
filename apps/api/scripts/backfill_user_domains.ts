/**
 * One-time deploy-time backfill for `user.domains` (U18 / single-role lock).
 *
 * The profile-create role lock now reads `user.domains` (the source of truth)
 * instead of deriving a lock live from held items. New users get `domains` set
 * at signup / on first create; EXISTING users have it NULL, which the lock
 * treats as "unset → any served domain allowed". This backfill closes that gap:
 * for every user with an empty `domains`, it sets the single role from the
 * domain of their EARLIEST-created item (mirroring the old held-item lock, which
 * pinned to the first item's domain). Users with no items are left empty and get
 * their role on first create.
 *
 * Run once per environment after deploying the user.domains lock.
 *   Run from repo root:  pnpm db:backfill:domains:api
 *   Run inside apps/api: pnpm db:backfill:domains
 *
 * Idempotent — only sets rows whose `domains` is NULL/empty, so a second run is
 * a no-op. Single-role by construction: it writes a one-element array and never
 * grows an existing one.
 *
 * Standalone pg pool (like backfill_demote_consentless.ts) so the script doesn't
 * require the API's full env validation.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';

dotenv.config({ path: '../../.env' });

const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

async function main() {
  // Set each empty-domains user's single role from their earliest item.
  // DISTINCT ON (created_by) ORDER BY created_at picks the first item's domain;
  // the WHERE keeps it idempotent (only NULL/empty rows are touched).
  const result = await db.execute(sql`
    UPDATE "user" u
    SET domains = ARRAY[sub.item_domain], updated_at = now()
    FROM (
      SELECT DISTINCT ON (created_by) created_by, item_domain
      FROM items
      ORDER BY created_by, created_at ASC
    ) sub
    WHERE sub.created_by = u.id
      AND (u.domains IS NULL OR cardinality(u.domains) = 0)
    RETURNING u.id, sub.item_domain
  `);

  const rows = (result as unknown as { rows: Array<{ item_domain: string }> }).rows ?? [];
  const byDomain = new Map<string, number>();
  for (const r of rows) byDomain.set(r.item_domain, (byDomain.get(r.item_domain) ?? 0) + 1);

  // eslint-disable-next-line no-console
  console.log(`backfill: set user.domains for ${rows.length} existing user(s)`);
  for (const [domain, count] of byDomain) {
    // eslint-disable-next-line no-console
    console.log(`  ${domain}: ${count}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('backfill failed:', err);
    await pool.end();
    process.exit(1);
  });
