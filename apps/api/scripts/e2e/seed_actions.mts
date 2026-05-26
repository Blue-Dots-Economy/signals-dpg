/**
 * Drive Purple Dot connect actions across both domains, then backdate
 * timestamps so the dashboard rollup distributes items across all four
 * profile_status buckets (new / active / at_risk / inactive).
 *
 * Flow:
 *   1. Discover seekers + providers via direct DB query (test-fixture
 *      privilege — actions still go through real HTTP).
 *   2. For each (seeker, distribution-plan-row): create connect via
 *      /action/perform (Plan A on-behalf-of), optionally transition the
 *      action_status directly via PG UPDATE (see transitionActionStatus for why).
 *   3. UPDATE items.created_at to land the item at the target item_age_days.
 *   4. UPDATE item_actions.created_at to land the action at the target
 *      action_age_days. updated_at is left alone (recompute uses created_at).
 *   5. Two provider→seeker connects to verify metric_categories: null exclusion.
 *
 * Env:
 *   SIGNALS_API_URL     e.g. http://localhost:2742
 *   SEEKER_ORG_ID       Signals org id
 *   SEEKER_APIKEY       Signals API key for seeker aggregator
 *   PROVIDER_ORG_ID     Signals org id
 *   PROVIDER_APIKEY     Signals API key for provider aggregator
 *   POSTGRES_URL        (or individual POSTGRES_* vars — same as other seed scripts)
 *
 * Module resolution note: this file lives under apps/api/scripts/e2e/ so that
 * drizzle-orm, pg, and @dpg/* resolve via apps/api/node_modules. Following
 * the same pattern as apps/api/scripts/seed_purple_dot.ts: workspace deps are
 * dynamically imported after env validation so a missing-env error is reported
 * before any module-not-found noise.
 *
 * Idempotency: re-running on the same data may produce 409 from /action/perform
 * if an action already exists for the (source, target, type) tuple. The
 * script catches 409 and skips to the update step using the existing action_id.
 * Timestamp UPDATEs are idempotent by construction.
 */
import dotenv from 'dotenv';

// Load .env from the repo root (two levels up from apps/api).
dotenv.config({ path: '../../.env' });

const signalsUrl = required('SIGNALS_API_URL');
const seekerOrgId = required('SEEKER_ORG_ID');
const providerOrgId = required('PROVIDER_ORG_ID');
const seekerApiKey = required('SEEKER_APIKEY');
const providerApiKey = required('PROVIDER_APIKEY');

// Local dev hack: when SIGNALS_API_URL points at localhost over HTTPS,
// the cert is self-signed. Mirror the QR submitter's TLS-bypass for
// the local case only.
const sigHost = (() => {
  try {
    return new URL(signalsUrl).hostname;
  } catch {
    return '';
  }
})();
if (sigHost === 'localhost' || sigHost === '127.0.0.1' || sigHost === '::1') {
  if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn(
      `[e2e] WARN: NODE_TLS_REJECT_UNAUTHORIZED=0 for localhost target (self-signed cert).`,
    );
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

interface ItemRef {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  owner_user_id: string;
}

type Bucket = 'create' | 'accept' | 'reject' | 'cancel';
type Status = 'new' | 'active' | 'at_risk' | 'inactive';

interface PlanRow {
  item_age_days: number;
  action: null | { bucket: Bucket; age_days: number };
  expected_status: Status;
}

/**
 * Deterministic plan to exercise every profile_status bucket. Lengths and
 * action-age values are chosen against the canonical status_rules template
 * shipped in network.json:
 *   new      ← item_age_days <= 7
 *   active   ← days_since_last in [create, accept] <= 30
 *   at_risk  ← days_since_last in [create, accept, reject] between [31, 90]
 *   inactive ← default tail
 */
const DISTRIBUTION_PLAN: ReadonlyArray<PlanRow> = [
  { item_age_days: 2,   action: { bucket: 'create',  age_days: 1   }, expected_status: 'new' },
  { item_age_days: 5,   action: { bucket: 'create',  age_days: 2   }, expected_status: 'new' },
  { item_age_days: 15,  action: { bucket: 'create',  age_days: 10  }, expected_status: 'active' },
  { item_age_days: 20,  action: { bucket: 'accept',  age_days: 15  }, expected_status: 'active' },
  { item_age_days: 25,  action: { bucket: 'accept',  age_days: 5   }, expected_status: 'active' },
  { item_age_days: 60,  action: { bucket: 'create',  age_days: 45  }, expected_status: 'at_risk' },
  { item_age_days: 70,  action: { bucket: 'reject',  age_days: 50  }, expected_status: 'at_risk' },
  { item_age_days: 80,  action: { bucket: 'accept',  age_days: 60  }, expected_status: 'at_risk' },
  { item_age_days: 100, action: null,                                  expected_status: 'inactive' },
  { item_age_days: 120, action: { bucket: 'cancel',  age_days: 100 }, expected_status: 'inactive' },
];

const STATUS_FOR_BUCKET: Record<Exclude<Bucket, 'create'>, string> = {
  accept: 'accepted',
  reject: 'rejected',
  cancel: 'cancelled',
};

// Defer workspace + heavy deps until after env validation (matches seed_purple_dot.ts).
const { items, item_actions } = await import('@dpg/database');
const { user } = await import('../../db/postgres/schema/auth.js');
const { eq, and, sql } = await import('drizzle-orm');
const { Pool } = await import('pg');
const { drizzle } = await import('drizzle-orm/node-postgres');

// Mirror the type-parser setup from apps/api/db/postgres/drizzle_config.ts
// so raw db.execute() calls return Date objects rather than strings.
const { types: pgTypes } = await import('pg');
const toDateOrNull = (v: string | null): Date | null => (v === null ? null : new Date(v));
pgTypes.setTypeParser(1082, toDateOrNull as unknown as (val: string) => Date);
pgTypes.setTypeParser(1114, toDateOrNull as unknown as (val: string) => Date);
pgTypes.setTypeParser(1184, toDateOrNull as unknown as (val: string) => Date);

const pgUrl =
  process.env['POSTGRES_URL'] ??
  `postgres://${process.env['POSTGRES_USER']}:${process.env['POSTGRES_PASSWORD']}@${process.env['POSTGRES_HOST'] ?? '127.0.0.1'}:${process.env['POSTGRES_PORT'] ?? process.env['DATABASE_PORT'] ?? '5432'}/${process.env['POSTGRES_DB']}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

async function discover(domain: 'seeker' | 'provider', orgId: string): Promise<ItemRef[]> {
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      owner_user_id: items.created_by,
    })
    .from(items)
    .innerJoin(user, eq(user.id, items.created_by))
    .where(
      and(
        eq(items.item_network, 'purple_dot'),
        eq(items.item_domain, domain),
        eq(user.onboardedByOrgId, orgId),
      ),
    );
  return rows;
}

const allSeekers = await discover('seeker', seekerOrgId);
const providers = await discover('provider', providerOrgId);

if (allSeekers.length === 0) {
  console.error('No seekers discovered. Did the QR submission step complete?');
  process.exit(1);
}
if (providers.length === 0) {
  console.error('No providers discovered. Did the bulk upload step complete?');
  process.exit(1);
}

const planSize = Math.min(DISTRIBUTION_PLAN.length, allSeekers.length);
const planned = allSeekers.slice(0, planSize).map((seeker, i) => ({
  seeker,
  provider: providers[i % providers.length],
  plan: DISTRIBUTION_PLAN[i],
}));

const expectedCounts: Record<Status, number> = { new: 0, active: 0, at_risk: 0, inactive: 0 };
for (const p of planned) expectedCounts[p.plan.expected_status]++;
const bucketCounts: Record<Bucket, number> = { create: 0, accept: 0, reject: 0, cancel: 0 };
for (const p of planned) if (p.plan.action) bucketCounts[p.plan.action.bucket]++;

console.log(`Discovered ${allSeekers.length} seekers, ${providers.length} providers.`);
console.log(`Applying plan to ${planSize} seekers (any extras left as-is).`);
console.log('Expected profile_status counts:', expectedCounts);
console.log('Expected by_action_status counts (seeker side):', bucketCounts);
console.log('Plus 2 provider→seeker connects (metric_categories: null, should not affect rollup).');

async function postPerform(
  source: ItemRef,
  target: ItemRef,
  payload: Record<string, unknown>,
  apiKey: string,
  orgId: string,
  actingAsUserId: string,
): Promise<{ status: number; body: { action_id?: string; error?: string; message?: string } }> {
  const res = await fetch(`${signalsUrl}/api/v1/action/perform`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-acting-org-id': orgId,
    },
    body: JSON.stringify({
      action_type: 'connect',
      source_item: {
        item_network: source.item_network,
        item_domain: source.item_domain,
        item_type: source.item_type,
        item_id: source.item_id,
      },
      target_item: {
        item_network: target.item_network,
        item_domain: target.item_domain,
        item_type: target.item_type,
        item_id: target.item_id,
        item_instance_url: signalsUrl,
      },
      requirements_snapshot: payload,
      acting_as_user_id: actingAsUserId,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { action_id?: string; error?: string; message?: string };
  return { status: res.status, body };
}

/**
 * Transition action_status directly via PG. The Signals `/action/update-status`
 * route is self-acted only (no on-behalf-of), so the aggregator's apikey
 * cannot satisfy the target-owner check. Test fixtures bypass the API for
 * this transition the same way they bypass for items.created_at backdating.
 *
 * Mirrors what /action/update-status would have done:
 *   - sets action_status
 *   - increments update_count
 *   - touches updated_at
 *
 * Does NOT write to action_events (the event-stream side table). The
 * dashboard recompute reads only item_actions.action_status, so the
 * dashboard rollup is correct. If future analytics depend on action_events,
 * this fixture needs to also append a row there.
 */
async function transitionActionStatus(actionId: string, newStatus: string): Promise<void> {
  await db.execute(sql`
    UPDATE item_actions
    SET action_status = ${newStatus},
        update_count  = update_count + 1,
        updated_at    = NOW()
    WHERE action_id = ${actionId}
  `);
}

async function lookupExistingActionId(sourceItemId: string, targetItemId: string): Promise<string | null> {
  const rows = await db
    .select({ action_id: item_actions.action_id })
    .from(item_actions)
    .where(
      and(
        eq(item_actions.source_item_id, sourceItemId),
        eq(item_actions.target_item_id, targetItemId),
        eq(item_actions.action_type, 'connect'),
      ),
    )
    .limit(1);
  return rows[0]?.action_id ?? null;
}

async function backdateItem(itemId: string, ageDays: number): Promise<void> {
  await db.execute(sql`
    UPDATE items
    SET created_at = NOW() - (${ageDays} * INTERVAL '1 day')
    WHERE item_id = ${itemId}
  `);
}

async function backdateAction(actionId: string, ageDays: number): Promise<void> {
  await db.execute(sql`
    UPDATE item_actions
    SET created_at = NOW() - (${ageDays} * INTERVAL '1 day')
    WHERE action_id = ${actionId}
  `);
}

let i = 0;
for (const p of planned) {
  i++;
  const label = `[${i.toString().padStart(2, '0')}/${planned.length}]`;
  const plan = p.plan;

  let actionId: string | null = null;

  if (plan.action) {
    const seekerPayload = {
      disability_type: ['Locomotor Disability'],
      looking_for: ['Employment Opportunities'],
      message: `E2E test connect #${i}`,
    };
    const { status, body } = await postPerform(
      p.seeker,
      p.provider,
      seekerPayload,
      seekerApiKey,
      seekerOrgId,
      p.seeker.owner_user_id,
    );

    if (status === 201 && body.action_id) {
      actionId = body.action_id;
      console.log(`${label} perform → created action=${actionId} target=${plan.action.bucket}/${plan.expected_status}`);
    } else if (status === 409) {
      actionId = await lookupExistingActionId(p.seeker.item_id, p.provider.item_id);
      if (!actionId) {
        console.error(`${label} 409 conflict but no existing action found — aborting`);
        console.error(`  body:`, body);
        process.exit(1);
      }
      console.log(`${label} perform → 409 conflict; reusing action=${actionId}`);
    } else {
      console.error(`${label} /action/perform failed: HTTP ${status}`);
      console.error(`  body:`, body);
      process.exit(1);
    }

    // 3b. Transition if the target bucket isn't 'create'
    if (plan.action.bucket !== 'create') {
      const newStatus = STATUS_FOR_BUCKET[plan.action.bucket];
      await transitionActionStatus(actionId, newStatus);
      console.log(`${label}      update → ${newStatus} (direct SQL)`);
    }
  } else {
    console.log(`${label} (no action; target=${plan.expected_status})`);
  }

  await backdateItem(p.seeker.item_id, plan.item_age_days);
  console.log(`${label}      item.created_at ← NOW() - ${plan.item_age_days}d`);

  if (actionId && plan.action) {
    await backdateAction(actionId, plan.action.age_days);
    console.log(`${label}      action.created_at ← NOW() - ${plan.action.age_days}d`);
  }
}

const negativeCount = Math.min(2, providers.length, allSeekers.length);
for (let j = 0; j < negativeCount; j++) {
  const provider = providers[j];
  const seeker = allSeekers[j];
  const label = `[p→s ${j + 1}/${negativeCount}]`;
  const providerPayload = {
    services_offered: ['Employment Opportunities'],
    message: 'E2E negative-direction smoke',
  };
  const { status, body } = await postPerform(
    provider,
    seeker,
    providerPayload,
    providerApiKey,
    providerOrgId,
    provider.owner_user_id,
  );
  if (status === 201) {
    console.log(`${label} connect created (id=${body.action_id}) — should NOT show in seeker rollup`);
  } else if (status === 409) {
    console.log(`${label} 409 conflict, skipping`);
  } else {
    console.error(`${label} /action/perform failed: HTTP ${status}`);
    console.error(`  body:`, body);
    process.exit(1);
  }
}

await pool.end();

console.log('');
console.log('Done. After ?refresh=true on the dashboard you should see:');
console.log('  by_status         :', expectedCounts);
console.log('  by_action_status  :', bucketCounts, '(seeker side; provider side mirrors)');
process.exit(0);
