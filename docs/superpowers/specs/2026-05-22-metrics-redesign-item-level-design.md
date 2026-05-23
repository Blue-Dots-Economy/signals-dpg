# Metrics Redesign — Item-Level, Per-Domain, Network-Aware Statuses

**Status:** spec — awaiting implementation plan
**Author:** generated via brainstorming session, 2026-05-22
**Related:** Plan 3 (the metrics module this redesigns), Plan 2 (attribution columns this depends on), `spec/action-perform-on-behalf-of` (must land first so attribution under voice is correct)

## Goal

Replace Plan 3's user-keyed `participant_metrics` with an item-keyed `item_metrics` table that supports:

1. **Per-domain semantics** — seeker rows compute status from `profile_age + last_applied_age`; provider rows compute from `job_post_age + min(shortlisted_age, rejected_age) + openings`. Same row shape, different rules baked in.
2. **One row per item, not per user** — a user with two profiles produces two rows; a user with both a profile and a job posting produces two rows (one per domain). Items are the unit of measurement.
3. **Multi-domain aggregators** — `organization.metadata.domains: string[]` tells Signals which item domains belong to a given aggregator's dashboard. Pilot orgs have one entry; future orgs may have several.
4. **Network-aware status vocabularies** — each `network.json` declares its own `metric_categories` mapping per action interaction. The recompute reads it; no hardcoded `'accepted'`/`'rejected'` strings in Signals code.
5. **Direction-aware action filtering** — `(source_item_domain, target_item_domain)` distinguishes "seeker→provider apply" from "provider→seeker invite" inside the same `action_type`. Pilot tracks only the seeker→provider direction in the dashboard rollup.

## Why now

Plan 3 was implemented from the Python pipeline's assumptions: one row per user, a fixed action-status vocabulary (`pending|accepted|rejected`), and a single status-rule set that conflated seeker and provider semantics. Product review of the actual dashboard requirements (and re-reading `network.json`) surfaced these mismatches:

- Profile completion is item-level (a user with two profiles has two completion scores, not one weighted average).
- Status rules are different for seeker and provider — the existing `compute_profile_status` rules only model the seeker side, badly approximate the provider side, and don't account for `openings`.
- The action-status enum is network-defined, not Signals-defined. Blue Dot's enum is `[created, submitted, shortlisted, rejected]`; purple_dot may differ.
- Within a single action_type, two interaction directions can exist (seeker→provider vs provider→seeker), each with its own status enum. Plan 3 ignored direction entirely.

Plan 3 just landed in `#11`; this is a fast follow-up that supersedes most of its `apps/api/src/services/metrics/*` module. The Plan 3 schema (`participant_metrics`) gets dropped and recreated as `item_metrics` — pilot has no production deployment yet, so data loss isn't a concern.

## Dependencies

- **`spec/action-perform-on-behalf-of` (Plan A)** must land first. Voice-driven actions under Plan A correctly attribute `source_item_owner` to the seeker (not the voice service user); Plan B's recompute relies on this for accurate per-seeker counts.
- Plan 2 (user attribution columns) is already on `develop`. `user.onboardedByOrgId` and `user.onboardedVia` are read during recompute.

---

## Schema changes

### 1. Replace `participant_metrics` with `item_metrics`

Drop the existing `participant_metrics` table (migration: `DROP TABLE participant_metrics CASCADE`). Create `item_metrics`:

```ts
// apps/api/db/postgres/schema/metrics.ts
export const item_metrics = pgTable('item_metrics', {
  // Identity
  itemId: text('item_id').primaryKey(),
  itemNetwork: text('item_network').notNull(),
  itemDomain: text('item_domain').notNull(),
  itemType: text('item_type').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),

  // Common, computed
  profileStatus: text('profile_status'),                    // 'new' | 'active' | 'at_risk' | 'satisfied' | 'inactive' (never null in practice — see compute rules)
  profileCompletionPct: integer('profile_completion_pct'),
  profileCreatedAt: timestamp('profile_created_at'),
  profileLastUpdatedAt: timestamp('profile_last_updated_at'),
  ageDays: integer('age_days'),

  // Counts (interpreted per domain — see Recompute Logic)
  applicationsTotal: integer('applications_total').default(0),
  applicationsPending: integer('applications_pending').default(0),
  applicationsShortlisted: integer('applications_shortlisted').default(0),
  applicationsRejected: integer('applications_rejected').default(0),

  // Seeker-only (NULL for provider rows)
  lastAppliedAt: timestamp('last_applied_at'),

  // Provider-only (NULL for seeker rows)
  lastShortlistedAt: timestamp('last_shortlisted_at'),
  lastRejectedAt: timestamp('last_rejected_at'),
  openings: integer('openings'),

  actionableTags: text('actionable_tags').array(),

  lastComputedAt: timestamp('last_computed_at').notNull(),
});
```

No FK on `item_id` (because `items` is partitioned and Drizzle's FK story doesn't reach partition keys cleanly). Soft reference via the text column; recompute is the only writer.

FK on `onboarded_by_org_id → organization(id)` with **no cascade** — attribution survives org deletion, same convention as Plan 2's `user.onboardedByOrgId`.

Indexes:
- `(onboarded_by_org_id, item_domain, profile_status)` — the dashboard's hot path (rollup + filter by status within a domain).
- `(onboarded_by_org_id, item_domain, last_computed_at)` — staleness check (`MIN(last_computed_at)` per `(org, domain)`).
- `(owner_user_id, item_domain)` — for the per-user rollup queries (avg_profiles_per_user, users_with_applications, etc.).

### 2. `organization.metadata.domains: string[]`

`POST /api/v1/admin/aggregator/upsert` gains an optional `domains: string[]` field in the request body. Stored under the existing `metadata` text column as JSON-encoded `{ ..., domains: ['seeker', 'provider'], external_id: '...' }`.

`AggregatorUpsertRequest` schema (in `@dpg/schemas`):

```ts
export const AggregatorUpsertRequest = z.object({
  external_id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  logo_url: z.url().optional(),
  domains: z.array(z.string().min(1)).optional()
    .describe("item domains this aggregator's dashboard reports on (e.g. ['seeker'] or ['seeker','provider'])"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
```

The route stores `JSON.stringify({ ...body.metadata, external_id, domains: body.domains ?? [] })`. Backwards-compatible: existing orgs with `domains: undefined` get an empty array; dashboard reads return `400 NO_DOMAINS_CONFIGURED` until they're set via a re-upsert.

### 3. `network.json` gains per-interaction `metric_categories`

Each interaction in a network's action declares which of its `event_schema.properties.status.enum` values map to Signals' canonical buckets:

```jsonc
{
  "actions": {
    "apply": {                                  // blue_dot's single action_type
      "interactions": [
        {
          "from_domain": "seeker",
          "to_domain": "provider",
          "event_schema": {
            "properties": {
              "status": { "enum": ["created", "submitted", "shortlisted", "rejected"] }
            }
          },
          "metric_categories": {
            "shortlisted": ["shortlisted"],
            "rejected":    ["rejected"],
            "pending":     ["created", "submitted"]
          }
        },
        {
          "from_domain": "provider",
          "to_domain": "seeker",
          "event_schema": { /* Interview Invitation enum, separate */ },
          "metric_categories": null
        }
      ]
    }
  }
}
```

`metric_categories: null` (or absent) for an interaction means "not tracked in the rollup yet" — recompute ignores rows on that interaction direction. The provider→seeker direction (invites) is `null` for the pilot in both blue_dot and purple_dot networks; future product can populate it.

`network_schema_cache.ts` already loads `network.json` at boot — no new loading path needed. A small helper resolves: given `(network, action_type, from_domain, to_domain)`, return the matching interaction's `metric_categories` or `null`.

---

## Recompute logic

`recompute_aggregator_metrics(aggregator_id, domain)` — scoped per **(aggregator, domain)** pair, not per aggregator. Each `(org, domain)` has its own staleness TTL and advisory lock. Multi-domain aggregators get separate recompute paths for each of their domains; they don't block each other.

For each item where:
- `items.created_by IN (users with onboarded_by_org_id = aggregator_id)`, AND
- `items.item_domain = $domain`, AND
- `items.item_network IN (networks served by this instance — already filtered by served_domains)`

Compute:

### a. Profile completion (item-level)

Read the item's schema from `network_schema_cache` keyed by `(item_network, item_domain, item_type)`. Score using the existing Plan 3 logic: required-weight 1.0, optional 0.5, capped at 100. No change to the rule itself; just per-item rather than per-user.

### b. Application counts (per-domain semantics)

Resolve the item's network's action interactions. Pick the interaction where:
- For seeker items: `from_domain == 'seeker' AND to_domain == 'provider'`
- For provider items: same (we look at incoming applications from this seeker→provider direction)

Get the `metric_categories` mapping from that interaction. If `null`, all counts are 0 (no metrics for this direction).

Aggregate from `item_actions`:

```sql
-- For seeker items:
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE action_status = ANY($pending_statuses))      AS pending,
  COUNT(*) FILTER (WHERE action_status = ANY($shortlisted_statuses))  AS shortlisted,
  COUNT(*) FILTER (WHERE action_status = ANY($rejected_statuses))     AS rejected,
  MAX(created_at) FILTER (WHERE action_status = ANY($shortlisted_statuses)) AS last_shortlisted_at,
  MAX(created_at) FILTER (WHERE action_status = ANY($rejected_statuses))    AS last_rejected_at,
  MAX(created_at) AS last_applied_at
FROM item_actions
WHERE source_item_id = $this_item_id
  AND source_item_domain = 'seeker'
  AND target_item_domain = 'provider'
  AND action_type = $action_type;
```

For provider items, same shape but `target_item_id = $this_item_id` instead of `source_item_id`. `last_applied_at` makes sense only for seeker items; `last_shortlisted_at` / `last_rejected_at` for either side but the **provider** uses them in status logic.

### c. Status (per-domain rule)

#### Seeker

First-match-wins, in order:

```
if profile_age_days <= 7:
    return 'new'
elif last_applied_age_days is not None and last_applied_age_days <= 30:
    return 'active'
elif profile_age_days > 7 and last_applied_age_days is not None and 31 <= last_applied_age_days <= 90:
    return 'at_risk'
elif profile_age_days > 7 and (last_applied_age_days is None or last_applied_age_days > 90):
    return 'inactive'
else:
    return None
```

`last_applied_age_days = days_between(last_applied_at, now)` or `None` if `last_applied_at is null`.

#### Provider

First-match-wins:

```
job_post_age_days = days_between(profile_created_at, now)
applications = applications_total
decisions = applications_shortlisted + applications_rejected
openings = openings_field        # from item_state.positions
min_decision_age = min_not_null(shortlisted_age, rejected_age)

if job_post_age_days <= 7:
    return 'new'

if applications > 0 and decisions >= openings:
    return 'satisfied'

if applications > 0 and min_decision_age is not None and min_decision_age <= 30:
    return 'active'

# At Risk: two cases
if applications > 0 and min_decision_age is not None and 31 <= min_decision_age <= 90 and decisions < openings:
    return 'at_risk'
if 7 < job_post_age_days <= 30 and applications == 0:
    return 'at_risk'

# Inactive: three cases (any non-matching tail also lands here)
if applications > 0 and min_decision_age is not None and min_decision_age > 90 and decisions < openings:
    return 'inactive'
if 31 <= job_post_age_days <= 90 and applications == 0:
    return 'inactive'
return 'inactive'  # catch-all: e.g. job_post_age > 90 AND applications == 0
```

`openings` comes from `item_state.positions` for `job_posting_1.0` (Blue Dots). For other item_types whose schema doesn't carry an openings concept, treat as `+Infinity` (so `decisions >= openings` is never true and Satisfied is never reached).

#### Both domains: status is computed at recompute time; recomputing the rules at read time is NOT supported in the dashboard (consistent with Plan 3's snapshot model).

### d. Actionable tags

Same as Plan 3: schema-derived `missing_<required_field>` tags + business tags. Business tags are domain-aware:

- Seeker: `all_applications_rejected` (when `applications_rejected == applications_total > 0`), `no_recent_activity` (`last_applied_age_days > 30`).
- Provider: `no_applications_yet` (`applications_total == 0 AND job_post_age > 7`), `decisions_overdue` (`min_decision_age > 30`).

### e. Upsert

```sql
INSERT INTO item_metrics (item_id, item_network, item_domain, item_type, owner_user_id,
                          onboarded_by_org_id, onboarded_via, profile_status,
                          profile_completion_pct, profile_created_at, profile_last_updated_at,
                          age_days, applications_total, applications_pending,
                          applications_shortlisted, applications_rejected,
                          last_applied_at, last_shortlisted_at, last_rejected_at, openings,
                          actionable_tags, last_computed_at)
VALUES (...)
ON CONFLICT (item_id) DO UPDATE SET ...;
```

Batch flush at 1000 rows, same as Plan 3.

---

## Dashboard endpoint

```
GET /api/v1/aggregator/dashboard?page=N&limit=L&domain=<filter>&status=<filter>&q=<filter>
```

**Query semantics**:
- `page` / `limit` — pagination over the participants list.
- `domain` — optional. If absent, response covers all domains in `org.metadata.domains`. If present, response only carries the requested domain.
- `status` — optional filter on `profile_status`.
- `q` — accepted but ignored in pilot (search planned for later).

**Behavior**:
1. Acting-org guard: `request.acting_org?.org_type === 'aggregator'`, else 403.
2. Read `org.metadata.domains`. If empty → 400 `NO_DOMAINS_CONFIGURED`.
3. Validate `?domain=` if present: must be in `org.metadata.domains`, else 400 `DOMAIN_NOT_CONFIGURED`.
4. For each domain in scope: `check_and_refresh_if_stale(aggregator_id, domain)`. Each `(org, domain)` has its own advisory lock — recomputes run in parallel.
5. Build response:

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
      "participants": [
        {
          "item_id": "...",
          "owner_user_id": "...",
          "item_type": "profile_1.0",
          "profile_status": "at_risk",
          "profile_completion_pct": 67,
          "profile_created_at": "...",
          "profile_last_updated_at": "...",
          "age_days": 45,
          "applications_total": 4,
          "applications_pending": 1,
          "applications_shortlisted": 0,
          "applications_rejected": 3,
          "last_applied_at": "...",
          "actionable_tags": ["missing_phone_number", "all_applications_rejected"]
        }
      ],
      "total_matching": 219,
      "next_cursor": "2"
    },
    "provider": {
      "rollup": {
        "items_total": 84,
        "by_status": { "new": 5, "active": 30, "at_risk": 12, "satisfied": 25, "inactive": 12 },
        "applications_total": 993,
        "applications_pending": 380,
        "applications_shortlisted": 421,
        "applications_rejected": 192,

        "unique_users": 30,
        "complete_profiles_count": 60,
        "avg_profiles_per_user": 2.8,
        "users_with_applications": 28,
        "avg_applications_per_user": 33.1,
        "new_users_last_7_days": 2,
        "mode_wise_counts": { "bulk": 0, "link": 10, "voice": 0, "self": 20 }
      },
      "participants": [
        {
          "item_id": "...",
          "owner_user_id": "...",
          "item_type": "job_posting_1.0",
          "profile_status": "active",
          "profile_completion_pct": 100,
          "profile_created_at": "...",
          "profile_last_updated_at": "...",
          "age_days": 15,
          "applications_total": 47,
          "applications_pending": 12,
          "applications_shortlisted": 25,
          "applications_rejected": 10,
          "last_shortlisted_at": "...",
          "last_rejected_at": "...",
          "openings": 30,
          "actionable_tags": []
        }
      ],
      "total_matching": 12,
      "next_cursor": "2"
    }
  },
  "metadata": {
    "last_computed_at": "2026-05-22T07:00:00.000Z",   // earliest across the domains in scope
    "ttl_seconds": 3600,
    "refreshed": false
  }
}
```

Single-domain orgs get a one-key object. UI iterates regardless.

### Pagination across multi-domain orgs

Pagination cursors are per-domain (each domain has its own offset). `next_cursor` strings encode the page number; UI passes the SAME cursor for each domain on subsequent requests. Simpler than a global cursor that interleaves domains.

If the response would carry empty `participants` for a domain (e.g. that domain has 0 items at this page), include the domain key with `participants: []` and `next_cursor: null`.

---

## CSV export

`GET /api/v1/aggregator/dashboard/export?domain=<filter>&status=<filter>`

Single CSV file. Columns include `domain` so multi-domain orgs see both kinds of rows in one file. UI / operators can filter via `?domain=` if they want one side at a time. Streaming via async generator + PG cursor, same as Plan 3.

Column list:

```
item_id, item_domain, item_type, owner_user_id,
onboarded_by_org_id, onboarded_via,
profile_status, profile_completion_pct,
profile_created_at, profile_last_updated_at, age_days,
applications_total, applications_pending, applications_shortlisted, applications_rejected,
last_applied_at, last_shortlisted_at, last_rejected_at, openings,
actionable_tags
```

`actionable_tags` pipe-joined as in Plan 3. Date fields ISO 8601. Nullable fields stay empty.

---

## TTL / staleness / advisory lock

Same contract as Plan 3 — just keyed differently:

- `MIN(last_computed_at) WHERE onboarded_by_org_id = $org AND item_domain = $domain` is the staleness check.
- Advisory lock key: `pg_try_advisory_lock(hash(aggregator_id || ':' || domain))`. Different `(org, domain)` pairs don't compete for the lock; multi-domain orgs see parallel recomputes.
- Default TTL: `DASHBOARD_CACHE_TTL_SECONDS = 3600`.

---

## Implementation plan files (separate doc)

Implementation plan will follow `superpowers:writing-plans` and break into ~12-14 tasks. Rough shape:

1. Drop `participant_metrics`, create `item_metrics` schema + indexes (3 sources kept in sync per Plan 4 A.3 parity).
2. Add `domains: string[]` to `AggregatorUpsertRequest` + persist in `org.metadata`.
3. Add `metric_categories` to `blue_dot/network.json` and `purple_dot/network.json` (seeker→provider direction only; provider→seeker left `null`).
4. Refactor `profile_completion.ts` — per-item input shape (already pure, mostly a signature tweak).
5. Replace `profile_status.ts` with two functions: `compute_seeker_status` + `compute_provider_status`. Pure, exhaustively tested.
6. Refactor `actionable_tags.ts` for per-domain business tags.
7. New `schema_lookup.ts` helper — resolve action interaction's `metric_categories` for `(network, action_type, from_domain, to_domain)`.
8. Rewrite `recompute.ts` — per-(aggregator, domain) scope, item-level rows, network-aware action filtering. Tests cover all four cells of the matrix (seeker happy / provider happy / seeker no-apps / provider no-apps).
9. Update `staleness.ts` — TTL check + lock key now include domain.
10. Rewrite `dashboard.ts` for the new response shape (`by_domain`). New tests for multi-domain orgs.
11. Rewrite `export.ts` for the new columns.
12. Integration test (real PG): seeded apply actions in both domains, status transitions, rollup counts match expected.
13. Postman collection update: dashboard request body shape changed.
14. Docs update in `docs/operations/integrating-dpgs.md` — new response shape, the `metric_categories` contract, multi-domain orgs.

Estimated 3-5 days of subagent execution work, depending on how many spec-vs-code review cycles each task needs.

---

## Out of scope

- **Provider→seeker invite metrics.** `metric_categories: null` for the p→s direction in pilot. Future product can populate it; recompute already handles null gracefully (counts stay 0).
- **Cross-network aggregation.** Each `(aggregator, domain)` is one network's data. An aggregator with domains in two networks would need separate handling (probably store `(network, domain)` pairs in `org.metadata` instead of `domains: string[]`). Defer until real use case.
- **Search (`q` parameter).** Accepted by the schema, ignored by the route. Needs a tsvector + GIN index on profile JSON.
- **Async export + blob storage.** Synchronous streaming; switch when sync export crosses ~2 min / ~200k rows / concurrent contention.
- **Time-series / historical metrics.** Today's `item_metrics` is a snapshot. "How many seekers did we have last week?" requires history; defer.
- **Custom recommended-followup logic.** Product spec mentions "Recommended Followup" column in the participant view. Today's `actionable_tags` array carries the data; UI can format as it sees fit. A dedicated `recommended_followup` text column is a future addition once product nails the copy.
- **Real-time invalidation on action perform.** Cache invalidates on TTL only. A new apply doesn't refresh metrics until the next dashboard hit after TTL. Add fire-and-forget invalidation on `/action/perform` if dashboard freshness becomes a complaint.

---

## Test plan

- **Unit tests (~30 cases)**:
  - `compute_seeker_status` × 6 (new, active, at_risk, inactive, never-applied-old, never-applied-young).
  - `compute_provider_status` × 8 (new, satisfied, active, at_risk×2, inactive×2, catch-all inactive for job_post_age>90 with zero applications).
  - `profile_completion_pct` per item — covered by Plan 3's existing tests.
  - `actionable_tags` per domain — extend Plan 3's tests.
  - `resolve_metric_categories(network, action_type, from_domain, to_domain)` — null-case, happy-case, missing-network.
  - `recompute_aggregator_metrics(aggregator_id, domain)` — empty aggregator, 3 seeker items mixed states, 2 provider items mixed states, batch flush > 1000.
  - `dashboard` handler — multi-domain shape, single-domain shape, 403, `?status=` filter, pagination, `metadata.refreshed=true` on cold cache, `=false` on warm.
  - CSV export — header line, escape, multi-domain row mix.

- **Integration test (env-gated, runs via `pnpm --filter api test:integration`)**:
  1. Seed 5 seekers + 2 providers via `/admin/onboard_participant` (mix of `channel` values).
  2. Have 3 seekers apply to the 2 providers (mixed shortlisted/rejected/pending statuses) via `/action/perform`.
  3. Hit `/dashboard` — assert rollup counts, status histograms, per-row metrics.
  4. Force-stale via direct SQL UPDATE of `last_computed_at` → assert `refreshed: true`.
  5. `?domain=seeker` only returns seeker side; `?domain=provider` only returns provider.
  6. `/dashboard/export` returns text/csv with mixed-domain rows.

---

## Open follow-ups (deferred)

1. **Provider→seeker invite metrics.** Populate `metric_categories` for the p→s interaction in each network.json once product asks. Recompute needs no change.
2. **`recommended_followup` column.** Computed in recompute, displayed by the dashboard UI as a single per-row guidance string.
3. **Historical / time-series tracking.** Daily snapshot of `item_metrics` for trend lines.
4. **Real-time cache invalidation on `/action/perform`.** Fire-and-forget delete of the affected aggregator's rows for `(org, domain)`. Tight feedback loop without rebuilding the cache eagerly.
5. **Search (`q` parameter).** tsvector + GIN index on item_state JSON.
6. **Async + blob CSV export.** Threshold-driven switch from sync streaming.
7. **Multi-network aggregators.** If/when an aggregator spans networks, store `(network, domain)` pairs in `org.metadata`.

---

## Spec self-review

- **Placeholders**: no TBD / TODO. Every per-domain rule is enumerated explicitly. The provider status matrix is the user's exact wording, with any non-matching tail (e.g. `job_post_age > 90 AND applications == 0`) explicitly absorbed into `inactive` so no row can land at `null`.
- **Internal consistency**: schema fields match the rollup / participants / CSV output. The seeker-only fields (`last_applied_at`) and provider-only fields (`last_shortlisted_at`, `last_rejected_at`, `openings`) are documented as NULL on the other side. The dashboard endpoint shape's keys all map to schema columns or derived rollups; nothing left unexplained.
- **Scope**: focused on metrics — does not bleed into the action-perform changes (handled by `spec/action-perform-on-behalf-of`). Dependencies on Plan A are called out at the top.
- **Ambiguity**: `metric_categories: null` semantics ("direction not tracked") is explicit. `openings = +Infinity` fallback for item types without a positions field is explicit. The catch-all `inactive` for any non-matching provider tail (so `profile_status` is never `null` for a provider row) is explicit. Multi-domain aggregator dashboard shape (`by_domain` wrapper always present, single-key for single-domain orgs) is explicit.
- **Aliasing**: `applications_shortlisted` is the bucket name in the schema + response; the network-specific status values that map to it come from `metric_categories.shortlisted`. The same applies to `applications_rejected` and `applications_pending`.
