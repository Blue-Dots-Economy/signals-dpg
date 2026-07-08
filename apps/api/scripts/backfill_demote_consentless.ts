/**
 * One-time deploy-time backfill for the consent gate (aggregator-dpg#464).
 *
 * The consent gate makes a profile live only when `profile_creation` consent
 * exists. On-write classification only re-evaluates items that are created,
 * updated, or consent-accepted — so a profile that was already `live` before
 * this change and is never edited would stay live and discoverable WITHOUT
 * consent. This backfill closes that gap deterministically: it demotes every
 * `live` item that has no `profile_creation` consent row to `draft` in a single
 * pass. Those profiles return to live via `promoteItemOnProfileConsent` when the
 * owner consents on login / profile-select / voice-connect.
 *
 * Run once per environment after deploying the consent gate.
 *   Run from repo root:  pnpm db:backfill:consent:api
 *   Run inside apps/api: pnpm db:backfill:consent
 *
 * Idempotent — a second run demotes nothing (already-demoted rows are draft).
 *
 * Standalone pg pool (like db_init.ts / seed_service_users.ts) so the script
 * doesn't require the API's full env validation.
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
  // Demote every live item with no profile_creation consent. NOT-IN over the
  // consent ledger is set-based and covers all partitions in one statement.
  const result = await db.execute(sql`
    UPDATE items
    SET lifecycle_status = 'draft', updated_at = now()
    WHERE lifecycle_status = 'live'
      AND item_id NOT IN (
        SELECT item_id FROM consent_record
        WHERE level = 'item'
          AND consent_category = 'profile_creation'
          AND item_id IS NOT NULL
      )
    RETURNING item_id, item_network, item_domain
  `);

  const rows = (result as unknown as { rows: Array<{ item_network: string; item_domain: string }> }).rows ?? [];
  const byNetwork = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.item_network}/${r.item_domain}`;
    byNetwork.set(key, (byNetwork.get(key) ?? 0) + 1);
  }

  // eslint-disable-next-line no-console
  console.log(`backfill: demoted ${rows.length} live-but-consent-less profile(s) to draft`);
  for (const [key, count] of byNetwork) {
    // eslint-disable-next-line no-console
    console.log(`  ${key}: ${count}`);
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
