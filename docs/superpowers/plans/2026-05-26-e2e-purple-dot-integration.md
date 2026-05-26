# E2E Purple Dot Integration Test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide two scripts (`pnpm e2e:qr`, `pnpm e2e:actions`) plus a markdown runbook so an operator can exercise the full Aggregator-DPG ↔ Signals-DPG Purple Dot handshake — public QR submissions, bulk CSV upload, connect actions across both domains, dashboard verification — without seeding directly into Signals' DB.

**Architecture:** Two TypeScript scripts under `Signals-DPG/scripts/e2e/`, invoked via `tsx` from root `package.json` scripts. `submit_qr_participants.ts` hits Aggregator's public registration endpoint. `seed_actions.ts` discovers item_id + owner_user_id from Signals' DB (test-fixture privilege), then drives `/action/perform` + `/action/update-status` via real HTTP using Plan A's aggregator on-behalf-of semantics. Operator handles UI-driven setup steps (aggregator self-reg, QR link creation, bulk upload) per a markdown runbook.

**Tech Stack:** TypeScript (ESM, strict), `tsx` for execution, Drizzle ORM (for the action driver's discovery step), `node-fetch` (built-in `fetch`), pnpm workspace. Targets Purple Dot canonical config.

**Spec:** `docs/superpowers/specs/2026-05-26-e2e-purple-dot-integration-design.md`
**Branch:** `chore/e2e-purple-dot-integration` (stacked off `chore/metrics-config-driven-redesign`).

---

## File map

**Create:**
- `scripts/e2e/fixtures/purple_dot_qr_payloads.json` — 10 deterministic seeker records.
- `scripts/e2e/fixtures/purple_dot_providers.csv` — 5-row bulk upload fixture for Aggregator's provider domain.
- `scripts/e2e/submit_qr_participants.ts` — QR submitter (Task 2).
- `scripts/e2e/seed_actions.ts` — action driver (Task 3).
- `scripts/e2e/README.md` — short pointer to the runbook.
- `scripts/e2e/.env.example` — env vars template (gitignored `.env` lives alongside).
- `docs/operations/e2e-purple-dot-runbook.md` — full operator runbook.

**Modify:**
- `package.json` (root) — add `e2e:qr` and `e2e:actions` script entries; ensure `tsx` is available as a workspace devDependency.
- `apps/api/scripts/seed_purple_dot.ts` — add a top-of-file header noting this is now a fast-path fallback that bypasses Aggregator.
- `.gitignore` — add `scripts/e2e/.env` and `scripts/e2e/scratch/` entries.

---

## Task 1: Fixtures

**Files:**
- Create: `scripts/e2e/fixtures/purple_dot_qr_payloads.json`
- Create: `scripts/e2e/fixtures/purple_dot_providers.csv`

- [ ] **Step 1: Write `purple_dot_qr_payloads.json`**

Write to `scripts/e2e/fixtures/purple_dot_qr_payloads.json` exactly:

```json
[
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
  },
  {
    "beneficiary_name": "Rakesh Kumar",
    "mobile_number": "9000000002",
    "age": 34,
    "gender": "Male",
    "disability_type": ["Blindness"],
    "disability_percentage": 100,
    "looking_for": ["Training & Skill Building", "Assistive Devices"],
    "looking_for_details": "Screen-reader training and a refreshable braille display",
    "service_city": "Kanpur",
    "documents_available": ["Aadhaar", "Disability Certificate", "Income Certificate"]
  },
  {
    "beneficiary_name": "Meera Singh",
    "mobile_number": "9000000003",
    "age": 22,
    "gender": "Female",
    "disability_type": ["Hearing Impairment"],
    "disability_percentage": 70,
    "looking_for": ["Scholarships", "Training & Skill Building"],
    "looking_for_details": "Sign-language training course; tuition support",
    "service_city": "Lucknow",
    "documents_available": ["Aadhaar", "Disability Certificate", "School ID"]
  },
  {
    "beneficiary_name": "Vikram Yadav",
    "mobile_number": "9000000004",
    "age": 41,
    "gender": "Male",
    "disability_type": ["Locomotor Disability"],
    "disability_percentage": 40,
    "looking_for": ["Employment Opportunities"],
    "looking_for_details": "Computer operator role, work-from-home",
    "service_city": "Varanasi",
    "documents_available": ["Aadhaar", "Disability Certificate"]
  },
  {
    "beneficiary_name": "Priya Sharma",
    "mobile_number": "9000000005",
    "age": 26,
    "gender": "Female",
    "disability_type": ["Low Vision"],
    "disability_percentage": 50,
    "looking_for": ["Counselling & Mentorship", "Employment Opportunities"],
    "looking_for_details": "Career counselling for accessible roles",
    "service_city": "Lucknow",
    "documents_available": ["Aadhaar", "Disability Certificate"]
  },
  {
    "beneficiary_name": "Sanjay Verma",
    "mobile_number": "9000000006",
    "age": 38,
    "gender": "Male",
    "disability_type": ["Multiple Disabilities"],
    "disability_percentage": 80,
    "looking_for": ["Health & Rehabilitation", "Application Support"],
    "looking_for_details": "Pension scheme application assistance",
    "service_city": "Allahabad",
    "documents_available": ["Aadhaar", "Disability Certificate", "Income Certificate"]
  },
  {
    "beneficiary_name": "Anjali Gupta",
    "mobile_number": "9000000007",
    "age": 19,
    "gender": "Female",
    "disability_type": ["Cerebral Palsy"],
    "disability_percentage": 75,
    "looking_for": ["Scholarships", "Health & Rehabilitation"],
    "looking_for_details": "College scholarship and physiotherapy sessions",
    "service_city": "Lucknow",
    "documents_available": ["Aadhaar", "Disability Certificate", "School ID"]
  },
  {
    "beneficiary_name": "Manoj Tiwari",
    "mobile_number": "9000000008",
    "age": 45,
    "gender": "Male",
    "disability_type": ["Locomotor Disability"],
    "disability_percentage": 55,
    "looking_for": ["Financial Products (Loans/Insurance)"],
    "looking_for_details": "Microloan for assistive-tech-equipped tailoring shop",
    "service_city": "Kanpur",
    "documents_available": ["Aadhaar", "Disability Certificate", "Bank Account"]
  },
  {
    "beneficiary_name": "Sunita Pal",
    "mobile_number": "9000000009",
    "age": 31,
    "gender": "Female",
    "disability_type": ["Speech and Language Disability"],
    "disability_percentage": 65,
    "looking_for": ["Employment Opportunities", "Accessibility Support"],
    "looking_for_details": "Communication-light data-entry role with AAC support",
    "service_city": "Lucknow",
    "documents_available": ["Aadhaar", "Disability Certificate"]
  },
  {
    "beneficiary_name": "Deepak Mishra",
    "mobile_number": "9000000010",
    "age": 29,
    "gender": "Male",
    "disability_type": ["Intellectual Disability"],
    "disability_percentage": 50,
    "looking_for": ["Training & Skill Building", "Employment Opportunities"],
    "looking_for_details": "Sheltered workshop training; supported employment",
    "service_city": "Varanasi",
    "documents_available": ["Aadhaar", "Disability Certificate"]
  }
]
```

- [ ] **Step 2: Write `purple_dot_providers.csv`**

Write to `scripts/e2e/fixtures/purple_dot_providers.csv` exactly:

```csv
contact_name,contact_phone,contact_email,provider_category,organisation_name,disabilities_served,services_offered,service_cities,official_address,state,district,block,pincode,service_details,catalog_url
Ravi Kumar,9111111101,ravi@helpinghands.org,NGO / Trust,Helping Hands Foundation,Locomotor Disability|Blindness,Employment Opportunities|Training & Skill Building,Lucknow|Kanpur,"123 MG Road, Lucknow",Uttar Pradesh,Lucknow,Hazratganj,226001,Job placement and skilling for PWDs,https://helpinghands.org/services
Sneha Reddy,9111111102,sneha@accessequip.in,Private Company,Access Equip Pvt Ltd,Locomotor Disability|Cerebral Palsy|Multiple Disabilities,Assistive Devices,Lucknow|Varanasi|Allahabad,"45 Civil Lines, Allahabad",Uttar Pradesh,Allahabad,Civil Lines,211001,Wheelchairs prosthetics and mobility aids,https://accessequip.in/catalog
Dr Anil Joshi,9111111103,anil@inclusivecare.health,Hospital / Clinic,Inclusive Care Hospital,Hearing Impairment|Speech and Language Disability,Health & Rehabilitation|Application Support,Lucknow,"77 Hazratganj, Lucknow",Uttar Pradesh,Lucknow,Hazratganj,226001,Audiology and speech therapy services,
Kavita Sinha,9111111104,kavita@scholarpath.ngo,NGO / Trust,Scholar Path Trust,Multiple Disabilities|Low Vision|Cerebral Palsy,Scholarships|Counselling & Mentorship,Kanpur|Varanasi,"22 Patel Nagar, Kanpur",Uttar Pradesh,Kanpur,Patel Nagar,208002,Education funding and life-skills mentorship,
Ramesh Bhatia,9111111105,ramesh@finsolve.example,Private Company,FinSolve Financial Services,Multiple Disabilities,Financial Products (Loans/Insurance),Lucknow|Kanpur|Varanasi|Allahabad,"5 Banking Street, Lucknow",Uttar Pradesh,Lucknow,Aliganj,226024,Microloans and disability-friendly insurance,https://finsolve.example/products
```

Note: array fields (`disabilities_served`, `services_offered`, `service_cities`) use `|` as separator — matches Aggregator's CSV import convention (verify against Aggregator's `participant-provider` v1 schema before running; if its convention is comma-in-cell, re-edit accordingly).

- [ ] **Step 3: Commit fixtures**

Skip (user requested no commits).

---

## Task 2: QR participant submitter

**Files:**
- Create: `scripts/e2e/submit_qr_participants.ts`
- Modify: `package.json` (root) — add `e2e:qr` script

- [ ] **Step 1: Write the script**

Create `scripts/e2e/submit_qr_participants.ts`:

```ts
/**
 * Submit synthetic Purple Dot seeker registrations to Aggregator-DPG's
 * public registration link endpoint. Aggregator's worker then pushes
 * the participants to Signals-DPG via signalstack-writer.
 *
 * Usage:
 *   pnpm e2e:qr <link-slug> [count=10]
 *
 * Env:
 *   AGGREGATOR_API_URL  e.g. http://localhost:4000
 *   SEEKER_ORG_SLUG     e.g. purple-dot-seekers-aggregator
 *
 * Fixture:
 *   scripts/e2e/fixtures/purple_dot_qr_payloads.json — 10 records;
 *   the script rotates through them when count > 10.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const linkSlug = process.argv[2];
const count = Number(process.argv[3] ?? 10);

if (!linkSlug) {
  console.error('Usage: pnpm e2e:qr <link-slug> [count=10]');
  process.exit(1);
}
if (!Number.isFinite(count) || count <= 0) {
  console.error(`count must be a positive integer, got: ${process.argv[3]}`);
  process.exit(1);
}

const aggApiUrl = required('AGGREGATOR_API_URL');
const orgSlug = required('SEEKER_ORG_SLUG');

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const fixturePath = resolve(__dirname, 'fixtures/purple_dot_qr_payloads.json');
const payloads = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<Record<string, unknown>>;
if (payloads.length === 0) {
  console.error(`Fixture is empty: ${fixturePath}`);
  process.exit(1);
}

console.log(`Submitting ${count} synthetic seekers to ${aggApiUrl}/public/v1/aggregators/${orgSlug}/registrations/${linkSlug}`);

let i = 0;
while (i < count) {
  const payload = payloads[i % payloads.length];
  const url = `${aggApiUrl}/public/v1/aggregators/${orgSlug}/registrations/${linkSlug}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '5');
    console.log(`[${(i + 1).toString().padStart(2, '0')}/${count}] 429 rate-limited; waiting ${retryAfter}s and retrying`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    continue; // retry same index
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[${(i + 1).toString().padStart(2, '0')}/${count}] HTTP ${res.status}: ${body}`);
    process.exit(1);
  }

  const result = (await res.json()) as { submission_id?: string; id?: string };
  const subId = result.submission_id ?? result.id ?? '(no id in response)';
  console.log(`[${(i + 1).toString().padStart(2, '0')}/${count}] POST submitted → submission_id=${subId}`);
  i++;
}

console.log(`All ${count} submissions accepted.`);
console.log('Wait ~5s for Aggregator queue to drain (signalstack-writer pushes to Signals).');
```

- [ ] **Step 2: Add `e2e:qr` script to root `package.json`**

Open `package.json` at the repo root, locate the `"scripts"` block, and add a new entry. The exact insertion depends on existing scripts; here's the pattern to add:

```json
"e2e:qr": "tsx scripts/e2e/submit_qr_participants.ts"
```

If `tsx` is not already a workspace devDependency, add it:

```bash
pnpm add -w -D tsx
```

(Most likely it's already present because `apps/api` uses it for dev — confirm with `pnpm list -w tsx 2>&1 | grep tsx` before installing.)

- [ ] **Step 3: Smoke test the script (without an Aggregator running)**

Confirm the script's arg validation works without hitting the network:

```
pnpm e2e:qr
```

Expected: `Usage: pnpm e2e:qr <link-slug> [count=10]` then exit 1.

```
AGGREGATOR_API_URL=http://localhost:4000 pnpm e2e:qr test-slug 3
```

Expected: `Missing env var: SEEKER_ORG_SLUG` then exit 1.

Once both Aggregator and Signals stacks are running with a real link slug, you can test the happy path manually — that's covered by the runbook in Task 5.

- [ ] **Step 4: Commit**

Skip (user requested no commits).

---

## Task 3: Action driver (with timestamp backdating)

**Files:**
- Create: `scripts/e2e/seed_actions.ts`
- Modify: `package.json` (root) — add `e2e:actions` script

The driver performs three things in order: (a) creates actions via HTTP using Plan A's on-behalf-of, (b) drives target action_status transitions via HTTP, (c) backdates `items.created_at` and `item_actions.created_at` via direct DB UPDATE so the dashboard rollup lands items across all four `profile_status` buckets (`new`, `active`, `at_risk`, `inactive`) instead of bunching everyone at `new` from same-day timestamps.

### Distribution plan

10 seekers, deterministic. Per-row `item_age_days` and (optional) action with target bucket + `action_age_days` chosen so the rule evaluator lands each row in a specific `profile_status`:

| # | item_age_days | action.bucket | action.age_days | expected profile_status |
|---|---|---|---|---|
| 0 | 2 | create | 1 | new |
| 1 | 5 | create | 2 | new |
| 2 | 15 | create | 10 | active |
| 3 | 20 | accept | 15 | active |
| 4 | 25 | accept | 5 | active |
| 5 | 60 | create | 45 | at_risk |
| 6 | 70 | reject | 50 | at_risk |
| 7 | 80 | accept | 60 | at_risk |
| 8 | 100 | — (no action) | — | inactive |
| 9 | 120 | cancel | 100 | inactive |

Status totals: `{ new: 2, active: 3, at_risk: 3, inactive: 2 }`.
Action bucket totals: `{ create: 4, accept: 3, reject: 1, cancel: 1 }` (9 actions across 10 seekers; row #8 has none).

Per-row reasoning against the canonical `status_rules` template:
- Rows 0-1: `item_age_days <= 7` → `new`.
- Rows 2-4: action in {create, accept} within 30d → `active`.
- Rows 5-7: most recent action in {create, accept, reject} is 31-90d old AND item_age > 7 → `at_risk`.
- Row 8: no action exists → no `active`/`at_risk` predicate matches → `inactive` (default).
- Row 9: only `cancel` exists, but `cancel` is not in the at_risk bucket set; `active` predicate looks at {create, accept} only and finds nothing → falls through to `inactive`.

Plus 2 p→s connects on rows 0-1 for the `metric_categories: null` negative-direction smoke test (same as before — these don't affect rollup counts).

- [ ] **Step 1: Write the script**

Create `scripts/e2e/seed_actions.ts`:

```ts
/**
 * Drive Purple Dot connect actions across both domains, then backdate
 * timestamps so the dashboard rollup distributes items across all four
 * profile_status buckets (new / active / at_risk / inactive).
 *
 * Flow:
 *   1. Discover seekers + providers via direct DB query (test-fixture
 *      privilege — actions still go through real HTTP).
 *   2. For each (seeker, distribution-plan-row): create connect via
 *      /action/perform (Plan A on-behalf-of), optionally transition via
 *      /action/update-status.
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
 *
 * Idempotency: re-running on the same data may produce 409 from /action/perform
 * if an action already exists for the (source, target, type) tuple. The
 * script catches 409 and skips to the update step using the existing action_id.
 * Timestamp UPDATEs are idempotent by construction.
 */
import { db } from '@api/db/postgres/drizzle_config';
import { items, item_actions } from '@dpg/database';
import { user } from '../../apps/api/db/postgres/schema/auth.js';
import { eq, and, sql } from 'drizzle-orm';

const signalsUrl = required('SIGNALS_API_URL');
const seekerOrgId = required('SEEKER_ORG_ID');
const providerOrgId = required('PROVIDER_ORG_ID');
const seekerApiKey = required('SEEKER_APIKEY');
const providerApiKey = required('PROVIDER_APIKEY');

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

async function discover(domain: 'seeker' | 'provider', orgId: string): Promise<ItemRef[]> {
  const rows = await db
    .select({
      item_id: items.itemId,
      item_network: items.itemNetwork,
      item_domain: items.itemDomain,
      item_type: items.itemType,
      owner_user_id: items.createdBy,
    })
    .from(items)
    .innerJoin(user, eq(user.id, items.createdBy))
    .where(
      and(
        eq(items.itemNetwork, 'purple_dot'),
        eq(items.itemDomain, domain),
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

// Apply the plan to the first N seekers, where N = min(planLength, seekerCount).
// Extra seekers beyond the plan are left untouched (created_at unchanged, no
// action). Their status will be `new` or `inactive` depending on their actual
// onboarding age.
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

async function postUpdate(
  actionId: string,
  newStatus: string,
  apiKey: string,
  orgId: string,
  remark: string,
): Promise<{ status: number; body: { error?: string; message?: string } }> {
  const res = await fetch(`${signalsUrl}/api/v1/action/update-status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-acting-org-id': orgId,
    },
    body: JSON.stringify({
      action_id: actionId,
      action_status: newStatus,
      remarks: remark,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return { status: res.status, body };
}

async function lookupExistingActionId(sourceItemId: string, targetItemId: string): Promise<string | null> {
  const rows = await db
    .select({ action_id: item_actions.actionId })
    .from(item_actions)
    .where(
      and(
        eq(item_actions.sourceItemId, sourceItemId),
        eq(item_actions.targetItemId, targetItemId),
        eq(item_actions.actionType, 'connect'),
      ),
    )
    .limit(1);
  return rows[0]?.action_id ?? null;
}

/**
 * Backdate items.created_at to NOW() - age_days. Leaves updated_at alone.
 */
async function backdateItem(itemId: string, ageDays: number): Promise<void> {
  await db.execute(sql`
    UPDATE items
    SET created_at = NOW() - (${ageDays} * INTERVAL '1 day')
    WHERE item_id = ${itemId}
  `);
}

/**
 * Backdate item_actions.created_at to NOW() - age_days. Leaves updated_at alone.
 * Action's `created_at` is the event-stream timestamp the recompute uses for
 * MAX(created_at) per bucket (see recompute.ts).
 */
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
    // 3a. Create the connect (seeker initiates)
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
      // accept/reject → provider transitions; cancel → seeker transitions
      const useProvider = newStatus === 'accepted' || newStatus === 'rejected';
      const upd = await postUpdate(
        actionId,
        newStatus,
        useProvider ? providerApiKey : seekerApiKey,
        useProvider ? providerOrgId : seekerOrgId,
        `E2E test → ${newStatus}`,
      );
      if (upd.status !== 200) {
        console.error(`${label} /action/update-status (${newStatus}) failed: HTTP ${upd.status}`);
        console.error(`  body:`, upd.body);
        process.exit(1);
      }
      console.log(`${label}      update → ${newStatus}`);
    }
  } else {
    console.log(`${label} (no action; target=${plan.expected_status})`);
  }

  // 3c. Backdate item (always — even rows with no action need correct item_age)
  await backdateItem(p.seeker.item_id, plan.item_age_days);
  console.log(`${label}      item.created_at ← NOW() - ${plan.item_age_days}d`);

  // 3d. Backdate action (if one was created)
  if (actionId && plan.action) {
    await backdateAction(actionId, plan.action.age_days);
    console.log(`${label}      action.created_at ← NOW() - ${plan.action.age_days}d`);
  }
}

// 4. Two provider→seeker connects (negative direction; metric_categories: null)
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

console.log('');
console.log('Done. After ?refresh=true on the dashboard you should see:');
console.log('  by_status         :', expectedCounts);
console.log('  by_action_status  :', bucketCounts, '(seeker side; provider side mirrors)');
process.exit(0);
```

- [ ] **Step 2: Add `e2e:actions` script to root `package.json`**

Append a new entry to the `"scripts"` block:

```json
"e2e:actions": "tsx scripts/e2e/seed_actions.ts"
```

The script imports from `@api/db/postgres/drizzle_config`, `@dpg/database`, and `../../apps/api/db/postgres/schema/auth.js`. The `@api/` and `@dpg/` aliases are workspace-level aliases declared in `tsconfig.base.json` / `apps/api/tsconfig.json`. Confirm `tsx` honors them — if not, fall back to relative imports for `drizzle_config` (`../../apps/api/db/postgres/drizzle_config.js`).

- [ ] **Step 3: Smoke test arg validation**

```
pnpm e2e:actions
```

Expected: `Missing env var: SIGNALS_API_URL` then exit 1.

The real test requires the full stack + populated DB — see runbook in Task 5.

- [ ] **Step 4: Commit**

Skip (user requested no commits).

---

## Task 4: README + env example + gitignore

**Files:**
- Create: `scripts/e2e/README.md`
- Create: `scripts/e2e/.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Write `scripts/e2e/README.md`**

```markdown
# E2E Purple Dot Integration Scripts

Operator-driven scripts that exercise the full Aggregator-DPG ↔ Signals-DPG
handshake for the Purple Dot network. See the full runbook at
`docs/operations/e2e-purple-dot-runbook.md`.

## Quick reference

```
# Submit synthetic QR seekers (after creating an active link via Aggregator UI)
pnpm e2e:qr <link-slug> [count=10]

# Drive connect actions across both domains (after both QR submissions
# and bulk upload have flushed to Signals)
pnpm e2e:actions
```

Copy `.env.example` to `.env` and fill in the values from your aggregator
registration steps. The `.env` file is gitignored.
```

- [ ] **Step 2: Write `scripts/e2e/.env.example`**

```
# Endpoints
AGGREGATOR_API_URL=http://localhost:4000
SIGNALS_API_URL=http://localhost:2742

# Seeker aggregator (created via Aggregator UI, domain=seeker)
SEEKER_ORG_SLUG=purple-dot-seekers-aggregator
SEEKER_ORG_ID=org_replace_me
SEEKER_APIKEY=apikey_replace_me

# Provider aggregator (created via Aggregator UI, domain=provider)
PROVIDER_ORG_SLUG=purple-dot-providers-aggregator
PROVIDER_ORG_ID=org_replace_me
PROVIDER_APIKEY=apikey_replace_me

# The slug printed by the Aggregator UI when you create a registration link
# (not used by e2e:actions; pass as the first positional arg to e2e:qr)
QR_LINK_SLUG=replace_me
```

- [ ] **Step 3: Update root `.gitignore`**

Open `.gitignore` and append:

```
# E2E test scratch + env
scripts/e2e/.env
scripts/e2e/scratch/
```

- [ ] **Step 4: Verify**

```
ls -la scripts/e2e/
```

Expected:
```
.env.example
README.md
fixtures/
seed_actions.ts
submit_qr_participants.ts
```

```
git check-ignore -v scripts/e2e/.env 2>&1 || echo "not ignored"
```

Expected: ignored by the new `.gitignore` entry.

- [ ] **Step 5: Commit**

Skip (user requested no commits).

---

## Task 5: Operator runbook

**Files:**
- Create: `docs/operations/e2e-purple-dot-runbook.md`

- [ ] **Step 1: Write the runbook**

Create `docs/operations/e2e-purple-dot-runbook.md`:

```markdown
# Purple Dot — End-to-End Integration Runbook

This runbook walks through a full Aggregator ↔ Signals integration test for
the Purple Dot network. Operator handles stack launch + UI-driven steps
(aggregator self-registration, QR link creation, CSV bulk upload). Two
scripts in `scripts/e2e/` automate the rest.

Spec: `docs/superpowers/specs/2026-05-26-e2e-purple-dot-integration-design.md`

## Prerequisites

Both stacks running locally:

```bash
# Aggregator-DPG (sibling repo: ../aggregator-dpg)
cd ../aggregator-dpg
make up                                              # Postgres, Keycloak, Redis, Mailpit
pnpm --filter @aggregator-dpg/api dev                # API :4000
pnpm --filter @aggregator-dpg/web dev                # Web :3000
pnpm --filter @aggregator-dpg/worker dev             # BullMQ worker

# Signals-DPG (this repo)
cd ../Signals-DPG
docker compose up -d db redis                        # Postgres :5432, Redis :6379
pnpm dev:api                                         # API :2742
```

Confirm:
- Aggregator UI loads at `http://localhost:3000`
- Mailpit reachable at `http://localhost:8025` (OTP capture)
- Signals API responds at `http://localhost:2742/api/v1/health` (or equivalent)

## Step 1 — Register two aggregators (UI)

1. Open `http://localhost:3000` and register the seeker aggregator:
   - Name: `PurpleDot Seekers Aggregator`
   - Domain: `seeker`
   - Email: `seeker-agg@local.dev`
   - Retrieve OTP from Mailpit (`http://localhost:8025`)
   - Complete approval flow

2. Repeat for the provider aggregator:
   - Name: `PurpleDot Providers Aggregator`
   - Domain: `provider`
   - Email: `provider-agg@local.dev`

After each registration, capture:
- `org_id` (Signals' org id)
- `slug` (URL-safe identifier)
- `apikey` (Signals API key, issued during the approval handshake)

These values appear in the Aggregator's profile/settings page or in the
Signals admin log when the org is provisioned.

3. Copy `scripts/e2e/.env.example` to `scripts/e2e/.env` and fill in:

```
AGGREGATOR_API_URL=http://localhost:4000
SIGNALS_API_URL=http://localhost:2742

SEEKER_ORG_SLUG=purple-dot-seekers-aggregator
SEEKER_ORG_ID=org_<...>
SEEKER_APIKEY=<...>

PROVIDER_ORG_SLUG=purple-dot-providers-aggregator
PROVIDER_ORG_ID=org_<...>
PROVIDER_APIKEY=<...>
```

## Step 2 — Seeker aggregator creates a QR link (UI)

1. Sign in as `seeker-agg@local.dev`
2. Navigate to Onboarding → New Link
3. Configure:
   - Domain: `seeker`
   - Name: `E2E QR Test`
4. Activate the link (status moves from `draft` → `live`)
5. Copy the link slug from the link detail page
6. Add to `scripts/e2e/.env`:

```
QR_LINK_SLUG=<slug>
```

## Step 3 — Provider aggregator does bulk upload (UI)

1. Sign in as `provider-agg@local.dev`
2. Navigate to Onboarding → Bulk Upload
3. Download the CSV template for the provider domain
4. Sanity check: column headers should match
   `scripts/e2e/fixtures/purple_dot_providers.csv`. If they don't, copy the
   downloaded template and re-edit the fixture to match — Aggregator's
   provider schema is the source of truth for the column set.
5. Upload `scripts/e2e/fixtures/purple_dot_providers.csv`
6. Wait for the BullMQ worker to process (status moves `uploaded` →
   `processing` → `completed`)
7. Confirm "5 participants onboarded" in the UI

## Step 4 — Submit synthetic QR seekers (scripted)

```bash
set -a; source scripts/e2e/.env; set +a
pnpm e2e:qr "$QR_LINK_SLUG" 10
```

Expected output:

```
Submitting 10 synthetic seekers to http://localhost:4000/public/v1/aggregators/.../registrations/...
[01/10] POST submitted → submission_id=sub_...
[02/10] POST submitted → submission_id=sub_...
...
[10/10] POST submitted → submission_id=sub_...
All 10 submissions accepted.
Wait ~5s for Aggregator queue to drain (signalstack-writer pushes to Signals).
```

Wait 5-10 seconds, then verify Aggregator's worker has flushed:

```bash
# Check the Aggregator worker log; you should see signalstack-writer hits.
# Or query Signals' user table directly:
psql -h localhost -p 5432 -U postgres -d signals_dpg -c \
  "SELECT COUNT(*) FROM \"user\" WHERE onboarded_by_org_id = '$SEEKER_ORG_ID';"
# Expect: 10
```

## Step 5 — Drive connect actions (scripted)

```bash
pnpm e2e:actions
```

Expected output:

```
Discovered 10 seekers, 5 providers.
Applying plan to 10 seekers (any extras left as-is).
Expected profile_status counts:        { new: 2, active: 3, at_risk: 3, inactive: 2 }
Expected by_action_status counts (seeker side): { create: 4, accept: 3, reject: 1, cancel: 1 }
Plus 2 provider→seeker connects (metric_categories: null, should not affect rollup).
[01/10] perform → created action=...  target=create/new
[01/10]      item.created_at ← NOW() - 2d
[01/10]      action.created_at ← NOW() - 1d
[02/10] perform → created action=...  target=create/new
...
[09/10] (no action; target=inactive)
[09/10]      item.created_at ← NOW() - 100d
[10/10] perform → created action=...  target=cancel/inactive
[10/10]      update → cancelled
[10/10]      item.created_at ← NOW() - 120d
[10/10]      action.created_at ← NOW() - 100d
[p→s 1/2] connect created (id=...) — should NOT show in seeker rollup
[p→s 2/2] connect created (id=...) — should NOT show in seeker rollup

Done. After ?refresh=true on the dashboard you should see:
  by_status         : { new: 2, active: 3, at_risk: 3, inactive: 2 }
  by_action_status  : { create: 4, accept: 3, reject: 1, cancel: 1 } (seeker side; provider side mirrors)
```

## Step 6 — Verify dashboards (manual)

### Seeker aggregator dashboard

Sign in as `seeker-agg@local.dev` and open the Dashboard page. (Trigger a
recompute first via the curl one-liner in §1.8 — without it, the rollup
may still reflect pre-backdate timestamps.)

Expected `seeker` rollup:

| Field | Expected |
|---|---|
| `total_items` | 10 |
| `complete_profiles` | 10 (every fixture record fills every required field) |
| `has_applications` | 9 (row #8 has no action) |
| `by_status.new` | 2 |
| `by_status.active` | 3 |
| `by_status.at_risk` | 3 |
| `by_status.inactive` | 2 |
| `by_action_status.create` | 4 |
| `by_action_status.accept` | 3 |
| `by_action_status.reject` | 1 |
| `by_action_status.cancel` | 1 |
| `avg_items_per_user` | 1.0 |
| `avg_actions_per_user` | ~1.0 (9 actions across 9 engaged users) |
| `mode_wise_counts.link` | 10 |

### Provider aggregator dashboard

Sign in as `provider-agg@local.dev` and open the Dashboard page.

Expected `provider` rollup:

| Field | Expected |
|---|---|
| `total_items` | 5 |
| `complete_profiles` | 5 |
| `has_applications` | 5 (every provider is the target of at least one connect from the round-robin pairing) |
| `by_action_status.create` | 4 (same actions seen from provider side) |
| `by_action_status.accept` | 3 |
| `by_action_status.reject` | 1 |
| `by_action_status.cancel` | 1 |
| `mode_wise_counts.bulk` | 5 |

Provider `by_status` depends on the backdating applied to SEEKER items
only — the script does not backdate provider items. Providers will land
mostly in `new` or `active` (recent provider onboarding + recent actions
in their role as targets). This is intentional: the test demonstrates
that seekers and providers can have independent status distributions
even though they share the same action stream.

### Negative-direction check

The 2 provider→seeker connects from Step 5 use the `connect` interaction
that has `metric_categories: null` in `purple_dot/network.json`. They
should NOT inflate any `by_action_status` bucket. If they do, that's a
bug — likely in the `collect_tracked_interactions` walk.

## Fast inspection one-liner

If the UI is showing stale numbers, force a recompute and inspect via curl:

```bash
curl -s "$SIGNALS_API_URL/api/v1/aggregator/dashboard?refresh=true" \
  -H "x-api-key: $SEEKER_APIKEY" \
  -H "x-acting-org-id: $SEEKER_ORG_ID" \
  | jq '.by_domain.seeker.rollup'
```

## Troubleshooting

**Symptom:** `total_items: 0` on the seeker dashboard after Step 4.

- Wait longer. Aggregator's BullMQ worker is async; allow 10-30s.
- Check Aggregator's `onboarding` table:
  ```bash
  psql -h localhost -p 5433 -U postgres -d aggregator_dpg \
    -c "SELECT COUNT(*) FROM onboarding WHERE source = 'link';"
  ```
- Check worker logs:
  ```bash
  pnpm --filter @aggregator-dpg/worker logs    # or wherever its logs go
  ```
- Check Signals `/admin/participant` access logs for inbound POSTs from
  Aggregator's `signalstack-writer`.

**Symptom:** `by_action_status` is all zero.

- Confirm `metric_categories` on the seeker→provider `connect` interaction
  in `examples/schemas/purple_dot/network.json` uses canonical keys
  (`create`/`accept`/`reject`/`cancel`). These shipped with PR #26.
- Restart Signals API to reload its network config cache.

**Symptom:** `?refresh=true` doesn't seem to refresh.

- Check for orphaned advisory locks:
  ```sql
  SELECT * FROM pg_locks WHERE locktype = 'advisory';
  ```
- If you see one held by a dead session, kill it:
  ```sql
  SELECT pg_terminate_backend(<pid>);
  ```

**Symptom:** `pnpm e2e:actions` fails with `No seekers discovered`.

- Step 4 didn't complete. Re-check Aggregator's worker queue.
- The script uses `items.created_by → user.onboarded_by_org_id` to filter.
  Confirm Aggregator's `signalstack-writer` is correctly attributing
  users to the seeker org id you provided.

## Resetting between runs

```bash
# Aggregator side
cd ../aggregator-dpg
make reset                                    # DESTROYS data — use with care
make up

# Signals side
cd ../Signals-DPG
docker compose down -v
docker compose up -d db redis
pnpm db:migrate:api
```

Re-register the aggregators from Step 1.
```

- [ ] **Step 2: Commit**

Skip (user requested no commits).

---

## Task 6: Mark `seed_purple_dot.ts` as fallback

**Files:**
- Modify: `apps/api/scripts/seed_purple_dot.ts` (header comment only)

- [ ] **Step 1: Add a header note**

Open `apps/api/scripts/seed_purple_dot.ts`. The current header comment is a JSDoc-style block describing what the script does. Insert a new paragraph at the very top of that comment (after the opening `/**`) explaining the fallback status:

The existing comment looks like:
```ts
/**
 * Seed Purple Dot sample records.
 *
 * Creates:
 *   - organization "purple_dot_aggregator" (type='aggregator')   [default mode only]
 *   - user "purple_dot_seed" (service account for the aggregator)
 *   ...
```

Replace the first three lines with:

```ts
/**
 * Seed Purple Dot sample records — FAST-PATH FALLBACK.
 *
 * This script bypasses the Aggregator-DPG handshake and writes directly to
 * Signals' DB. Useful for fast iteration on Signals-internal features.
 *
 * For full end-to-end integration testing of the Aggregator → Signals flow,
 * use the operator runbook at:
 *   docs/operations/e2e-purple-dot-runbook.md
 * which drives the real public registration endpoint via
 *   pnpm e2e:qr <link-slug> [count]
 * and the real /action/perform API via
 *   pnpm e2e:actions
 *
 * Creates (when run via this fallback):
 *   - organization "purple_dot_aggregator" (type='aggregator')   [default mode only]
 *   - user "purple_dot_seed" (service account for the aggregator)
 *   ...
```

Keep all the rest of the comment and the script body verbatim.

- [ ] **Step 2: Verify syntax**

The file should still parse cleanly:

```bash
pnpm --filter api exec tsc --noEmit apps/api/scripts/seed_purple_dot.ts
```

Expected: no new errors (any pre-existing TS errors in the script are out of scope).

- [ ] **Step 3: Commit**

Skip (user requested no commits).

---

## Self-review against spec

| Spec section | Task |
|---|---|
| §1 Runbook structure | Task 5 |
| §2 QR fixture JSON (10 records) | Task 1 Step 1 |
| §3 `submit_qr_participants.ts` script | Task 2 |
| §4 `seed_actions.ts` script (discovery via DB; deterministic mix; 2 p→s) | Task 3 |
| §5 Provider CSV fixture | Task 1 Step 2 |
| `pnpm e2e:qr`, `pnpm e2e:actions` script entries | Tasks 2 & 3 Step 2 |
| Runbook prerequisites + Step 1-6 | Task 5 |
| Troubleshooting + fast inspection curl | Task 5 |
| `seed_purple_dot.ts` deprecation note | Task 6 |
| `.env.example` + `.gitignore` | Task 4 |

All spec sections have a task. No placeholder steps remain — every script step has the full source. Type/property names (`source_item.item_id`, `acting_as_user_id`, `requirements_snapshot`, `action_status`, etc.) match Signals' `PerformActionBodySchema` and `UpdateActionStatusBodySchema` verified against `packages/schemas/src/api/action_schemas.ts`.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-e2e-purple-dot-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

Which approach?
