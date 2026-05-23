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

## Onboarding a participant

Once an aggregator has been mirrored (above), aggregator-dpg / voice-dpg can onboard participants on that aggregator's behalf:

```bash
curl -X POST http://localhost:2742/api/v1/admin/onboard_participant \
  -H 'x-api-key: <aggregator-dpg apikey>' \
  -H 'x-acting-org-id: <BBMP'\''s org_id from the upsert above>' \
  -H 'Content-Type: application/json' \
  -d '{
    "phone_number": "+919876543210",
    "name": "Anita",
    "terms_accepted": true,
    "privacy_accepted": true,
    "channel": "bulk",
    "source_id": "bulk_upload_42",
    "profile": { "whoIAm": { "name": "Anita" } }
  }'
# → 200 with { user_id, profile_item_id, onboarded_at }
```

The route is in `apps/api/src/routes/v1/admin/onboard_participant.ts` (Plan 2 Task 5). What it does:

1. Validates the acting org is `aggregator` or `voice` (not `network_service`).
2. Pre-checks uniqueness on `email` / `phone_number`. 409 USER_ALREADY_EXISTS if a row exists.
3. In one DB transaction:
   - `auth.api.signUpEmail` creates user + account (placeholder password — the actual credential is set later, typically via OTP).
   - UPDATE the new row with phone, DOB, terms/privacy consent, and the **4 attribution columns** (`onboarded_by_org_id`, `onboarded_via`, `onboarded_source_id`, `onboarded_at`) added in Plan 2 Task 1.
   - INSERT the profile_1.0 item via the canonical item-create service (`create_profile_item` from `apps/api/src/lib/profile_item.ts`).
4. Returns `{ user_id, profile_item_id, onboarded_at }`.

### Targeting a different network / domain / item_type

By default the endpoint writes the profile as `blue_dot` / `seeker` / `profile_1.0`. Override per call when this Signals instance serves a different schema (e.g. an instance serving `onest_yellow_dot` / `student`):

```bash
curl -X POST http://localhost:2742/api/v1/admin/onboard_participant \
  -H 'x-api-key: <key>' \
  -H 'x-acting-org-id: <org_id>' \
  -H 'Content-Type: application/json' \
  -d '{
    "phone_number": "+919876543210",
    "name": "Anita",
    "terms_accepted": true,
    "privacy_accepted": true,
    "channel": "bulk",
    "network": "onest_yellow_dot",
    "domain": "student",
    "item_type": "profile_1.0",
    "profile": {
      "Full Name": "Anita",
      "Phone Number": "9876543210"
    }
  }'
```

Signals validates that the trio matches a served binding for this instance and that the `profile` payload conforms to the resolved item_type schema. A mismatch returns `400 UNSERVED_DOMAIN` (or `UNSERVED_NETWORK` / `UNSERVED_ITEM_TYPE` / `INVALID_ITEM_STATE`) with the offending values in the message.

### Attribution model

Every participant onboarded through this endpoint carries:

| Column | Value |
|---|---|
| `onboarded_by_org_id` | The aggregator/voice org_id from `x-acting-org-id` |
| `onboarded_via` | `'bulk'`, `'link'`, `'voice'`, or `'self'` |
| `onboarded_source_id` | Opaque upstream id (your bulk_upload_id, link_id, voice_session_id, …) |
| `onboarded_at` | Server-side timestamp |

The aggregator dashboard (Plan 3, not yet implemented) queries by `onboarded_by_org_id` to scope to a single aggregator's participants. The source_id is opaque to Signals — keep your own record in aggregator-dpg / voice-dpg if you need to drill back to the originating CSV row / call session.

### Phone-only onboarding

The endpoint accepts either `email` OR `phone_number` (or both). If only `phone_number` is provided, the route synthesises a `<uuid>@no-email.local` placeholder for better-auth's signUp — the user's later OTP login binds the real verification.

## Aggregator dashboard

Per-aggregator participant metrics for the UI's hero counts + paginated list. Backed by a cached `participant_metrics` table that recomputes on-demand when stale.

### Endpoint

```bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard?page=1&limit=50&status=at_risk' \
  -H 'x-api-key: <aggregator-dpg apikey>' \
  -H 'x-acting-org-id: <BBMP org_id>'
```

Response (abridged):

```json
{
  "rollup": {
    "participants_total": 1247,
    "by_status": { "new": 84, "active": 612, "at_risk": 219, "satisfied": 270, "inactive": 62 },
    "applications_pending": 380, "applications_accepted": 421, "applications_rejected": 192
  },
  "participants": [
    {
      "user_id": "usr_…",
      "profile_status": "at_risk",
      "profile_completion_pct": 67,
      "actionable_tags": ["missing_phone_number", "no_recent_activity"],
      "applications_pending": 0, "applications_accepted": 0, "applications_rejected": 3, "applications_total": 3,
      "…": "…"
    }
  ],
  "next_cursor": "2",
  "total_matching": 219,
  "metadata": {
    "last_computed_at": "2026-05-22T07:00:00.000Z",
    "ttl_seconds": 3600,
    "refreshed": false
  }
}
```

### Cache + TTL contract

- Per-aggregator rows live in `participant_metrics`. `last_computed_at` per row is the TTL field.
- Each dashboard / export request reads `MIN(last_computed_at)` for the aggregator. If older than `DASHBOARD_CACHE_TTL_SECONDS` (default 3600), the handler recomputes synchronously under a Postgres advisory lock (`pg_try_advisory_lock(hash(aggregator_id))`).
- Concurrent requests during a recompute don't pile up: the second-and-later requests see `pg_try_advisory_lock` return `false`, serve stale data, and let the in-flight recompute land within seconds.
- `metadata.refreshed: true` means *this* request triggered the recompute; `false` means it served what was already in the cache (whether fresh or stale-during-contention).
- First-ever read for an aggregator (no rows) is treated as stale → triggers compute.

### Filtering + pagination

- `?status=<one of new|active|at_risk|satisfied|inactive>` scopes the list (rollup always shows the full status histogram regardless).
- `?page=1&limit=50` for offset pagination. Default page=1, default limit=50, max 500.
- `total_matching` is the count after filter, useful for "showing N of M" UI badges.

The UI hits the API on every filter change. Use TanStack Query (or your preferred fetcher) and key the cache by `(aggregator_id, page, limit, status)` with `staleTime: 60_000` so users navigating filters back-and-forth don't re-fetch.

### CSV export

```bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard/export?status=at_risk' \
  -H 'x-api-key: <key>' \
  -H 'x-acting-org-id: <org_id>' \
  -o participants.csv
```

Streamed `text/csv` response. Same staleness contract as the dashboard route. The body is generated row-by-row in pages of 5000 so 200k+ participants don't OOM the API process.

CSV format notes:
- `actionable_tags` is pipe-separated (`missing_phone_number|no_recent_activity`) to keep one column per metric.
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

## Acting on behalf of a user (voice only)

Voice DPG instances can file actions on behalf of users they onboarded.
Two endpoints accept an optional `acting_as_user_id` body field:

- `POST /api/v1/action/perform`
- `POST /api/v1/action/update-status`

### Required headers + body

```http
POST /api/v1/action/perform
x-api-key: <voice-dpg apikey>
x-acting-org-id: <voice org id from /admin/aggregator/upsert>

{
  "action_type": "apply",
  "source_item": { ... },
  "target_item": { ... },
  "requirements_snapshot": { ... },
  "acting_as_user_id": "<target user id>"
}
```

### Authorization rules

The target user (`acting_as_user_id`) must satisfy:

- `user.onboarded_by_org_id === <x-acting-org-id>`

The channel value (`user.onboarded_via`) is NOT part of the check — a voice org that onboarded a user via `bulk` earlier can still act for that user via `voice` later.

Only `voice`-type acting orgs may use `acting_as_user_id`. `aggregator` and `network_service` callers receive `403 ACTING_ORG_TYPE_NOT_ALLOWED`. Aggregator on-behalf-of is intentionally deferred.

For `/action/perform`, the source item must also be owned by the effective actor — `403 SOURCE_ITEM_NOT_OWNED_BY_ACTOR` otherwise. For `/action/update-status`, the existing action's target item owner must match the effective actor — `403 TARGET_ITEM_NOT_OWNED_BY_ACTOR` otherwise.

### Error matrix

| Caller shape | `acting_as_user_id` | Outcome |
|---|---|---|
| No `x-acting-org-id` | absent | Self-acted (unchanged). |
| No `x-acting-org-id` | present | `400 CANNOT_OVERRIDE_SELF` |
| Voice acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| Voice acting_org | present, owned by this voice org | `200 / 201` |
| Voice acting_org | present, owned by another org | `403 NOT_AUTHORIZED_FOR_TARGET` |
| Aggregator / network_service acting_org | any | `403 ACTING_ORG_TYPE_NOT_ALLOWED` |

### Audit trail

Successful on-behalf-of writes populate two columns on `item_actions`:

| Column | Value |
|---|---|
| `performed_by_org_id` | the voice org id from `x-acting-org-id` |
| `performed_by_service_user_id` | the apikey owner's user id (Signals service account) |

For self-acted writes, both columns are NULL. There are no indexes on these columns today — query via `WHERE performed_by_org_id = $1` sequentially when needed. Indexes will be added if audit queries become a hot path.

For `/action/update-status`, the audit fields reflect the LATEST actor. If a different voice org updates an action that was previously filed by another voice org, the columns are overwritten and a WARN log is emitted server-side with both the previous and new `performed_by_org_id` for ops visibility.

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
