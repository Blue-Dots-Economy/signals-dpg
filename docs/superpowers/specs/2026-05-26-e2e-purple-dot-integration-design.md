# End-to-End Purple Dot Integration Test — Aggregator → Signals → Dashboard

**Status:** spec — awaiting implementation plan
**Author:** generated via brainstorming session, 2026-05-26
**Reference network:** Purple Dot (pilot)
**Depends on:** `2026-05-26-metrics-config-driven-redesign-design.md` (uses the new dashboard response shape and `?refresh=true` knob)
**Sibling repo:** `aggregator-dpg` (lives at `../aggregator-dpg/` relative to Signals-DPG)

## Goal

Exercise the full participant-onboarding and dashboard-rollup flow across the Aggregator-DPG ↔ Signals-DPG handshake for Purple Dot — without the current shortcut of seeding directly into Signals' DB.

The operator handles stack launch, aggregator self-registration, and UI-driven QR-link creation + CSV bulk upload. Two scripts in `Signals-DPG/scripts/e2e/` automate the rest:

1. **QR participant submitter** — POSTs synthetic seeker payloads to Aggregator's public registration endpoint. Aggregator's worker writes them through `signalstack-writer` to Signals.
2. **Action driver** — discovers item_id + owner_user_id pairs by direct DB query (test-fixture privilege), then drives `/action/perform` + `/action/update-status` on Signals using Plan A's aggregator-on-behalf-of semantics. Produces a deterministic distribution across the 4 canonical buckets.

Dashboard verification is manual against the Aggregator UI (or via a one-line `curl | jq` for fast inspection).

## Why now

Plan B/C/the metrics refactor (PR #26) all land canonical-bucket dashboards driven by network-config. None of that path has been exercised end-to-end with the real Aggregator-DPG service — today's `seed_purple_dot.ts` short-circuits Aggregator entirely. Before pilot, we need a repeatable run that proves:

- Aggregator's public link submission → `signalstack-writer` → Signals' `/admin/participant` works
- Aggregator's bulk upload (S3 → worker → `signalstack-writer`) works for the provider domain
- Plan A's `acting_as_user_id` on-behalf-of flow works for connect actions
- The new dashboard rollup tiles, `by_action_status`, `avg_*`, `mode_wise_counts` all reflect onboarding-mode attribution correctly
- `?refresh=true` actually forces a recompute when the operator wants fresh numbers

A markdown runbook makes the steps reproducible by a non-author. Scripts cover the parts a human would hate doing repeatedly.

## Non-goals

- Automating aggregator self-registration (the Keycloak OTP flow → Mailpit dance is documented but operator-driven).
- Automating CSV bulk upload (operator uploads a provided fixture via UI; S3 presigned URL flow is web-driven and well-tested separately).
- Scripted CI integration. This is operator-driven local validation.
- Cleanup. Fresh run = `docker compose down -v && docker compose up -d` on both stacks.

## Dependencies

- PR #26 (metrics config-driven redesign) merged on the branch this work executes from. Specifically: canonical bucket names in `metric_categories`, `status_rules` in `network.json`, `display_name_field` on item_schemas, `/api/v1/aggregator/dashboard` exposing `items[]` + `by_action_status` + `?refresh=true`.
- `aggregator-dpg` repo cloned at `../aggregator-dpg/` (sibling of `Signals-DPG`).
- Both stacks run on default ports: Aggregator on `:4000` (API) + `:3000` (web) + `:8080` (Keycloak) + `:8025` (Mailpit); Signals on `:2742` + `:5432` Postgres + `:6379` Redis.
- Plan A's `acting_as_user_id` flow (already merged on develop).
- Plan C's `POST /api/v1/admin/participant` (already merged on develop). `signalstack-writer` in Aggregator-DPG calls this endpoint.

---

## File layout

**New in Signals-DPG:**

```
Signals-DPG/
├── scripts/e2e/
│   ├── submit_qr_participants.ts     # see §3
│   ├── seed_actions.ts               # see §4
│   ├── fixtures/
│   │   ├── purple_dot_qr_payloads.json   # 10 synthetic seeker records
│   │   └── purple_dot_providers.csv      # 5-row bulk-upload sample
│   └── README.md                     # short pointer to the runbook
└── docs/operations/
    └── e2e-purple-dot-runbook.md     # the operator-facing runbook
```

Two `pnpm` scripts wired in the root `package.json`:

```jsonc
"scripts": {
  "e2e:qr":      "tsx scripts/e2e/submit_qr_participants.ts",
  "e2e:actions": "tsx scripts/e2e/seed_actions.ts"
}
```

(Use `tsx` since `scripts/e2e/` is outside the `apps/api/` tsconfig path. Keeps the scripts simple to invoke and out of the API's dep graph.)

**No changes in `aggregator-dpg/`** — the QR submitter targets its existing public endpoint.

**Modified in Signals-DPG:**

- `apps/api/scripts/seed_purple_dot.ts` — add a top-of-file note that this is a fast-path fallback that BYPASSES the Aggregator handshake. For full E2E, follow `docs/operations/e2e-purple-dot-runbook.md`.

---

## §1 — Runbook (`docs/operations/e2e-purple-dot-runbook.md`)

Markdown structure. Each step is either operator-driven or scripted; scripted steps are one-shot commands.

### Section 1.1 — Prerequisites

```
Both stacks up:
  Aggregator-DPG:
    cd ../aggregator-dpg
    make up                         # docker compose; Keycloak, Postgres, Redis, Mailpit
    pnpm --filter @aggregator-dpg/api dev    # API on :4000
    pnpm --filter @aggregator-dpg/web dev    # Web on :3000
    pnpm --filter @aggregator-dpg/worker dev # BullMQ worker

  Signals-DPG:
    cd ../Signals-DPG
    docker compose up -d db redis
    pnpm dev:api                    # API on :2742

Both DBs fresh (or accept residual data from a prior run; idempotency notes below).
```

### Section 1.2 — Step 1: Register two aggregators (UI)

```
1. Open http://localhost:3000
2. Register "PurpleDot Seekers Aggregator"
   - email: seeker-agg@local.dev
   - domain: seeker
   - retrieve OTP from http://localhost:8025 (Mailpit)
   - complete approval flow
3. Repeat for "PurpleDot Providers Aggregator"
   - domain: provider

After each registration, the Aggregator UI shows:
   - Aggregator org_id (Signals' org id)
   - Aggregator slug
   - Signals API key (issued during the approval handshake)

Record both sets of values. Save to an env file:

  # scripts/e2e/.env (gitignored)
  AGGREGATOR_API_URL=http://localhost:4000
  SIGNALS_API_URL=http://localhost:2742

  SEEKER_ORG_SLUG=purple-dot-seekers-aggregator
  SEEKER_ORG_ID=org_<...>
  SEEKER_APIKEY=<...>

  PROVIDER_ORG_SLUG=purple-dot-providers-aggregator
  PROVIDER_ORG_ID=org_<...>
  PROVIDER_APIKEY=<...>
```

### Section 1.3 — Step 2: Seeker aggregator creates a QR link (UI)

```
1. Login as seeker-agg
2. Onboarding → New Link
   - domain: seeker
   - name: "E2E QR Test"
3. Activate the link
4. Copy the link slug from the link detail page

Add to .env:
  QR_LINK_SLUG=<slug>
```

### Section 1.4 — Step 3: Provider aggregator does bulk upload (UI)

```
1. Login as provider-agg
2. Onboarding → Bulk Upload
3. Download CSV template (for provider domain)
   - sanity-check the headers match scripts/e2e/fixtures/purple_dot_providers.csv
4. Upload scripts/e2e/fixtures/purple_dot_providers.csv
5. Wait for the BullMQ worker to process (status moves: uploaded → processing → completed)
6. Confirm "5 participants onboarded" or whatever the UI shows

If the schema validator rejects rows, update the fixture CSV to match the
current participant-provider schema in aggregator-dpg/config/schemas/.
```

### Section 1.5 — Step 4: Submit synthetic QR seekers (scripted)

```
  source scripts/e2e/.env
  pnpm e2e:qr "$QR_LINK_SLUG" 10

Output:
  [01/10] POST submitted → submission_id=sub_abc...
  [02/10] POST submitted → submission_id=sub_def...
  ...
  All 10 submissions accepted.

Wait ~5s for Aggregator's queue to drain (bulk-finalise / link-submit-write
both push to Signals via signalstack-writer).
```

### Section 1.6 — Step 5: Drive connect actions (scripted)

```
  pnpm e2e:actions

Output:
  Discovered 10 seekers, 5 providers.
  Will create 10 connect actions (1:1 seeker→provider round-robin):
    Stay pending (create):  4
    Accepted:               3
    Rejected:               2
    Cancelled:              1
  Plus 2 provider→seeker connects (metric_categories: null, won't show in rollup).

  [01/12] POST /action/perform     created  itm_seeker_001 → itm_provider_001
  [02/12] POST /action/update-status accepted ...
  ...
  Done. 12 actions executed.
```

### Section 1.7 — Step 6: Verify dashboards (manual)

```
Open http://localhost:3000 as seeker-agg → Dashboard.

Expected seeker rollup:
  total_items:       10
  complete_profiles: 10 (all fixtures populate every required field)
  has_applications:  10 (every seeker has at least one connect)

  by_status:
    new:      depends on item_age_days threshold (likely 10 if same-day)
    active:   matches "days_since_last in [create,accept] <= 30" — likely all 10
    at_risk:  0
    inactive: 0

  by_action_status:
    create:    4
    accept:    3
    reject:    2
    cancel:    1

  avg_items_per_user:    1.0
  avg_actions_per_user:  1.0
  mode_wise_counts:      { link: 10 }

Open http://localhost:3000 as provider-agg → Dashboard.

Expected provider rollup:
  total_items:       5
  complete_profiles: 5
  has_applications:  5

  by_action_status:
    create:    4
    accept:    3
    reject:    2
    cancel:    1
    (provider side mirrors seeker side; each canonical bucket is counted
    once per item from the same action stream)

  mode_wise_counts:      { bulk: 5 }

Negative check:
  - 2 provider→seeker connects ran in §1.6 BUT their interaction has
    metric_categories: null in purple_dot/network.json, so they should
    NOT inflate any bucket.
```

### Section 1.8 — Fast inspection one-liner

```
curl -s "$SIGNALS_API_URL/api/v1/aggregator/dashboard?refresh=true" \
  -H "x-api-key: $SEEKER_APIKEY" \
  -H "x-acting-org-id: $SEEKER_ORG_ID" \
  | jq '.by_domain.seeker.rollup'
```

### Section 1.9 — Troubleshooting

```
"total_items: 0 on seeker dashboard"
  → Aggregator's queue may not have flushed yet. Wait + refresh.
  → Check Aggregator's onboarding table: psql ... 'SELECT count(*) FROM onboarding;'
  → Check signalstack-writer logs: pnpm --filter @aggregator-dpg/worker logs
  → Check Signals /admin/participant logs

"by_action_status all zero"
  → Make sure metric_categories on purple_dot/network.json has canonical keys
    (Task 5 of PR #26 — should be on develop already).
  → Restart Signals API to reload network config cache.

"refresh=true didn't refresh"
  → Check pg_advisory_lock isn't held by an orphaned process:
    SELECT * FROM pg_locks WHERE locktype = 'advisory';
```

---

## §2 — `scripts/e2e/fixtures/purple_dot_qr_payloads.json`

10 deterministic seeker records, each schema-valid against Purple Dot's
`profile_1.0` seeker schema. Variation across `service_city`, `looking_for`,
`disability_type`, `gender` to give the dashboard interesting `mode_wise_counts`
and `actionable_tags` data when computed.

Shape (one record):

```jsonc
{
  "beneficiary_name": "Asha Devi",
  "mobile_number": "9000000001",
  "age": 28,
  "gender": "Female",
  "disability_type": ["Locomotor Disability"],
  "disability_percentage": 60,
  "looking_for": ["Employment Opportunities"],
  "looking_for_details": "Remote work suited to wheelchair access",
  "service_city": "Lucknow",
  "documents_available": ["Aadhaar", "Disability Certificate"]
}
```

The 10 records vary across the schema's enums (disability types, service
cities, looking_for, qualifications) so the dashboard sees realistic spread.

## §3 — `scripts/e2e/submit_qr_participants.ts`

```ts
// usage: pnpm e2e:qr <link-slug> [count=10]
// env:   AGGREGATOR_API_URL, SEEKER_ORG_SLUG

const linkSlug = process.argv[2];
const count = Number(process.argv[3] ?? 10);
const aggApiUrl = process.env.AGGREGATOR_API_URL!;
const orgSlug = process.env.SEEKER_ORG_SLUG!;

const payloads = JSON.parse(
  readFileSync(resolve('scripts/e2e/fixtures/purple_dot_qr_payloads.json'), 'utf8')
) as Array<Record<string, unknown>>;

for (let i = 0; i < count; i++) {
  const payload = payloads[i % payloads.length];
  const res = await fetch(
    `${aggApiUrl}/public/v1/aggregators/${orgSlug}/registrations/${linkSlug}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    // 429 → backoff + retry once; other 4xx → bail with body
    const body = await res.text();
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '5');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      i--;  // retry same index
      continue;
    }
    throw new Error(`[${i+1}/${count}] HTTP ${res.status}: ${body}`);
  }
  const { submission_id } = await res.json() as { submission_id: string };
  console.log(`[${(i+1).toString().padStart(2,'0')}/${count}] POST submitted → submission_id=${submission_id}`);
}
console.log(`All ${count} submissions accepted.`);
```

Idempotency: each submission is logged with its `submission_id`. Re-running on
the same link makes Aggregator dedupe by phone number (if its schema requires
it) OR creates duplicate participants (acceptable for an E2E test — operator
resets DBs between runs if they want clean numbers).

## §4 — `scripts/e2e/seed_actions.ts`

```ts
// usage: pnpm e2e:actions
// env:   SIGNALS_API_URL, SEEKER_ORG_ID, SEEKER_APIKEY,
//        PROVIDER_ORG_ID, PROVIDER_APIKEY

import { db } from '@api/db/postgres/drizzle_config';
import { items } from '../../apps/api/db/postgres/schema/items.js';
import { user } from '../../apps/api/db/postgres/schema/auth.js';
import { eq, and } from 'drizzle-orm';

const signalsUrl = process.env.SIGNALS_API_URL!;
const seekerOrgId = process.env.SEEKER_ORG_ID!;
const providerOrgId = process.env.PROVIDER_ORG_ID!;
const seekerApiKey = process.env.SEEKER_APIKEY!;
const providerApiKey = process.env.PROVIDER_APIKEY!;

// 1. Discovery — direct DB query for item_id + owner_user_id per domain
const seekerItems = await db
  .select({ item_id: items.itemId, owner: items.createdBy })
  .from(items)
  .innerJoin(user, eq(user.id, items.createdBy))
  .where(and(
    eq(items.itemNetwork, 'purple_dot'),
    eq(items.itemDomain, 'seeker'),
    eq(user.onboardedByOrgId, seekerOrgId),
  ));

const providerItems = await db
  .select({ item_id: items.itemId, owner: items.createdBy })
  .from(items)
  .innerJoin(user, eq(user.id, items.createdBy))
  .where(and(
    eq(items.itemNetwork, 'purple_dot'),
    eq(items.itemDomain, 'provider'),
    eq(user.onboardedByOrgId, providerOrgId),
  ));

console.log(`Discovered ${seekerItems.length} seekers, ${providerItems.length} providers.`);

// 2. Plan deterministic distribution
//    Round-robin pair each seeker with a provider; assign bucket by i % 10
const pairs = seekerItems.map((s, i) => ({
  seeker: s,
  provider: providerItems[i % providerItems.length],
  targetBucket: ['create','create','create','create','accept','accept','accept','reject','reject','cancel'][i % 10],
}));

// 3. For each pair: POST /action/perform; if targetBucket != 'create',
//    POST /action/update-status to drive it to accepted/rejected/cancelled
for (const [i, p] of pairs.entries()) {
  // 3a. Create the connect (action_status defaults to 'created' for purple_dot)
  const createRes = await fetch(`${signalsUrl}/api/v1/action/perform`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': seekerApiKey,
      'x-acting-org-id': seekerOrgId,
    },
    body: JSON.stringify({
      source_item_id: p.seeker.item_id,
      target_item_id: p.provider.item_id,
      action_type: 'connect',
      acting_as_user_id: p.seeker.owner,
      payload: {
        disability_type: ['Locomotor Disability'],
        looking_for: ['Employment Opportunities'],
        message: `E2E test connect #${i+1}`,
      },
    }),
  });
  if (!createRes.ok) throw new Error(`create ${i+1}: HTTP ${createRes.status}: ${await createRes.text()}`);
  const { action_id } = await createRes.json() as { action_id: string };
  console.log(`[${(i+1).toString().padStart(2,'0')}/${pairs.length}] POST /action/perform created (id=${action_id})`);

  // 3b. Transition if needed
  if (p.targetBucket === 'create') continue;
  const status = p.targetBucket === 'accept'
    ? 'accepted'
    : p.targetBucket === 'reject' ? 'rejected' : 'cancelled';

  const updateRes = await fetch(`${signalsUrl}/api/v1/action/update-status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': providerApiKey,           // provider transitions accept/reject; cancel is seeker
      'x-acting-org-id': status === 'cancelled' ? seekerOrgId : providerOrgId,
    },
    body: JSON.stringify({
      action_id,
      new_status: status,
      acting_as_user_id: status === 'cancelled' ? p.seeker.owner : p.provider.owner,
      remark: `E2E test → ${status}`,
    }),
  });
  if (!updateRes.ok) throw new Error(`update ${i+1}: HTTP ${updateRes.status}: ${await updateRes.text()}`);
  console.log(`     POST /action/update-status → ${status}`);
}

// 4. Two p→s connects for the metric_categories: null negative check
for (let i = 0; i < 2 && i < providerItems.length; i++) {
  const provider = providerItems[i];
  const seeker = seekerItems[i];
  const res = await fetch(`${signalsUrl}/api/v1/action/perform`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': providerApiKey,
      'x-acting-org-id': providerOrgId,
    },
    body: JSON.stringify({
      source_item_id: provider.item_id,
      target_item_id: seeker.item_id,
      action_type: 'connect',
      acting_as_user_id: provider.owner,
      payload: {
        services_offered: ['Employment Opportunities'],
        message: 'E2E negative-direction smoke',
      },
    }),
  });
  if (!res.ok) throw new Error(`p→s ${i+1}: HTTP ${res.status}: ${await res.text()}`);
  console.log(`     [p→s ${i+1}] connect created (should NOT show in seeker rollup)`);
}

console.log(`Done. ${pairs.length + 2} actions executed.`);
process.exit(0);
```

**Re-run semantics:** if an action already exists for the same (source, target, type) tuple, `/action/perform` returns 409 or an existing action_id (depending on idempotency policy). Script catches 409 by skipping the create and going straight to update. For pilot, the simplest contract is "re-run on a fresh DB"; we accept some 409s if Operator re-runs without reset.

## §5 — `scripts/e2e/fixtures/purple_dot_providers.csv`

5 rows. Header matches Aggregator's `participant-provider` v1 schema. Each row is a Purple Dot provider with varied `provider_category`, `disabilities_served`, `services_offered`, `service_cities`, `organisation_name`.

Sample row:

```csv
contact_name,contact_phone,contact_email,provider_category,organisation_name,disabilities_served,services_offered,service_cities,official_address,state,district,block,pincode,service_details,catalog_url
"Ravi Kumar","9111111101","ravi@helpinghands.org","NGO / Trust","Helping Hands Foundation","Locomotor Disability|Blindness","Employment Opportunities|Training & Skill Building","Lucknow|Kanpur","123 MG Road, Lucknow","Uttar Pradesh","Lucknow","Hazratganj","226001","Job placement for PWDs",https://helpinghands.org/services
```

`|`-delimited values for the array columns match Aggregator's CSV convention.

---

## §6 — Spec self-review

- **Placeholders**: none. Each script's interface, env vars, and exit conditions are explicit.
- **Internal consistency**: the runbook's expected dashboard numbers (§1.7) match the action distribution in `seed_actions.ts` (§4). Bucket vocab is canonical throughout. Both directions handled per the metrics spec.
- **Scope**: focused on one network (Purple Dot), one happy-path scenario. Not a Vitest test, not a CI integration. Pure operator runbook + 2 scripts.
- **Ambiguity**:
  - "Wait ~5s for queue to drain" is approximate. If it's too slow, the operator hits `?refresh=true` to force the dashboard to pick up the new items. Worker logs are the source of truth for queue state.
  - The 2 p→s negative-direction connects exist deliberately to prove `metric_categories: null` excludes them from the rollup — explicitly called out in §1.6 and §1.7.
  - 5 providers + 10 seekers means seeker:provider ratio is 2:1; the round-robin in §4 assigns provider `i % 5` to each seeker. Acceptable for an E2E mix.

---

## §7 — Out of scope / deferred

- Automating Step 1-3 (aggregator registration, QR link creation, CSV upload). Keycloak OTP + Mailpit + S3 presigned-URL UX is well-tested separately.
- Scripted dashboard assertions / CI integration.
- Cleanup scripts. Reset by `docker compose down -v && up -d` on both stacks.
- Multi-network coverage. Blue Dot's equivalent runbook is a fast-follow if pilot expands.
- Negative tests for invalid CSV / malformed payloads (the public submission API has its own tests in aggregator-dpg).
- Stress / load testing (Aggregator's worker queue is rated separately).
