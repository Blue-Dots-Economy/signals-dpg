/**
 * SS-3 (#640) — backfill the pre-default population.
 *
 * Per #640 Q1 the default aggregator arrives POST-launch: a real aggregator
 * registers and is approved first, and only then is nominated. Everyone who
 * self-signed-up before that has `onboarded_by_org_id = NULL` — nobody
 * responsible for verifying them, and (once `owner_required` is configured) a
 * profile that cannot be published.
 *
 * The population is determinate, not a heuristic. Every path that writes the
 * tag also writes `onboarded_via` in the same statement, and the default fill
 * is skipped entirely when no default is configured, so neither column is set:
 *
 *   onboarded_by_org_id IS NULL AND onboarded_via IS NULL
 *
 * That is the only discriminator available — there is no other marker that
 * separates "self-signed-up before a default existed" from "untagged for some
 * other reason". It therefore also covers users who never created a profile;
 * pass --with-profile-only to exclude them.
 *
 * Backfilled users get `onboarded_by_default = true`, which is what the
 * transfer script scopes on. Deliberately NOT `onboarded_via` — that column is
 * written from the request's `channel` field, so a caller can set it, and this
 * flag decides who is handed PII-decrypt rights over whom.
 *
 * Batched: this can touch an entire inbound population.
 *
 *   Run from repo root:  pnpm db:backfill:default-aggregator:api
 *   Run inside apps/api: pnpm db:backfill:default-aggregator
 *
 *   --binding=<network>/<domain>   required; which default to apply
 *   --dry-run                      report only, write nothing
 *   --with-profile-only            skip users who have no profile item
 *   --batch=<n>                    rows per statement (default 500)
 *   --actor=<id>                   recorded as changed_by (default 'ops')
 *
 * Idempotent — a second run finds nothing, because the first run set the tag.
 *
 * Standalone pg pool (like the other backfills) so the script doesn't require
 * the API's full env validation.
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

/**
 * A `text[]` bind for drizzle's `sql` template.
 *
 * Interpolating a JS array directly (`${ids}::text[]`) renders a record —
 * `($1, $2, $3)` — which Postgres rejects with `cannot cast type record to
 * text[]` (42846). Each element must be its own parameter inside an ARRAY[...]
 * constructor.
 */
const textArray = (values: string[]) =>
  sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

interface Args {
  binding: string;
  dryRun: boolean;
  withProfileOnly: boolean;
  batch: number;
  actor: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  const binding = get('binding');
  if (!binding || !/^[a-z0-9_]+\/[a-z0-9_]+$/.test(binding)) {
    throw new Error('--binding=<network>/<domain> is required, e.g. --binding=blue_dot/seeker');
  }

  return {
    binding,
    dryRun: argv.includes('--dry-run'),
    withProfileOnly: argv.includes('--with-profile-only'),
    batch: Number(get('batch') ?? 500),
    actor: get('actor') ?? 'ops',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [network, domain] = args.binding.split('/');

  // Same fail-closed resolution the runtime uses: two claimants means no
  // default, because an arbitrary pick would hand PII rights to a coin flip.
  const holders = (await db.execute(sql`
    SELECT id FROM organization
     WHERE default_for_bindings && ARRAY[${args.binding}]::text[]
       AND type = 'aggregator'
     LIMIT 2
  `)) as unknown as { rows: Array<{ id: string }> };

  if (holders.rows.length === 0) {
    throw new Error(
      `no default aggregator configured for ${args.binding} — nominate one via POST /api/v1/admin/aggregator/default first`,
    );
  }
  if (holders.rows.length > 1) {
    throw new Error(
      `${holders.rows.length} orgs claim ${args.binding}: ${holders.rows.map((r) => r.id).join(', ')} — refusing to guess`,
    );
  }
  const orgId = holders.rows[0].id;

  const profileFilter = args.withProfileOnly
    ? sql`AND EXISTS (
            SELECT 1 FROM items i
             WHERE i.created_by = u.id
               AND i.item_network = ${network}
               AND i.item_domain = ${domain}
          )`
    : sql``;

  const counted = (await db.execute(sql`
    SELECT count(*)::int AS n
      FROM "user" u
     WHERE u.onboarded_by_org_id IS NULL
       AND u.onboarded_via IS NULL
       ${profileFilter}
  `)) as unknown as { rows: Array<{ n: number }> };
  const total = counted.rows[0]?.n ?? 0;

  // eslint-disable-next-line no-console
  console.log(
    `backfill: ${total} untagged user(s) would be tagged to ${orgId} for ${args.binding}` +
      (args.dryRun ? ' (dry run)' : ''),
  );

  if (args.dryRun || total === 0) return;

  let tagged = 0;
  for (;;) {
    const updated = (await db.execute(sql`
      UPDATE "user"
         SET onboarded_by_org_id = ${orgId},
             onboarded_by_default = true,
             onboarded_at = now(),
             updated_at = now()
       WHERE id IN (
         SELECT u.id
           FROM "user" u
          WHERE u.onboarded_by_org_id IS NULL
            AND u.onboarded_via IS NULL
            ${profileFilter}
          LIMIT ${args.batch}
       )
      RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };

    if (updated.rows.length === 0) break;

    // Same audit trail the transfer writes: this is the first assignment of an
    // owner (and so of PII-decrypt rights) for these participants.
    const ids = updated.rows.map((r) => r.id);
    await db.execute(sql`
      INSERT INTO participant_reassignment_audit
        (user_id, from_org_id, to_org_id, binding, reason, changed_by)
      SELECT u, NULL, ${orgId}, ${args.binding}, 'pre_default_backfill', ${args.actor}
        FROM unnest(${textArray(ids)}) AS u
    `);

    tagged += updated.rows.length;
    // eslint-disable-next-line no-console
    console.log(`  tagged ${tagged}/${total}`);
  }

  // eslint-disable-next-line no-console
  console.log(`backfill: tagged ${tagged} user(s) to ${orgId}`);
  // eslint-disable-next-line no-console
  console.log(
    'NOTE: item_metrics carries its own copy of onboarded_by_org_id. Run the ' +
      'metrics recompute for this aggregator so its dashboard reflects the backfill.',
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('backfill failed:', err);
    await pool.end();
    process.exit(1);
  });
