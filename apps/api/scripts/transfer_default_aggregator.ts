/**
 * SS-3 (#640) — transfer default-tagged participants after a default change.
 *
 * Changing which aggregator is the default sends FUTURE signups to the new one
 * automatically. This script moves the ones already tagged to the old default,
 * per #640 Q2.
 *
 * This is not a relabel. `user.onboarded_by_org_id` is the tenancy key for
 * participant reads (`participant_read.ts`), action authorisation
 * (`_resolve_acting_actor.ts`), the aggregator dashboard and export, and **PII
 * decryption** (`participant_decrypt.ts`). Moving it hands PII access from one
 * organisation to another, so every move is audited.
 *
 * Three things this gets right that a naive UPDATE would not:
 *
 *  1. **Scope.** Only `onboarded_by_default` users move. Participants the old
 *     org genuinely onboarded itself stay with it. The flag is used rather than
 *     `onboarded_via` because `onboarded_via` is written from the request's
 *     `channel` field — caller-controlled input has no business deciding a PII
 *     authorisation boundary — and because a cold-voice default tag leaves
 *     `onboarded_via = 'voice'`, so a `via`-based filter would silently skip
 *     half the population.
 *
 *  2. **`item_metrics` must be DELETEd, not upserted.** That table holds its
 *     own copy of `onboarded_by_org_id` (`schema/metrics.ts`), recompute is
 *     pinned per aggregator (`recompute.ts`) and there is no DELETE anywhere in
 *     it. So the new owner's recompute inserts its own rows and never touches
 *     the old owner's: without an explicit delete the OLD aggregator keeps
 *     seeing the moved participants in its dashboard and export forever — and
 *     `dashboard.ts` reasons from that copy to skip an authorisation check
 *     before revealing private display names. The stale rows are a PII leak,
 *     not a reporting artefact.
 *
 *  3. **Batching.** This can touch an entire inbound population.
 *
 *   Run from repo root:  pnpm db:transfer:default-aggregator:api
 *   Run inside apps/api: pnpm db:transfer:default-aggregator
 *
 *   --binding=<network>/<domain>   required
 *   --from=<org_id>                required; the previous default
 *   --to=<org_id>                  the new default; defaults to whichever org
 *                                  currently holds the binding
 *   --actor=<id>                   recorded as changed_by (default 'ops')
 *   --dry-run                      report only, write nothing
 *   --batch=<n>                    users per transaction (default 500)
 *
 * Idempotent — a second run finds nothing, because the first moved the tag.
 *
 * NOT decided by this script (open product questions on the follow-up issue):
 * whether the NEW owner may decrypt PII gathered under the OLD one, and whether
 * the old owner should lose access to what it collected. This script implements
 * the transfer only; it deletes the old owner's metrics rows, which cuts off
 * the dashboard/private-name path, but the decrypt route's own tenure rules are
 * untouched.
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
  from: string;
  to?: string;
  actor: string;
  dryRun: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  const binding = get('binding');
  if (!binding || !/^[a-z0-9_]+\/[a-z0-9_]+$/.test(binding)) {
    throw new Error('--binding=<network>/<domain> is required, e.g. --binding=blue_dot/seeker');
  }
  const from = get('from');
  if (!from) throw new Error('--from=<org_id> is required (the previous default aggregator)');

  return {
    binding,
    from,
    to: get('to'),
    actor: get('actor') ?? 'ops',
    dryRun: argv.includes('--dry-run'),
    batch: Number(get('batch') ?? 500),
  };
}

async function resolveTarget(binding: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const holders = (await db.execute(sql`
    SELECT id FROM organization
     WHERE default_for_bindings && ARRAY[${binding}]::text[]
       AND type = 'aggregator'
     LIMIT 2
  `)) as unknown as { rows: Array<{ id: string }> };

  if (holders.rows.length === 0) {
    throw new Error(`no default aggregator configured for ${binding}; pass --to=<org_id> explicitly`);
  }
  if (holders.rows.length > 1) {
    throw new Error(
      `${holders.rows.length} orgs claim ${binding}: ${holders.rows.map((r) => r.id).join(', ')} — refusing to guess`,
    );
  }
  return holders.rows[0].id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [network, domain] = args.binding.split('/');
  const to = await resolveTarget(args.binding, args.to);

  if (to === args.from) throw new Error('--from and --to are the same org; nothing to transfer');

  const counted = (await db.execute(sql`
    SELECT count(*)::int AS n
      FROM "user"
     WHERE onboarded_by_org_id = ${args.from}
       AND onboarded_by_default
  `)) as unknown as { rows: Array<{ n: number }> };
  const total = counted.rows[0]?.n ?? 0;

  // eslint-disable-next-line no-console
  console.log(
    `transfer: ${total} default-tagged participant(s) move ${args.from} -> ${to} for ${args.binding}` +
      (args.dryRun ? ' (dry run)' : ''),
  );

  if (args.dryRun || total === 0) return;

  let moved = 0;
  for (;;) {
    const batchMoved = await db.transaction(async (tx) => {
      const picked = (await tx.execute(sql`
        SELECT id FROM "user"
         WHERE onboarded_by_org_id = ${args.from}
           AND onboarded_by_default
         LIMIT ${args.batch}
      `)) as unknown as { rows: Array<{ id: string }> };

      const ids = picked.rows.map((r) => r.id);
      if (ids.length === 0) return 0;

      await tx.execute(sql`
        UPDATE "user"
           SET onboarded_by_org_id = ${to}, updated_at = now()
         WHERE id = ANY(${textArray(ids)})
      `);

      await tx.execute(sql`
        INSERT INTO participant_reassignment_audit
          (user_id, from_org_id, to_org_id, binding, reason, changed_by)
        SELECT u, ${args.from}, ${to}, ${args.binding}, 'default_change', ${args.actor}
          FROM unnest(${textArray(ids)}) AS u
      `);

      // The old owner's denormalised copy. An upsert cannot fix this — the new
      // owner's recompute writes its own rows and never touches these — so the
      // stale rows have to be deleted, or the old aggregator keeps dashboard
      // and private-display-name access to participants it no longer owns.
      await tx.execute(sql`
        DELETE FROM item_metrics
         WHERE onboarded_by_org_id = ${args.from}
           AND owner_user_id = ANY(${textArray(ids)})
           AND item_network = ${network}
           AND item_domain = ${domain}
      `);

      return ids.length;
    });

    if (batchMoved === 0) break;
    moved += batchMoved;
    // eslint-disable-next-line no-console
    console.log(`  moved ${moved}/${total}`);
  }

  // eslint-disable-next-line no-console
  console.log(`transfer: moved ${moved} participant(s) to ${to}`);
  // eslint-disable-next-line no-console
  console.log(
    `NOTE: run the metrics recompute for ${to} so its dashboard picks up the ` +
      `transferred participants — the delete above only removed ${args.from}'s stale rows.`,
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('transfer failed:', err);
    await pool.end();
    process.exit(1);
  });
