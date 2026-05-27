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
- Signals API responds at `http://localhost:2742` (e.g. an /api/v1/health endpoint or similar)

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

3. Copy `scripts/e2e/.env.example` to `scripts/e2e/.env` and fill in the values:

```
# Docker-only mode (`make up`): use https + /backend prefix.
AGGREGATOR_API_URL=https://localhost/backend
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
   downloaded template's header row and re-edit the fixture's first line to
   match — Aggregator's provider schema is the source of truth for the
   column set.
5. Upload `scripts/e2e/fixtures/purple_dot_providers.csv`
6. Wait for the BullMQ worker to process (status moves `uploaded` →
   `processing` → `completed`)
7. Confirm "5 participants onboarded" in the UI

### Note: TLS self-signed cert (docker-only mode)

When the Aggregator runs via `make up`, nginx terminates TLS with a
self-signed certificate. The e2e scripts auto-disable TLS verification
when `AGGREGATOR_API_URL` or `SIGNALS_API_URL` resolves to `localhost` /
`127.0.0.1`. You'll see a warning on first request:

```
[e2e] WARN: NODE_TLS_REJECT_UNAUTHORIZED=0 for localhost target (self-signed nginx cert).
```

This is intentional and only affects the localhost case. Production URLs
go through their real cert chain.

If you'd rather trust the self-signed cert system-wide, export the cert
from the running nginx container and add it via `NODE_EXTRA_CA_CERTS`:

```bash
docker compose -f ../aggregator-dpg/docker-compose.yml cp \
  nginx:/etc/letsencrypt/live/localhost/fullchain.pem /tmp/aggregator-nginx.pem
export NODE_EXTRA_CA_CERTS=/tmp/aggregator-nginx.pem
```

## Fixture generation (optional)

The pre-shipped fixtures at `scripts/e2e/fixtures/` are good for a default
run (10 seekers + 5 providers). When you want more data, scenario-specific
records, or a fresh deterministic seed, use the fixture generator:

```bash
pnpm tsx scripts/e2e/generate_fixtures.mts \
  --output-format <csv|json> \
  --domain <seeker|provider> \
  --count <integer> \
  [--output <path>]   # defaults to stdout
  [--seed <number>]   # defaults to Date.now(); pin for reproducible output
```

### What the generator produces

All records are schema-valid against
`Signals-DPG/examples/schemas/purple_dot/network.json` — every required
field is populated, enum-typed fields draw from the schema's allowed values
verbatim, and array fields have at least the schema's `minItems`.

**Seekers** (`profile_1.0` beneficiary schema):
- Required: `beneficiary_name`, `mobile_number`, `age`, `gender`, `disability_type[]`, `disability_percentage`, `looking_for[]`, `looking_for_details`, `service_city`, `documents_available[]`
- Optional (each field populated ~30-50% of the time): `email`, `address`, `state`, `district`, `block`, `pincode`, `highest_qualification`

**Providers** (`profile_1.0` service provider schema):
- Required: `contact_name`, `contact_phone`, `contact_email`, `provider_category`, `organisation_name`, `disabilities_served[]`, `services_offered[]`, `service_cities`, `official_address`, `state`, `district`, `block`, `pincode`, `service_details`
- Optional: `catalog_url` (~60% populated)

### Conventions matched

| Concern | Convention |
|---|---|
| CSV array delimiter | `\|` (matches Aggregator's bulk-upload import) |
| CSV cells with `,` / `"` / newline | quoted, with `""` escape |
| Phone numbers | synthetic, prefix `9020000000` for seekers / `9011100000` for providers — never collides with real subscribers |
| Email addresses | `<slug>.<seq>@purpledots.example` — never hits a real inbox |
| Determinism | `--seed <N>` pins a mulberry32 PRNG so re-runs produce byte-identical output |

### Common recipes

```bash
# Replace the default seeker QR fixture with 50 records:
pnpm tsx scripts/e2e/generate_fixtures.mts \
  --output-format json --domain seeker --count 50 --seed 1 \
  --output scripts/e2e/fixtures/purple_dot_qr_payloads.json

# Generate a provider QR fixture (required if you use `--domain provider`
# on the QR submitter and the file doesn't exist yet):
pnpm tsx scripts/e2e/generate_fixtures.mts \
  --output-format json --domain provider --count 25 \
  --output scripts/e2e/fixtures/purple_dot_qr_provider.json

# Generate a fresh provider CSV for bulk upload via the Aggregator UI:
pnpm tsx scripts/e2e/generate_fixtures.mts \
  --output-format csv --domain provider --count 100 --seed 42 \
  --output scripts/e2e/fixtures/providers_bulk_100.csv

# Quick preview of seeker JSON to stdout + pipe to jq:
pnpm tsx scripts/e2e/generate_fixtures.mts \
  --output-format json --domain seeker --count 3 \
  | jq '.[].service_city'
```

### When NOT to regenerate

The pre-shipped `scripts/e2e/fixtures/purple_dot_qr_payloads.json` (10
seekers) and `scripts/e2e/fixtures/purple_dot_providers.csv` (5 providers)
are deliberately small and hand-tuned for the deterministic action-driver
plan (`SEEKER_PLAN` has 10 rows; `PROVIDER_PLAN` has 5). The action driver
applies the plan to the FIRST N items it discovers per domain (10 seekers,
5 providers) — extra items beyond that are left untouched. So if you
regenerate with `--count > 10` for seekers or `> 5` for providers and want
the dashboard's expected counts to still match the runbook, those extra
items will land in `new` status (no plan applied), which throws off the
`{ new: 2, active: 3, at_risk: 3, inactive: 2 }` numbers.

If you want to scale the plan to a larger fixture, edit the `SEEKER_PLAN`
and `PROVIDER_PLAN` arrays in `apps/api/scripts/e2e/seed_actions.mts` to
match the new fixture size and adjust the expected counts in this runbook.

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
# Query Signals' user table directly:
psql -h localhost -p 5432 -U postgres -d signals_dpg -c \
  "SELECT COUNT(*) FROM \"user\" WHERE onboarded_by_org_id = '$SEEKER_ORG_ID';"
# Expect: 10
```

## Step 4 (alternative) — Onboard providers via QR link too

Want providers to come in through a QR link instead of a CSV upload? The
QR submitter accepts `--domain provider`:

```bash
# Generate the provider QR fixture once:
pnpm tsx scripts/e2e/generate_fixtures.mts \
  --output-format json --domain provider --count 25 \
  --output scripts/e2e/fixtures/purple_dot_qr_provider.json

# Submit (after creating an active provider link via the Aggregator UI):
pnpm e2e:qr "$PROVIDER_QR_LINK_SLUG" 10 --domain provider
```

The script reads `PROVIDER_ORG_SLUG` (vs `SEEKER_ORG_SLUG` for the default
seeker domain) and loads `purple_dot_qr_provider.json` (vs
`purple_dot_qr_payloads.json`). Mix both flows freely — they target
different aggregator orgs.

`--fixture <path>` overrides the domain-default fixture if you want to
push a custom or larger generated set:

```bash
pnpm e2e:qr "$SEEKER_QR_LINK_SLUG" 100 \
  --domain seeker \
  --fixture ./scratch/seekers_bulk_100.json
```

## Step 5 — Drive connect actions + backdate timestamps (scripted)

```bash
pnpm e2e:actions
```

The action driver applies TWO domain plans:

- **SEEKER_PLAN** — 10 rows on seekers; each initiates a `connect` (s→p)
  to a configured target provider; bucket spread is create/accept/reject/cancel.
- **PROVIDER_PLAN** — 5 rows on providers; each initiates a `connect` (p→s)
  to a configured target seeker; all `create` bucket (p→s has
  `metric_categories: null` in Purple Dot, so the bucket label is cosmetic).

Both domains get their `items.created_at` backdated FIRST. Then action ages
are clamped at runtime to `min(intended, source_age, target_age, 0)` so no
action predates either item it touches — a clamp log fires whenever the
intended age can't be honoured (which shouldn't happen with the current plan
but guards future plan tweaks).

Expected output:

```
Discovered 10 seekers, 5 providers.
Applying plan to 10/10 seekers and 5/5 providers (extras left untouched).
Expected by_status (seeker):   { new: 2, active: 3, at_risk: 3, inactive: 2 }
Expected by_status (provider): { new: 1, active: 1, at_risk: 2, inactive: 1 }
Expected by_action_status (seeker side, s→p): { create: 4, accept: 3, reject: 1, cancel: 1 }
p→s actions: metric_categories: null in Purple Dot — exercised but not counted.

[seeker 01/10] item.created_at ← NOW() - 2d
[seeker 02/10] item.created_at ← NOW() - 5d
...
[provider 01/05] item.created_at ← NOW() - 3d
[provider 02/05] item.created_at ← NOW() - 20d
...

— s→p actions —
[s→p 01/10] perform → created action=... target=create/new
[s→p 01/10]      action.created_at ← NOW() - 1d
...
[s→p 09/10] (no action; target=inactive)
[s→p 10/10] perform → created action=... target=cancel/inactive
[s→p 10/10]      update → cancelled (direct SQL)
[s→p 10/10]      action.created_at ← NOW() - 100d

— p→s actions (won't affect rollup buckets in Purple Dot) —
[p→s 01/05] perform → created action=...
[p→s 01/05]      action.created_at ← NOW() - 1d
...
[04/10] perform → created action=...  target=accept/active
[04/10]      update → accepted (direct SQL)
[04/10]      item.created_at ← NOW() - 20d
[04/10]      action.created_at ← NOW() - 15d
...
[09/10] (no action; target=inactive)
[09/10]      item.created_at ← NOW() - 100d
[10/10] perform → created action=...  target=cancel/inactive
[10/10]      update → cancelled (direct SQL)
[10/10]      item.created_at ← NOW() - 120d
[p→s 05/05] perform → created action=...
[p→s 05/05]      action.created_at ← NOW() - 110d

Done. After ?refresh=true on the dashboard you should see:
  seeker  by_status        : { new: 2, active: 3, at_risk: 3, inactive: 2 }
  provider by_status       : { new: 1, active: 1, at_risk: 2, inactive: 1 }
  seeker  by_action_status : { create: 4, accept: 3, reject: 1, cancel: 1 }
```

The script uses Plan A on-behalf-of (`acting_as_user_id`) only for `/action/perform`.
For action_status transitions (accept/reject/cancel), Signals' `/action/update-status`
is self-acted only — no on-behalf-of by design (see spec
`2026-05-23-action-on-behalf-of-network-service-tier-design.md`). The
script bypasses the API and updates `item_actions.action_status` directly via PG.
This is test-fixture privilege, same as the `items.created_at` backdating.

## Step 6 — Verify dashboards (manual)

### Seeker aggregator dashboard

Sign in as `seeker-agg@local.dev` and open the Dashboard page. (Trigger a
recompute first via the curl one-liner in the "Fast inspection" section
below — without it, the rollup may still reflect pre-backdate timestamps.)

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

Provider `by_status` is driven by PROVIDER_PLAN's `item_age_days` joint with
the s→p actions each provider receives. The plan deliberately spreads
providers across all four buckets:

| Field | Expected (provider) |
|---|---|
| `by_status.new` | 1 |
| `by_status.active` | 1 |
| `by_status.at_risk` | 2 |
| `by_status.inactive` | 1 |

The seeker and provider rollups are independent dimensions of the same
action stream — the same connect contributes to one bucket on each side.

### Negative-direction check

The 5 provider→seeker connects from Step 5 use the `connect` interaction
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
- Check worker logs (wherever its log output goes).
- Check Signals `/admin/participant` access logs for inbound POSTs from
  Aggregator's `signalstack-writer`.

**Symptom:** `by_action_status` is all zero.

- Confirm `metric_categories` on the seeker→provider `connect` interaction
  in `examples/schemas/purple_dot/network.json` uses canonical keys
  (`create`/`accept`/`reject`/`cancel`). These shipped with the metrics
  refactor PR.
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

**Symptom:** dashboard `by_status` doesn't match the expected distribution.

- The script backdates `items.created_at` and `item_actions.created_at`,
  but the recompute computes status against `last_computed_at` (the
  refresh moment). Make sure you triggered `?refresh=true` AFTER the
  script finished.
- Confirm the `status_rules` in `purple_dot/network.json` use the
  canonical buckets in their predicates.

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
