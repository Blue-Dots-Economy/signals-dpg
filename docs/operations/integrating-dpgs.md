# Integrating DPGs (aggregator-dpg, voice-dpg)

Other DPGs on the network — today `aggregator-dpg` and `voice-dpg` —
authenticate to Signals via a **service apikey** plus a per-request
**acting-org assertion** header. Plan 1 (`chore/plan-1-aggregator-service-auth`)
shipped the auth foundation described here.

The pattern is small on purpose: a single apikey identifies the calling DPG;
a header tells Signals which aggregator that DPG is speaking on behalf of for
this particular request.

## The two-header model

Every call from an integrating DPG into the `/api/v1/admin/*` scope sends two
headers:

| Header | Purpose |
|---|---|
| `x-api-key: <key>` | Identifies the calling DPG (`aggregator-dpg` or `voice-dpg`). The shared `auth_middleware` (`apps/api/plugins/auth/auth_middleware.ts`) resolves the key to its owning user and populates `request.user`. |
| `x-acting-org-id: <org_id>` | Identifies the org the call is acting on behalf of. The `acting_org_preHandler` (`apps/api/src/middleware/acting_org.ts`) validates it and populates `request.acting_org`. |

The mental model: **the apikey says who the messenger is; the header says
who they are speaking for.** A single key serves many aggregators because
the integrating DPG is a trusted intermediary that asserts the right org
per request.

Notes on `auth_middleware`:

- Apikey auth has priority over session auth. If `x-api-key` is present and
  invalid the middleware returns `403 INVALID_API_KEY` immediately — it does
  not fall back to session auth.
- If `x-api-key` is absent the middleware falls back to a session lookup
  (used by the UI). The `/api/v1/admin/*` scope assumes the apikey path —
  the `acting_org` preHandler will return `401 UNAUTHENTICATED` if no
  `request.user` was set by an apikey.
- The middleware is gated by `AUTH_MIDDLEWARE_ENABLED` (defaults to `true`).
  See `docs/operations/secrets.md` for the env knob.

## Organization types

The `organization.type` text column on the better-auth `organization` table
carries one of three values in this model:

- `network_service` — the integrating DPGs themselves
  (`aggregator-dpg`, `voice-dpg`). Their service users are members of these
  orgs. Created by the seed script.
- `aggregator` — every aggregator that has registered with aggregator-dpg,
  mirrored into Signals via `POST /api/v1/admin/aggregator/upsert`.
- `voice` — same shape as `aggregator` but for voice-hosted instances
  (future expansion; the preHandler already accepts the type).

The `acting_org` preHandler accepts all three as valid `x-acting-org-id`
targets. Individual routes can narrow further — e.g.
`POST /api/v1/admin/aggregator/upsert` rejects with
`403 NOT_NETWORK_SERVICE` if the acting org's type is not `network_service`.

## Local dev setup

```bash
docker compose up -d db redis
pnpm db:push:api          # apply better-auth + Drizzle schema to Postgres
pnpm db:init:api          # apply the non-Drizzle SQL bootstrap (items / actions / events)
pnpm db:seed:services:api # create aggregator-dpg + voice-dpg service users and apikeys
```

The seed script (`apps/api/scripts/seed_service_users.ts`) is idempotent —
re-running it does not mint new keys. For each of `aggregator-dpg` and
`voice-dpg` it ensures:

1. An `organization` row with `type='network_service'` and the service slug.
2. A `user` row for the service identity (e.g. `aggregator-dpg-svc@signals.local`).
3. A `member` row linking that user to its network-service org with
   `role='service'`.
4. An `apikey` row (prefix `sk_signals_`) owned by that user.

The minted apikeys print to stdout **on the first run only** — capture them
then. If you lose a key, the recovery path is to delete the corresponding
`apikey` row and re-run the seed.

## Aggregator mirroring

When aggregator-dpg onboards a new aggregator (say, BBMP), it mirrors that
record into Signals so other Signals-aware components can resolve the
aggregator by org id:

```bash
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H 'x-api-key: <aggregator-dpg apikey from the seed>' \
  -H 'x-acting-org-id: <aggregator-dpg network_service org id>' \
  -H 'Content-Type: application/json' \
  -d '{
    "external_id": "agg_bbmp_001",
    "name": "BBMP",
    "slug": "bbmp"
  }'
# -> { "org_id": "org_<uuid>", "created": true }
```

Idempotency: the lookup key is `slug`. A second call with the same `slug`
updates `name`, `logo_url`, and `metadata` on the existing row and returns
`created: false`. `external_id` is opaque to Signals — it is stored inside
`organization.metadata` for cross-system traceability rather than as its
own column.

After this call, BBMP exists in Signals' `organization` table with
`type='aggregator'`. Subsequent admin-scope calls from aggregator-dpg can
assert `x-acting-org-id: <BBMP's org_id>` and routes will know they are
operating on BBMP's behalf.

Request and response shapes live in
`packages/schemas/src/admin/aggregator_upsert.ts`
(`AggregatorUpsertRequest`, `AggregatorUpsertResponse`).

## Upserting a participant (tier-aware)

`POST /api/v1/admin/participant` is the single endpoint integrating DPGs
use to create or update participants. The behavior splits by the
`acting_org.org_type` asserted via `x-acting-org-id`:

| Tier                   | acting_org.org_type | Onboard new user | Read existing user's items                                     | Update item    | Insert additional item |
|------------------------|---------------------|------------------|----------------------------------------------------------------|----------------|------------------------|
| Ecosystem manager      | network_service     | yes              | yes (full list, served-domain scoped)                          | yes (`item_id`)| yes (omit `item_id`)   |
| Aggregator             | aggregator          | yes              | yes — but **only own users** (cross-aggregator returns `items:[]`) | no             | no                     |
| Voice (future)         | voice               | (rejected today) | (rejected)                                                     | (rejected)     | (rejected)             |

The future voice tier will piggyback on the aggregator behavior: when a
voice instance is delegated to an aggregator, voice-dpg simply starts
asserting the aggregator's `x-acting-org-id` — no code change needed.

### Request

```http
POST /api/v1/admin/participant
x-api-key: <network_service or aggregator apikey>
x-acting-org-id: <org id>
content-type: application/json

{
  "email": "user@example.com",
  "name": "Asha P",
  "terms_accepted": true,
  "privacy_accepted": true,
  "channel": "bulk",
  "item_state": { ... item-schema-validated payload ... },
  "item_id": "optional-uuid-for-update-only",
  "network": "blue_dot",
  "domain": "seeker",
  "item_type": "profile_1.0"
}
```

Identity rule: at least one of `email` or `phone_number` must be provided.

### Response

```json
{
  "user_id": "...",
  "user_existed": true,
  "onboarded_at": null,
  "items": [
    {
      "item_id": "...",
      "item_network": "blue_dot",
      "item_domain": "seeker",
      "item_type": "profile_1.0",
      "item_state": { ... },
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

`onboarded_at` is set only when this call created a new user; null
otherwise. `items` is scoped to the networks this Signals instance
serves.

### Error matrix (additions)

| Caller shape | HTTP | error | When |
|---|---|---|---|
| acting_org missing | 403 | `INVALID_ACTING_ORG` | request reached the handler without acting_org |
| acting_org_type == 'voice' (or anything not in aggregator/network_service) | 403 | `ACTING_ORG_TYPE_NOT_ALLOWED` | not allowed today |
| network_service + invalid `item_id` (doesn't belong to user) | 403 | `ITEM_NOT_OWNED_BY_USER` | item ownership check failed |
| email + phone race | 409 | `USER_ALREADY_EXISTS` | another caller created the same identity between SELECT and signUp |

### Migration from `/admin/onboard_participant`

The old endpoint is removed. Callers update:
- URL: `/admin/onboard_participant` → `/admin/participant`
- Body: `profile` → `item_state`
- Body: `profile_item_id` (not previously used) → `item_id` (now meaningful for network_service updates)
- Response: `profile_item_id` → `items: [...]` (full post-write set)

## Aggregator dashboard — multi-domain by_domain shape

`GET /api/v1/aggregator/dashboard` returns a per-domain rollup + paginated
participants. Auth: aggregator-typed acting_org; the `org.metadata.domains`
array must be populated via `/admin/aggregator/upsert` before this endpoint
returns data.

### Setup contract

- The aggregator-dpg caller upserts the aggregator with `domains: ['seeker',
  'provider']` (or the subset relevant to their flow). Persisted under
  `organization.metadata.domains`.
- An empty `domains` array → 400 `NO_DOMAINS_CONFIGURED` on the dashboard.
- `GET /dashboard?domain=seeker` narrows the response to one domain block.
  The `?domain=` value must be in the configured set; else 400
  `DOMAIN_NOT_CONFIGURED`.

### Endpoint

```bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard?page=1&limit=50&status=at_risk' \
  -H 'x-api-key: <aggregator-dpg apikey>' \
  -H 'x-acting-org-id: <BBMP org_id>'
```

### Response shape

```jsonc
{
  "by_domain": {
    "seeker": {
      "rollup": {
        "items_total": 1247,
        "by_status": { "new": 84, "active": 612, "at_risk": 219, "inactive": 270 },
        "applications_total": 993,
        "applications_pending": 380,
        "applications_shortlisted": 421,
        "applications_rejected": 192,
        "unique_users": 1180,
        "complete_profiles_count": 540,
        "avg_profiles_per_user": 1.06,
        "users_with_applications": 894,
        "avg_applications_per_user": 1.11,
        "new_users_last_7_days": 23,
        "mode_wise_counts": { "bulk": 800, "link": 320, "voice": 60, "self": 0 }
      },
      "participants": [ /* per-item rows */ ],
      "total_matching": 219,
      "next_cursor": "2"
    },
    "provider": {
      "rollup": { "items_total": 84, "...": "..." },
      "participants": [ /* per-item rows incl. openings */ ],
      "total_matching": 12,
      "next_cursor": null
    }
  },
  "metadata": {
    "last_computed_at": "...",
    "ttl_seconds": 3600,
    "refreshed": false
  }
}
```

### Per-(aggregator, domain) recompute

Each `(aggregator, domain)` pair has its own staleness TTL and PG advisory
lock. Multi-domain aggregators recompute their domains in parallel; one
slow domain doesn't block the other. The top-level `metadata.last_computed_at`
is the earliest across the in-scope domains.

- Per-(aggregator, domain) rows live in `item_metrics`. `last_computed_at`
  per row is the TTL field.
- Each dashboard / export request reads `MIN(last_computed_at)` for the
  (aggregator, domain) pair. If older than `DASHBOARD_CACHE_TTL_SECONDS`
  (default 3600), the handler recomputes synchronously under a Postgres
  advisory lock keyed on `(aggregator_id, domain)`.
- Concurrent requests during a recompute don't pile up: the second-and-later
  requests see `pg_try_advisory_lock` return `false`, serve stale data, and
  let the in-flight recompute land within seconds.
- `metadata.refreshed: true` means *this* request triggered at least one
  domain's recompute; `false` means every in-scope domain was served from
  cache.
- First-ever read for an (aggregator, domain) pair (no rows) is treated as
  stale → triggers compute.

### Filtering + pagination

- `?domain=<one of the configured domains>` narrows the response to one
  domain block. Omit for all configured domains.
- `?status=<one of new|active|at_risk|inactive>` scopes the list (the
  `by_status` rollup always shows the full status histogram regardless).
- `?page=1&limit=50` for offset pagination. Default page=1, default limit=50,
  max 500. Pagination applies inside each returned domain block.
- `total_matching` (per domain block) is the count after filter, useful for
  "showing N of M" UI badges.

The UI hits the API on every filter change. Use TanStack Query (or your
preferred fetcher) and key the cache by `(aggregator_id, domain, page,
limit, status)` with `staleTime: 60_000` so users navigating filters
back-and-forth don't re-fetch.

### network.json contract: metric_categories

Each network's `apply` action's `seeker→provider` interaction declares
`metric_categories` mapping its event_schema.status enum to canonical
buckets:

```jsonc
"metric_categories": {
  "shortlisted": ["shortlisted"],
  "rejected":    ["rejected"],
  "pending":     ["created", "submitted"]
}
```

`metric_categories: null` (or absent) on an interaction means
"not tracked in the rollup" — recompute returns 0 for those counts.
The pilot leaves provider→seeker invites at null in both blue_dot and
purple_dot; future product may populate them.

### CSV export

```bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard/export?status=at_risk' \
  -H 'x-api-key: <key>' \
  -H 'x-acting-org-id: <org_id>' \
  -o participants.csv
```

Streamed `text/csv` response. Same staleness contract as the dashboard route.
The body is generated row-by-row in pages of 5000 so 200k+ rows don't OOM
the API process.

20-column layout (in order):

```
item_id, item_domain, item_type, owner_user_id, onboarded_by_org_id, onboarded_via,
profile_status, profile_completion_pct, profile_created_at, profile_last_updated_at, age_days,
applications_total, applications_pending, applications_shortlisted, applications_rejected,
last_applied_at, last_shortlisted_at, last_rejected_at, openings, actionable_tags
```

`?domain=` filters the CSV the same way it filters the dashboard. Multi-domain
orgs see rows from every configured domain in the same CSV unless filtered —
the `item_domain` column tells you which domain each row belongs to.

CSV format notes:
- `actionable_tags` is pipe-separated (`missing_phone_number|no_recent_activity`) to keep one column per metric.
- `openings` is populated only for provider-domain rows; seeker rows are blank in that column.
- Standard RFC 4180 escaping: commas, quotes, newlines inside a value wrap the cell in double-quotes; embedded `"` doubles to `""`.
- Filename suggested via `content-disposition: attachment; filename="participants_<org_id>_<YYYY-MM-DD>.csv"`.

### Per-aggregator schema override (advanced)

The recompute reads the JSON Schema for `profile_1.0` to score completion + derive `missing_<field>` tags. By default it uses the first network/domain binding configured in `SERVED_DOMAINS`. Aggregators whose participants live on a different network can override by setting `organization.metadata = '{"network": "...", "domain": "..."}'` (stored as JSON-stringified text). The aggregator-mirror endpoint (`/api/v1/admin/aggregator/upsert`) accepts a `metadata` field for this purpose.

### Plan 3 follow-ups (not in pilot)

- **Async export + blob storage**: switch when sync export crosses ~2 min wall time, ~200k rows, or concurrent-export contention. Today's streaming is fine for current scale.
- **Pre-warming**: fire-and-forget recompute on participant onboard so the next dashboard hit is hot. Currently the optional cache invalidation is the simpler stand-in (delete the aggregator's rows on onboard).
- **`q` parameter (free-text search)**: requires a tsvector + GIN index on profile fields. Param is accepted by the schema but ignored today.
- **Inter-instance aggregation**: querying peer Signals instances. Out of pilot scope.
- **Recompute observability**: Plan 4 H — log/emit duration, processed count, failure rate per recompute.

## What the acting_org preHandler checks

`apps/api/src/middleware/acting_org.ts` runs after `auth_middleware` on
every `/api/v1/admin/*` route. Its checks (in order):

| Failure | HTTP | error code | Cause |
|---|---|---|---|
| `x-acting-org-id` header missing or blank | 400 | `MISSING_ACTING_ORG` | header not sent or empty after trim |
| `request.user` not set | 401 | `UNAUTHENTICATED` | apikey auth did not run (no `x-api-key`) |
| `acting_org_id` does not match any `organization` row | 404 | `ACTING_ORG_NOT_FOUND` | unknown org id |
| Org exists but `organization.type` is null/unknown | 403 | `ACTING_ORG_TYPE_NOT_ALLOWED` | type is not `aggregator`, `voice`, or `network_service` |
| Caller's service user is not a member of any org | 403 | `SERVICE_USER_NOT_REGISTERED` | no `member` row for `request.user.id` |

On success the preHandler attaches:

```ts
request.acting_org = {
  org_id: string,
  org_type: 'aggregator' | 'voice' | 'network_service',
  service_user_id: string,
};
```

and Fastify continues to the route handler. The `FastifyRequest` type
augmentation is declared in `apps/api/types.d.ts`.

## Deferred: per-org allowlist

Today's preHandler accepts **any** `aggregator` / `voice` / `network_service`
org id from **any** service user that is a member of at least one org.
Tightening to "service user X can only assert orgs Y and Z" is intentionally
deferred.

The intended path when this is picked up:

- Encode the allowlist in the better-auth `member.permissions` text column
  (or a sibling table, depending on how granular the policy turns out to
  need to be).
- Add the membership-vs-acting-org check between the org-lookup and
  member-lookup steps in `acting_org.ts`.
- Surface a new error code (e.g. `SERVICE_USER_NOT_AUTHORIZED_FOR_ORG`,
  `403`) for the deny case.

This is safe to defer because:

- Apikeys are only minted by the seed script (operator-controlled).
- `aggregator` and `voice` orgs are only created via the
  `network_service`-gated upsert endpoint.
- The blast radius of a leaked service apikey is "can act for any
  aggregator on this instance", which an operator already needs to assume
  as part of treating the key as a secret.

## Acting on behalf of a user (two tiers)

Two `acting_org.org_type` values may use `acting_as_user_id` on
`POST /api/v1/action/perform`:

- **`aggregator`** — scoped to users that aggregator onboarded
  (`user.onboarded_by_org_id === acting_org.org_id`). For
  counsellor-driven applications, future delegation models, etc.
- **`network_service`** — unrestricted; may act for any user in the
  network. Today's voice-DPG runs at this tier (network-hosted service).

Voice-type acting_orgs are rejected with `403 ACTING_ORG_TYPE_NOT_ALLOWED`
(placeholder; no voice-typed orgs exist in production today).

`POST /api/v1/action/update-status` is **self-acted only** — the caller
must be the target item's owner. There is no `acting_as_user_id` field
on update-status.

### Required headers + body (perform)

```http
POST /api/v1/action/perform
x-api-key: <aggregator-dpg or network_service apikey>
x-acting-org-id: <aggregator or network_service org id>

{
  "action_type": "apply",
  "source_item": { ... },
  "target_item": { ... },
  "requirements_snapshot": { ... },
  "acting_as_user_id": "<target user id>"
}
```

For `/action/perform`, the source item must also be owned by the
effective actor — `403 SOURCE_ITEM_NOT_OWNED_BY_ACTOR` otherwise.

### Authorization matrix (perform)

| Caller shape | `acting_as_user_id` | Outcome |
|---|---|---|
| Session cookie or apikey-as-self | absent | Self-attribution. |
| Session cookie or apikey-as-self | present | `400 CANNOT_OVERRIDE_SELF` |
| `aggregator` apikey + acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| `aggregator` apikey + acting_org | present, user not found | `404 USER_NOT_FOUND` |
| `aggregator` apikey + acting_org | present, own user | `201` |
| `aggregator` apikey + acting_org | present, other-aggregator or self-registered | `403 NOT_AUTHORIZED_FOR_TARGET` |
| `network_service` apikey + acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| `network_service` apikey + acting_org | present, user not found | `404 USER_NOT_FOUND` |
| `network_service` apikey + acting_org | present, user exists | `201` |
| `voice` acting_org | (any) | `403 ACTING_ORG_TYPE_NOT_ALLOWED` |

### Audit columns

`item_actions.performed_by_org_id` + `performed_by_service_user_id` are
populated at create-time only (by `/action/perform`). `/action/update-status`
does not touch them. Inspect the columns to identify the on-behalf-of
caller:

- `network_service` org_id → voice / ecosystem-manager-driven action.
- `aggregator` org_id → counsellor / aggregator-DPG-driven action.
- `NULL` → self-acted (UI session or apikey-as-self).

There are no indexes on these columns today — query via
`WHERE performed_by_org_id = $1` sequentially when needed.

### Migration from update-status acting-as

`/action/update-status` no longer accepts `acting_as_user_id`. Callers
that previously used the on-behalf-of path on update-status must now
either:

- Update status via the target item owner's own session / apikey, OR
- Skip the status update (Plan B's metrics rollup counts statuses
  across rows; the cache catches the next perform without needing a
  formal update-status call).

## Voice DPG follows the same pattern

Voice-dpg uses its own apikey from the seed and asserts `x-acting-org-id`
set to either:

- the aggregator org id when voice is hosted per-aggregator
  (e.g. BBMP runs its own voice instance for itself); or
- a designated network-voice org when voice is network-hosted with no
  aggregator behind it (the org would be created with `type='voice'`).

The Signals-side handler logic does not change — `voice` and `aggregator`
are interchangeable consumers from Signals' point of view. Routes that
need to discriminate (like the aggregator upsert) do so via
`request.acting_org.org_type`.

## Related plans

- [Plan 1 — aggregator service auth](../superpowers/plans/2026-05-21-aggregator-service-auth.md) —
  this plan: auth model, `acting_org` preHandler, seed script, and the
  `/admin/aggregator/upsert` endpoint.
- [Plan 2 — participant onboarding attribution](../superpowers/plans/2026-05-21-participant-onboarding-attribution.md) —
  next up: `POST /api/v1/admin/onboard_participant` for aggregator-dpg /
  voice-dpg to onboard participants, attributed back to the acting org.
- [Plan 3 — participant metrics service](../superpowers/plans/2026-05-21-participant-metrics-service.md) —
  the metrics dashboard each aggregator's UI reads.
- [Plan A — action perform on-behalf-of](../superpowers/plans/2026-05-22-action-perform-on-behalf-of.md) —
  voice DPG files actions on behalf of users it onboarded; adds the
  optional acting_org preHandler, two audit columns on `item_actions`,
  and the `resolve_acting_actor` helper.
