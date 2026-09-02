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
 */
import { sql, type SQL } from 'drizzle-orm';
import { BINDING_KEY_MESSAGE, isBindingKey, parseBindingKey } from '@dpg/schemas';
import {
  defaultAggregatorQuery,
  pickDefaultAggregator,
} from '../src/services/aggregator/default_aggregator.js';
import { argReader, createScriptDb, runScript, textArray } from './lib/script_db.js';

const { db, pool, rows } = createScriptDb();

interface Args {
  binding: string;
  dryRun: boolean;
  withProfileOnly: boolean;
  batch: number;
  actor: string;
}

function parseArgs(argv: string[]): Args {
  const args = argReader(argv);
  const binding = args.value('binding');
  if (!binding || !isBindingKey(binding)) {
    throw new Error(`--binding is required and ${BINDING_KEY_MESSAGE}`);
  }

  return {
    binding,
    dryRun: args.flag('dry-run'),
    withProfileOnly: args.flag('with-profile-only'),
    batch: args.number('batch', 500),
    actor: args.value('actor') ?? 'ops',
  };
}

/**
 * Resolve the binding's default through the SAME query and fail-closed rule the
 * runtime uses, so an ambiguous or missing default can never mean one thing to
 * the API and another to a bulk write over the whole population.
 */
async function resolveDefault(binding: string): Promise<string> {
  const claimants = await rows<{ id: string }>(defaultAggregatorQuery(binding));
  const { org_id } = pickDefaultAggregator(claimants, binding);

  if (!org_id) {
    throw new Error(
      claimants.length > 1
        ? `${claimants.length} orgs claim ${binding}: ${claimants.map((r) => r.id).join(', ')} — refusing to guess`
        : `no default aggregator configured for ${binding} — nominate one via POST /api/v1/admin/aggregator/default first`,
    );
  }
  return org_id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { network, domain } = parseBindingKey(args.binding);
  const orgId = await resolveDefault(args.binding);

  const profileFilter: SQL = args.withProfileOnly
    ? sql`AND EXISTS (
            SELECT 1 FROM items i
             WHERE i.created_by = u.id
               AND i.item_network = ${network}
               AND i.item_domain = ${domain}
          )`
    : sql``;

  /** The pre-default population — see the header for why this is exhaustive. */
  const untagged: SQL = sql`
    u.onboarded_by_org_id IS NULL
    AND u.onboarded_via IS NULL
    ${profileFilter}`;

  const counted = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM "user" u WHERE ${untagged}`,
  );
  const total = counted[0]?.n ?? 0;

  // eslint-disable-next-line no-console
  console.log(
    `backfill: ${total} untagged user(s) would be tagged to ${orgId} for ${args.binding}` +
      (args.dryRun ? ' (dry run)' : ''),
  );

  if (args.dryRun || total === 0) return;

  let tagged = 0;
  for (;;) {
    const updated = await rows<{ id: string }>(sql`
      UPDATE "user"
         SET onboarded_by_org_id = ${orgId},
             onboarded_by_default = true,
             onboarded_at = now(),
             updated_at = now()
       WHERE id IN (SELECT u.id FROM "user" u WHERE ${untagged} LIMIT ${args.batch})
      RETURNING id`);

    if (updated.length === 0) break;

    // Same audit trail the transfer writes: this is the first assignment of an
    // owner — and so of PII-decrypt rights — for these participants.
    await db.execute(sql`
      INSERT INTO participant_reassignment_audit
        (user_id, from_org_id, to_org_id, binding, reason, changed_by)
      SELECT u, NULL, ${orgId}, ${args.binding}, 'pre_default_backfill', ${args.actor}
        FROM unnest(${textArray(updated.map((r) => r.id))}) AS u`);

    tagged += updated.length;
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

runScript(main, pool, 'backfill');
