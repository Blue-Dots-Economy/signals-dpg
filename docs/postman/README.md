# Signals-DPG Postman collection

This folder ships a single Postman v2.1 collection plus two environment files
that exercise the full Signals-DPG API surface against a local instance.

## What's inside

- `Signals-DPG.postman_collection.json` — the collection (six folders covering
  setup, OTP auth, network-service aggregator registration, aggregator
  onboarding via bulk / link / voice, seeker actions, provider accept/reject,
  and the aggregator metrics dashboard + CSV export).
- `Blue-Dots.postman_environment.json` — Blue Dots (jobs) network values.
- `Purple-Dots.postman_environment.json` — Purple Dots (vocational training)
  network values.

Both environments target `http://localhost:2742` (the API's default port).

## Import

1. Open Postman -> **File -> Import**.
2. Drop **all three** files in. Postman recognises the collection vs
   environment shapes and registers them separately.
3. In the top-right environment selector, pick **Blue Dots (local)** or
   **Purple Dots (local)**.
4. Make sure Postman's **cookie jar** is enabled for `{{base_url}}` —
   Settings -> *Cookies* -> add `localhost` (port `2742`). Without this,
   the session cookie set by `Verify OTP` won't be sent on seeker calls.

## Fill the placeholders

Two values in each environment start as `REPLACE_ME`:

| key                       | where to get it                                          |
| ------------------------- | -------------------------------------------------------- |
| `network_service_api_key` | `pnpm db:seed:services:api` output (the network_service apikey) |
| `network_service_org_id`  | same seed output (the network_service org id)            |

`aggregator_api_key` defaults to `{{network_service_api_key}}` (you can use
the same key to act on behalf of any aggregator org for local exploration).
For staging/prod, use the aggregator org's own apikey.

`aggregator_org_id` is left blank intentionally — the **Register Aggregator**
request captures it from the response and writes it into the active
environment via a test script. Subsequent admin calls pick it up automatically.

## Order of operations

1. **00 Setup -> Health** — confirm the API answers and check
   `served_domains` / `network_config_source` match your network.
2. **02 Network Service -> Register Aggregator** — POSTs the upsert and
   writes `aggregator_org_id` into the environment.
3. **03 Aggregator Onboarding -> Onboard via Bulk** (or `Link` / `Voice`) —
   creates the seeker user + `profile_1.0` item, attributed to the
   aggregator. Captures `seeker_user_id` and `seeker_item_id`.
4. **01 Auth -> Request OTP** then **Verify OTP** — logs in as the seeker.
   The session cookie lands in Postman's jar.
5. **04 Seeker -> Self Fetch / Find Providers / Apply to Provider** — runs
   as the seeker session. The Apply request captures `action_id`.
6. **05 Provider -> Accept Action** (or `Reject Action`) — flips
   `action_status`. Must be the provider's session — for a single-org local
   demo you can re-login as a user who owns a provider item.
7. **06 Aggregator Metrics -> Dashboard / Dashboard Export (CSV)** — rolls
   up the aggregator's participants. Plan 3's staleness check refreshes the
   cache on read when it's older than `ttl_seconds`.

## Caveats

- **OTP test mode**: the `test_otp = 000000` shortcut only works when the API
  is started with `CREATE_TEST_OTP=true` in its `.env`. Without that, real
  OTPs are generated and dispatched via SMS / email and you must enter what
  the messaging integration delivered.
- **Cookie jar**: required for seeker/provider session calls (Self Fetch,
  Apply, Accept/Reject). When acting as the seeker, do **not** send
  `x-api-key` — the API's auth middleware short-circuits to `403
  INVALID_API_KEY` for any invalid apikey and never falls back to the session
  path. The seeker requests in this collection deliberately omit `x-api-key`.
- **Two-header service auth**: admin endpoints (`/api/v1/admin/*`,
  `/api/v1/aggregator/*`) require **both** `x-api-key` and
  `x-acting-org-id`. The `acting_org.org_type` gates what's allowed:
    - `network_service` may upsert aggregators.
    - `aggregator` (or `voice`) may onboard participants.
    - `aggregator` may read the dashboard.
- **Geo search**: `/api/v1/network/item/fetch_local` and
  `/api/v1/network/item/fetch` enforce that
  `item_latitude` + `item_longitude` + `radius_meters` are supplied
  **together** (zod refine). Drop all three to disable geo filtering.
- **Sample payloads** in the environments are minimal-required-field
  approximations of each network's `profile_1.0` shape. Compare against
  `examples/schemas/{blue_dot,purple_dot}/network.json` and the schemas the
  instance has fetched into Postgres before submitting richer payloads.
- **`provider_item_id`** is left blank — populate it manually after creating
  a provider item via `POST /api/v1/item/create` (or by running the existing
  `examples/schemas/blue_dot/postman/blue_dot.postman_collection.json` flow
  in parallel).
