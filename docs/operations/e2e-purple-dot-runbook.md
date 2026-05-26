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

## Step 5 — Drive connect actions + backdate timestamps (scripted)

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
