/**
 * Drive Purple Dot connect actions across both domains, then backdate
 * timestamps so the dashboard rollup distributes BOTH seekers AND providers
 * across the four profile_status buckets (new / active / at_risk / inactive).
 *
 * Flow:
 *   1. Discover seekers + providers via direct DB query (test-fixture
 *      privilege — actions still go through real HTTP).
 *   2. Apply per-domain backdate plan: items.created_at ← NOW() - planned_age.
 *      Items are backdated BEFORE any action is created, so when actions land
 *      they can safely backdate themselves down to min(source_age, target_age).
 *   3. Walk SEEKER_PLAN — for each seeker row that initiates an action,
 *      POST /action/perform (s→p) to the configured target provider,
 *      optionally transition action_status via direct PG UPDATE (Signals'
 *      /action/update-status is self-acted only — see transitionActionStatus),
 *      and backdate the action.created_at to the clamped age.
 *   4. Walk PROVIDER_PLAN — same pattern but p→s direction (always 'create'
 *      bucket — p→s has metric_categories: null in Purple Dot, so the
 *      bucket label is cosmetic for the dashboard). Exercises the negative
 *      direction without polluting the rollup.
 *   5. Action ages are clamped to min(intended, source_age, target_age, 0)
 *      so an action never predates the item it touches. A clamp log line
 *      fires when the intended value can't be honoured.
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
 * drizzle-orm, pg, and @dpg/* resolve via apps/api/node_modules. Workspace
 * deps are dynamically imported after env validation so a missing-env error
 * is reported before any module-not-found noise.
 *
 * Idempotency: re-running on the same data may produce 409 from /action/perform
 * if an action already exists for the (source, target, type) tuple. The
 * script catches 409 and reuses the existing action_id. Backdate UPDATEs
 * are idempotent by construction.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Compute the script's own dir so .env discovery doesn't depend on the
// cwd it was launched from (`pnpm --filter api exec` sets cwd to apps/api,
// but direct `tsx` invocations from repo root would otherwise mis-resolve).
const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = <repo>/apps/api/scripts/e2e
const repoRoot = resolve(__dirname, '../../../..');

// Load environment from two locations, in priority order:
//   1. shell environment (already in process.env — wins always)
//   2. <repo>/scripts/e2e/.env  — e2e-specific config (shared with QR script)
//   3. <repo>/.env              — repo-root fallback (legacy)
// dotenv.config() does NOT override existing process.env entries by default,
// so loading the more-specific file first means it takes precedence over
// the root .env when both define the same key.
dotenv.config({ path: resolve(repoRoot, 'scripts/e2e/.env') });
dotenv.config({ path: resolve(repoRoot, '.env') });

const signalsUrl = required('SIGNALS_API_URL');
const seekerOrgId = required('SEEKER_ORG_ID');
const providerOrgId = required('PROVIDER_ORG_ID');
const seekerApiKey = required('SEEKER_APIKEY');
const providerApiKey = required('PROVIDER_APIKEY');

// Local dev hack: when SIGNALS_API_URL points at localhost over HTTPS, the cert
// is self-signed. Mirror the QR submitter's TLS-bypass for the local case only.
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
  item_instance_url: string;
  owner_user_id: string;
}

type Bucket = 'create' | 'accept' | 'reject' | 'cancel';
type Status = 'new' | 'active' | 'at_risk' | 'inactive';

interface DomainPlanRow {
  /** Days back to land items.created_at when this row's source item is backdated. */
  item_age_days: number;
  /**
   * The action this item initiates into the OTHER domain. null = no action.
   * `target_idx` indexes into the other domain's discovered list (round-robin
   * fallback if the index exceeds available items).
   */
  initiated_action: null | {
    target_idx: number;
    bucket: Bucket;
    /** Intended action_age_days; clamped at runtime to <= min(source_age, target_age). */
    intended_age_days: number;
  };
  expected_status: Status;
}

/**
 * Seeker plan (s→p direction). Tied to provider indices so that providers
 * receiving these actions end up with enough age to legitimise the action's
 * own age — see comment on PROVIDER_PLAN for the joint reasoning.
 *
 * Action ages here are intended values; the runtime clamps to <= min(seeker_age,
 * provider_age) so an action never predates either item.
 */
const SEEKER_PLAN: ReadonlyArray<DomainPlanRow> = [
  { item_age_days: 2,   initiated_action: { target_idx: 0, bucket: 'create', intended_age_days: 1   }, expected_status: 'new' },
  { item_age_days: 5,   initiated_action: { target_idx: 0, bucket: 'create', intended_age_days: 2   }, expected_status: 'new' },
  { item_age_days: 15,  initiated_action: { target_idx: 1, bucket: 'create', intended_age_days: 10  }, expected_status: 'active' },
  { item_age_days: 20,  initiated_action: { target_idx: 1, bucket: 'accept', intended_age_days: 15  }, expected_status: 'active' },
  { item_age_days: 25,  initiated_action: { target_idx: 0, bucket: 'accept', intended_age_days: 5   }, expected_status: 'active' },
  { item_age_days: 60,  initiated_action: { target_idx: 2, bucket: 'create', intended_age_days: 45  }, expected_status: 'at_risk' },
  { item_age_days: 70,  initiated_action: { target_idx: 3, bucket: 'reject', intended_age_days: 50  }, expected_status: 'at_risk' },
  { item_age_days: 80,  initiated_action: { target_idx: 3, bucket: 'accept', intended_age_days: 60  }, expected_status: 'at_risk' },
  { item_age_days: 100, initiated_action: null,                                                         expected_status: 'inactive' },
  { item_age_days: 120, initiated_action: { target_idx: 4, bucket: 'cancel', intended_age_days: 100 }, expected_status: 'inactive' },
];

/**
 * Provider plan (p→s direction). Provider expected_status comes from the
 * s→p actions it RECEIVES (per the recompute's bidirectional aggregation),
 * not the p→s actions it initiates — p→s has metric_categories: null in
 * Purple Dot, so initiated bucket counts are cosmetic at the dashboard layer.
 *
 * Provider ages are chosen jointly with SEEKER_PLAN's target_idx values so
 * each provider's youngest received-action satisfies:
 *   p[0] age=3,   receives s[0]:create age 1, s[1]:create age 2, s[4]:accept age 5
 *                 youngest in {create,accept} = 1 → item_age <= 7 → new
 *   p[1] age=20,  receives s[2]:create age 10, s[3]:accept age 15
 *                 youngest in {create,accept} = 10, item_age=20 → active
 *   p[2] age=50,  receives s[5]:create age 45
 *                 youngest in {create,accept,reject} = 45 in [31,90] → at_risk
 *   p[3] age=90,  receives s[6]:reject age 50, s[7]:accept age 60
 *                 youngest in {create,accept,reject} = 50 in [31,90] → at_risk
 *   p[4] age=120, receives s[9]:cancel age 100
 *                 no actions in {create,accept,reject} → default → inactive
 */
const PROVIDER_PLAN: ReadonlyArray<DomainPlanRow> = [
  { item_age_days: 3,   initiated_action: { target_idx: 0, bucket: 'create', intended_age_days: 1   }, expected_status: 'new' },
  { item_age_days: 20,  initiated_action: { target_idx: 2, bucket: 'create', intended_age_days: 12  }, expected_status: 'active' },
  { item_age_days: 50,  initiated_action: { target_idx: 5, bucket: 'create', intended_age_days: 40  }, expected_status: 'at_risk' },
  { item_age_days: 90,  initiated_action: { target_idx: 7, bucket: 'create', intended_age_days: 65  }, expected_status: 'at_risk' },
  { item_age_days: 120, initiated_action: { target_idx: 9, bucket: 'create', intended_age_days: 110 }, expected_status: 'inactive' },
];

const STATUS_FOR_BUCKET: Record<Exclude<Bucket, 'create'>, string> = {
  accept: 'accepted',
  reject: 'rejected',
  cancel: 'cancelled',
};

// ───────────────────────────────────────────────────────────────────────────
// Workspace + heavy deps (deferred until after env validation)
// ───────────────────────────────────────────────────────────────────────────

const { items, item_actions } = await import('@dpg/database');
const { user } = await import('../../db/postgres/schema/auth.js');
const { eq, and, sql, desc } = await import('drizzle-orm');
const { Pool } = await import('pg');
const { drizzle } = await import('drizzle-orm/node-postgres');

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

// ───────────────────────────────────────────────────────────────────────────
// DB helpers
// ───────────────────────────────────────────────────────────────────────────

async function discover(domain: 'seeker' | 'provider', orgId: string): Promise<ItemRef[]> {
  // ORDER BY items.created_at DESC so the most recently onboarded items get
  // the plan applied first. With more items than plan rows (e.g. 25 seekers,
  // 10 plan slots), the freshest QR submissions take the plan and older
  // items are left untouched — usually what an operator wants when re-running
  // the script after a fresh QR batch.
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_instance_url: items.item_instance_url,
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
    )
    .orderBy(desc(items.created_at));
  return rows;
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

/**
 * Transition action_status directly via PG. The Signals `/action/update-status`
 * route is self-acted only (no on-behalf-of), so the aggregator's apikey
 * cannot satisfy the target-owner check. Test fixtures bypass the API for
 * this transition the same way they bypass for items.created_at backdating.
 *
 * Mirrors what /action/update-status would have done: sets action_status,
 * increments update_count, touches updated_at. Does NOT write to action_events
 * (the event-stream side table). The dashboard recompute reads only
 * item_actions.action_status, so the dashboard rollup is correct.
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

async function lookupExistingActionId(
  sourceItemId: string,
  targetItemId: string,
): Promise<string | null> {
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
        // Use the target item's own instance URL (set at creation) rather than
        // the script's SIGNALS_API_URL — Signals validates this against the
        // network's allowed instances[] in network.json, and the env var may
        // be a tunnel / nginx fronting URL that doesn't match.
        item_instance_url: target.item_instance_url,
      },
      requirements_snapshot: payload,
      acting_as_user_id: actingAsUserId,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    action_id?: string;
    error?: string;
    message?: string;
  };
  return { status: res.status, body };
}

// ───────────────────────────────────────────────────────────────────────────
// Discovery + age maps
// ───────────────────────────────────────────────────────────────────────────

const allSeekers = await discover('seeker', seekerOrgId);
const providers = await discover('provider', providerOrgId);

if (allSeekers.length === 0) {
  console.error('No seekers discovered. Did the QR submission step complete?');
  await pool.end();
  process.exit(1);
}
if (providers.length === 0) {
  console.error('No providers discovered. Did the bulk upload step complete?');
  await pool.end();
  process.exit(1);
}

const seekerCount = Math.min(SEEKER_PLAN.length, allSeekers.length);
const providerCount = Math.min(PROVIDER_PLAN.length, providers.length);

console.log(`Discovered ${allSeekers.length} seekers, ${providers.length} providers.`);
console.log(
  `Applying plan to ${seekerCount}/${SEEKER_PLAN.length} seekers and ${providerCount}/${PROVIDER_PLAN.length} providers (extras left untouched).`,
);

// Age maps (item_id → planned age_days). Used to clamp action_age at most
// to the OLDER of source and target — actions can't pre-date their items.
const seekerAge = new Map<string, number>();
const providerAge = new Map<string, number>();

for (let i = 0; i < seekerCount; i++) {
  seekerAge.set(allSeekers[i]!.item_id, SEEKER_PLAN[i]!.item_age_days);
}
for (let j = 0; j < providerCount; j++) {
  providerAge.set(providers[j]!.item_id, PROVIDER_PLAN[j]!.item_age_days);
}

// ───────────────────────────────────────────────────────────────────────────
// Expected counts (logged once for runtime verification)
// ───────────────────────────────────────────────────────────────────────────

const expectedSeekerStatus: Record<Status, number> = {
  new: 0,
  active: 0,
  at_risk: 0,
  inactive: 0,
};
const expectedProviderStatus: Record<Status, number> = {
  new: 0,
  active: 0,
  at_risk: 0,
  inactive: 0,
};
const expectedSeekerBuckets: Record<Bucket, number> = {
  create: 0,
  accept: 0,
  reject: 0,
  cancel: 0,
};

for (let i = 0; i < seekerCount; i++) {
  expectedSeekerStatus[SEEKER_PLAN[i]!.expected_status]++;
  const a = SEEKER_PLAN[i]!.initiated_action;
  if (a) expectedSeekerBuckets[a.bucket]++;
}
for (let j = 0; j < providerCount; j++) {
  expectedProviderStatus[PROVIDER_PLAN[j]!.expected_status]++;
}

console.log('Expected by_status (seeker):  ', expectedSeekerStatus);
console.log('Expected by_status (provider):', expectedProviderStatus);
console.log('Expected by_action_status (seeker side, s→p):', expectedSeekerBuckets);
console.log('p→s actions: metric_categories: null in Purple Dot — exercised but not counted.');

// ───────────────────────────────────────────────────────────────────────────
// Pass 1 — backdate all items first so action_age clamping has correct refs.
// ───────────────────────────────────────────────────────────────────────────

for (let i = 0; i < seekerCount; i++) {
  const seeker = allSeekers[i]!;
  const ageDays = SEEKER_PLAN[i]!.item_age_days;
  await backdateItem(seeker.item_id, ageDays);
  console.log(
    `[seeker ${(i + 1).toString().padStart(2, '0')}/${seekerCount}] item.created_at ← NOW() - ${ageDays}d`,
  );
}
for (let j = 0; j < providerCount; j++) {
  const provider = providers[j]!;
  const ageDays = PROVIDER_PLAN[j]!.item_age_days;
  await backdateItem(provider.item_id, ageDays);
  console.log(
    `[provider ${(j + 1).toString().padStart(2, '0')}/${providerCount}] item.created_at ← NOW() - ${ageDays}d`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Pass 2 — s→p actions
// ───────────────────────────────────────────────────────────────────────────

/**
 * Clamp the intended action_age_days against the actual ages of the
 * source and target items. Action can't predate either item.
 * Returns 0 (never negative) and logs when the intended value is clamped.
 */
function clampActionAge(
  intended: number,
  sourceAge: number,
  targetAge: number,
  label: string,
): number {
  const upperBound = Math.min(sourceAge, targetAge);
  const clamped = Math.max(0, Math.min(intended, upperBound));
  if (clamped !== intended) {
    console.log(
      `${label}      clamp action_age ${intended}d → ${clamped}d (source=${sourceAge}d, target=${targetAge}d)`,
    );
  }
  return clamped;
}

console.log('');
console.log('— s→p actions —');
for (let i = 0; i < seekerCount; i++) {
  const seeker = allSeekers[i]!;
  const row = SEEKER_PLAN[i]!;
  const label = `[s→p ${(i + 1).toString().padStart(2, '0')}/${seekerCount}]`;

  if (!row.initiated_action) {
    console.log(`${label} (no action; target=${row.expected_status})`);
    continue;
  }

  // Round-robin if target_idx exceeds discovered providers.
  const targetIdx = row.initiated_action.target_idx % providerCount;
  const targetProvider = providers[targetIdx]!;
  const sourceAge = SEEKER_PLAN[i]!.item_age_days;
  const targetAge = providerAge.get(targetProvider.item_id) ?? 0;
  const actionAge = clampActionAge(
    row.initiated_action.intended_age_days,
    sourceAge,
    targetAge,
    label,
  );

  const payload = {
    disability_type: ['Locomotor Disability'],
    looking_for: ['Employment Opportunities'],
    message: `E2E test connect #${i + 1}`,
  };

  let actionId: string | null = null;
  const { status, body } = await postPerform(
    seeker,
    targetProvider,
    payload,
    seekerApiKey,
    seekerOrgId,
    seeker.owner_user_id,
  );
  if (status === 201 && body.action_id) {
    actionId = body.action_id;
    console.log(
      `${label} perform → created action=${actionId} target=${row.initiated_action.bucket}/${row.expected_status}`,
    );
  } else if (status === 409) {
    actionId = await lookupExistingActionId(seeker.item_id, targetProvider.item_id);
    if (!actionId) {
      console.error(`${label} 409 conflict but no existing action found — aborting`);
      console.error(`  body:`, body);
      await pool.end();
      process.exit(1);
    }
    console.log(`${label} perform → 409 conflict; reusing action=${actionId}`);
  } else {
    console.error(`${label} /action/perform failed: HTTP ${status}`);
    console.error(`  body:`, body);
    await pool.end();
    process.exit(1);
  }

  if (row.initiated_action.bucket !== 'create') {
    const newStatus = STATUS_FOR_BUCKET[row.initiated_action.bucket];
    await transitionActionStatus(actionId, newStatus);
    console.log(`${label}      update → ${newStatus} (direct SQL)`);
  }
  await backdateAction(actionId, actionAge);
  console.log(`${label}      action.created_at ← NOW() - ${actionAge}d`);
}

// ───────────────────────────────────────────────────────────────────────────
// Pass 3 — p→s actions (metric_categories: null in Purple Dot)
// ───────────────────────────────────────────────────────────────────────────

console.log('');
console.log('— p→s actions (won\'t affect rollup buckets in Purple Dot) —');
for (let j = 0; j < providerCount; j++) {
  const provider = providers[j]!;
  const row = PROVIDER_PLAN[j]!;
  const label = `[p→s ${(j + 1).toString().padStart(2, '0')}/${providerCount}]`;

  if (!row.initiated_action) {
    console.log(`${label} (no action)`);
    continue;
  }

  const targetIdx = row.initiated_action.target_idx % seekerCount;
  const targetSeeker = allSeekers[targetIdx]!;
  const sourceAge = PROVIDER_PLAN[j]!.item_age_days;
  const targetAge = seekerAge.get(targetSeeker.item_id) ?? 0;
  const actionAge = clampActionAge(
    row.initiated_action.intended_age_days,
    sourceAge,
    targetAge,
    label,
  );

  const payload = {
    services_offered: ['Employment Opportunities'],
    message: `E2E p→s connect #${j + 1}`,
  };

  let actionId: string | null = null;
  const { status, body } = await postPerform(
    provider,
    targetSeeker,
    payload,
    providerApiKey,
    providerOrgId,
    provider.owner_user_id,
  );
  if (status === 201 && body.action_id) {
    actionId = body.action_id;
    console.log(`${label} perform → created action=${actionId}`);
  } else if (status === 409) {
    actionId = await lookupExistingActionId(provider.item_id, targetSeeker.item_id);
    if (!actionId) {
      console.error(`${label} 409 conflict but no existing action found — aborting`);
      console.error(`  body:`, body);
      await pool.end();
      process.exit(1);
    }
    console.log(`${label} perform → 409 conflict; reusing action=${actionId}`);
  } else {
    console.error(`${label} /action/perform failed: HTTP ${status}`);
    console.error(`  body:`, body);
    await pool.end();
    process.exit(1);
  }

  if (row.initiated_action.bucket !== 'create') {
    const newStatus = STATUS_FOR_BUCKET[row.initiated_action.bucket];
    await transitionActionStatus(actionId, newStatus);
    console.log(`${label}      update → ${newStatus} (direct SQL)`);
  }
  await backdateAction(actionId, actionAge);
  console.log(`${label}      action.created_at ← NOW() - ${actionAge}d`);
}

// ───────────────────────────────────────────────────────────────────────────
// Done
// ───────────────────────────────────────────────────────────────────────────

await pool.end();

console.log('');
console.log('Done. After ?refresh=true on the dashboard you should see:');
console.log('  seeker  by_status        :', expectedSeekerStatus);
console.log('  provider by_status       :', expectedProviderStatus);
console.log('  seeker  by_action_status :', expectedSeekerBuckets);
process.exit(0);
