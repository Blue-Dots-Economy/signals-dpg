# Metrics Redesign — Config-Driven Status Rules, Canonical Buckets, Network-Agnostic Schema

**Status:** spec — awaiting implementation plan
**Author:** generated via brainstorming session, 2026-05-26
**Reference network:** Purple Dot (pilot)
**Supersedes most of:** `2026-05-22-metrics-redesign-item-level-design.md` (Plan B). Plan B's `item_metrics` table, recompute path, and dashboard handler all change shape. The per-(org, domain) scoping and advisory-lock contract from Plan B carry over unchanged.

## Goal

Remove every network-specific name from Signals code and storage. Today's `item_metrics` columns (`applications_shortlisted`, `applications_rejected`, `applications_pending`, `last_applied_at`, `last_shortlisted_at`, `last_rejected_at`, `openings`) and today's `seeker_status.ts` / `provider_status.ts` rules bake Jobs vocabulary and Blue-Dot-specific thresholds into the implementation. This redesign:

1. **Canonicalises action buckets** to a fixed 4-value enum (`create`, `accept`, `reject`, `cancel`). Network-specific status enum values map into these via the existing per-interaction `metric_categories` knob, with renamed keys.
2. **Makes status rules config-driven.** Per-domain `status_rules` arrays in `network.json` express the New / Active / At Risk / Inactive thresholds via a small declarative DSL keyed on `item_age_days`, `days_since_last`, and `count`. The TS-side rule functions go away in favour of a single rule-evaluator.
3. **Normalises the schema.** `item_metrics` becomes 4 fixed `count_<bucket>` columns + 4 fixed `last_<bucket>_at` columns + a `display_name` column. No domain-specific NULL columns. Same row shape regardless of network.
4. **Resolves display names from item state, not from `user.name`.** Network.json declares `display_name_field` per item_schema; recompute stores the resolved value. Privacy enforced at config-validation time.
5. **Exposes a force-recompute knob.** New `?refresh=true` query param on dashboard + export bypasses the TTL gate.
6. **Renames the response array `participants` → `items`** to match the unit of measurement.

After this change, the network-specific surface in `apps/api/src/services/metrics/*` and in the dashboard/export routes is exactly: 4 canonical bucket names, 4 status names, 7 fixed rollup tile names, the DSL grammar. Everything else lives in `network.json`.

## Why now

Plan B landed with the right item-level granularity but kept several Jobs-specific names baked in. PR #22 (`52b2a76`, merged 2026-05-26) made the action_type + interaction direction discoverable from `network.json` via `discover_metric_categories()`, but kept the old `pending` / `shortlisted` / `rejected` canonical bucket vocab, the per-domain TS status functions, the `applications_*` column names, the seeker-only/provider-only NULL columns, the `openings` field, and the `user.name` join. This spec completes that refactor. Pilot is moving to Purple Dot (PWD network) where:

- The single `action_type` is `connect`, not `apply`.
- Both `seeker→provider` and `provider→seeker` directions are semantically symmetric (either party initiates; the receiver decides).
- The enum is `[created, accepted, rejected, cancelled]` — naturally lines up with the new canonical bucket set.
- The provider has no `openings` / `positions` field; Blue Dot's `satisfied` status concept does not apply.

Plan B's `applications_*` columns, `last_applied_at`, and the seeker-vs-provider rule split don't fit Purple Dot cleanly. Fixing this with shims would compound the leakage; the cleaner move is to canonicalise now, while pilot has no production data and Plan B's schema can still be replaced via `DROP TABLE ... CASCADE`.

## Dependencies

- Plan A (action perform on-behalf-of) and Plan C (admin/participant upsert) — already merged on `feat/api-refactor`. Plan B is currently on the same feature branch.
- This spec assumes Plan B's per-(org, domain) advisory lock, staleness TTL, and dashboard route wiring stay. Only the column shape, rule evaluator, and response body change.

---

## Canonical model (FIXED in code)

| Concept | Values | Where |
|---|---|---|
| Action buckets | `create`, `accept`, `reject`, `cancel` | `CANONICAL_BUCKETS` const in `apps/api/src/services/metrics/buckets.ts` |
| Profile statuses | `new`, `active`, `at_risk`, `inactive` | `CANONICAL_STATUSES` const in same file |
| Rollup tiles (fixed names) | `total_items`, `complete_profiles`, `has_applications`, `by_status.*` (4 status buckets) | dashboard handler hardcodes the 7 tile keys |
| Generic derived metrics (also fixed names, network-agnostic) | `by_action_status.*` (4 buckets), `avg_items_per_user`, `avg_actions_per_user`, `mode_wise_counts` | dashboard handler |

No network-specific word (e.g. `applications`, `shortlisted`, `openings`, `apply`, `connect`) appears in `apps/api/src/services/metrics/*`, in `apps/api/db/postgres/schema/metrics.ts`, in `apps/api/src/routes/v1/aggregator/*.ts`, or in `@dpg/schemas` types backing those routes. CI grep guard recommended (out of scope — manual review is sufficient for pilot).

---

## `network.json` additions

Three changes per network file.

### 1. `metric_categories` keys renamed to canonical bucket vocab

Today (Plan B, Blue Dot):
```jsonc
"metric_categories": {
  "shortlisted": ["shortlisted"],
  "rejected":    ["rejected"],
  "pending":     ["created", "submitted"]
}
```

New (Purple Dot example, on the seeker→provider `connect` interaction):
```jsonc
"metric_categories": {
  "create": ["created"],
  "accept": ["accepted"],
  "reject": ["rejected"],
  "cancel": ["cancelled"]
}
```

- Any of the 4 keys may be omitted; treated as empty array.
- `metric_categories: null` on an interaction still means "don't count this direction at all" (used today on Blue Dot's `provider→seeker` invite and Purple Dot's `provider→seeker` connect).
- Keys outside `{create, accept, reject, cancel}` are a validation error at network load time.

### 2. New per-domain `status_rules` array

Each entry in the network's `domains[]` gains a `status_rules` array — required, non-empty, must end in a `default` rule.

Purple Dot seeker example (identical for provider in this network):

```jsonc
"domains": [
  {
    "id": "seeker",
    "description": "...",
    "item_schemas": { ... },
    "status_rules": [
      { "status": "new",      "when": { "item_age_days": { "lte": 7 } } },
      { "status": "active",
        "when": { "days_since_last": { "buckets": ["create", "accept"], "lte": 30 } } },
      { "status": "at_risk",
        "when": { "days_since_last": { "buckets": ["create", "accept", "reject"], "between": [31, 90] } } },
      { "status": "inactive", "when": "default" }
    ]
  }
]
```

#### DSL grammar

Locked surface. Anything outside this is a network-load validation error.

| Predicate | Shape | Meaning |
|---|---|---|
| `item_age_days` | `{ lt / lte / gt / gte / eq: number }` or `{ between: [a, b] }` | Days between `profile_created_at` and recompute `now`. |
| `days_since_last` | `{ buckets: string[], lt / lte / gt / gte / eq: number }` or `{ buckets: [...], between: [a, b] }` | Days since the most recent action whose canonical bucket is in `buckets`. If no such action exists, the predicate is **false** (does not match). |
| `count` | `{ buckets: string[], lt / lte / gt / gte / eq: number }` or `{ buckets: [...], between: [a, b] }` | Sum of `count_<bucket>` across the listed buckets. |

Combinators:
- A `when` object's top-level keys are AND-ed together.
- `{ "all": [ {...}, {...} ] }` is explicit AND for clarity.
- `{ "any": [ {...}, {...} ] }` is OR.
- `"when": "default"` (string, not object) is the wildcard tail. **Required** as the last entry in every `status_rules` array.

`between: [a, b]` is **inclusive on both ends**.

#### Rule evaluation semantics

- First-match-wins from top to bottom.
- The `default` tail guarantees every row gets a non-null `profile_status`.
- A `status` value outside `CANONICAL_STATUSES` is a validation error at network load time.
- Bucket names referenced in `days_since_last` or `count` predicates must be in `CANONICAL_BUCKETS`; else validation error.

#### Validation at boot

`packages/config/src/network-config.ts` (or wherever the network cache loads) gains:
- Each domain must have a non-empty `status_rules` ending in `default`.
- Each rule's `status` must be in `CANONICAL_STATUSES`.
- Each `metric_categories` block uses only `CANONICAL_BUCKETS` keys.
- `display_name_field` (next section) validity.

Failure → API refuses to start with a clear `NETWORK_CONFIG_INVALID` error pointing at the offending file + path.

### 3. `display_name_field` per item_schema

Each item_schema may declare a `display_name_field` pointing at a string property within its own JSON schema. That property MUST NOT be `private: true`.

```jsonc
"item_schemas": {
  "profile_1.0": {
    "display_name_field": "organisation_name",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "PWD Service Provider Profile 1.0",
    "type": "object",
    "properties": { /* organisation_name: { type: 'string', ... } */ }
  }
}
```

Resolution at recompute time:
1. If `display_name_field` is declared and the value at `item_state[display_name_field]` is a non-empty string → use that.
2. Else → fall back to `item_id` (stringified).

Validation at boot:
- If declared, must reference an existing string property.
- That property MUST NOT have `"private": true`. Else load error.

Purple Dot pilot config:
- `purple_dot/seeker/profile_1.0`: omit `display_name_field` (every personally-identifying property is private). Items get `name = item_id`.
- `purple_dot/provider/profile_1.0`: `display_name_field: "organisation_name"`.

Blue Dot config (kept consistent even though out of pilot):
- `blue_dot/seeker/profile_1.0`: `display_name_field: "name"`.
- `blue_dot/provider/job_posting_1.0`: `display_name_field: "jobProviderName"`.

---

## `item_metrics` schema changes

### Columns dropped

```
applications_total, applications_pending, applications_shortlisted, applications_rejected,
last_applied_at, last_shortlisted_at, last_rejected_at, openings
```

### Columns added

```ts
displayName:  text('display_name').notNull(),  // resolved from schema OR item_id fallback

countCreate:  integer('count_create').default(0).notNull(),
countAccept:  integer('count_accept').default(0).notNull(),
countReject:  integer('count_reject').default(0).notNull(),
countCancel:  integer('count_cancel').default(0).notNull(),

lastCreateAt: timestamp('last_create_at'),
lastAcceptAt: timestamp('last_accept_at'),
lastRejectAt: timestamp('last_reject_at'),
lastCancelAt: timestamp('last_cancel_at'),
```

### Columns unchanged

`itemId` (still PK), `itemNetwork`, `itemDomain`, `itemType`, `ownerUserId`, `onboardedByOrgId`, `onboardedVia`, `profileStatus`, `profileCompletionPct`, `profileCreatedAt`, `profileLastUpdatedAt`, `ageDays`, `actionableTags`, `lastComputedAt`.

### Indexes

Keep the three Plan B indexes (no new ones needed):
- `(onboarded_by_org_id, item_domain, profile_status)`
- `(onboarded_by_org_id, item_domain, last_computed_at)`
- `(owner_user_id, item_domain)`

### Migration

```sql
DROP TABLE item_metrics CASCADE;
CREATE TABLE item_metrics ( /* new shape */ );
```

Single Drizzle migration generated via `pnpm db:generate:api`. No data migration, no backfill — pilot has no prod data. Schema bundle regenerated via `pnpm schema:bundle`.

---

## Recompute logic

`recompute_aggregator_metrics(aggregator_id, domain)` keeps its per-(org, domain) scope and advisory-lock contract from Plan B. Only the per-item compute body changes.

For each item where `items.created_by ∈ org's users`, `items.item_domain = $domain`, `items.item_network ∈ served`:

### a. Display name

```
Read item_schema's `display_name_field` from network cache.
If declared AND item_state[field] is a non-empty string → display_name = that value.
Else → display_name = item_id (stringified).
```

Stored as `item_metrics.display_name` (NOT NULL).

### b. Profile completion percentage

Unchanged — schema-driven, already config-driven. Required-weight 1.0, optional 0.5, capped at 100.

### c. Bucket counts and last-at timestamps (both directions)

Walk the network's `actions[]` and their `interactions[]`. For every interaction with non-null `metric_categories`, aggregate from `item_actions` treating the item symmetrically as either source or target:

```sql
SELECT
  COUNT(*) FILTER (WHERE action_status = ANY($create_statuses))  AS c_create,
  COUNT(*) FILTER (WHERE action_status = ANY($accept_statuses))  AS c_accept,
  COUNT(*) FILTER (WHERE action_status = ANY($reject_statuses))  AS c_reject,
  COUNT(*) FILTER (WHERE action_status = ANY($cancel_statuses))  AS c_cancel,
  MAX(created_at) FILTER (WHERE action_status = ANY($create_statuses)) AS last_create_at,
  MAX(created_at) FILTER (WHERE action_status = ANY($accept_statuses)) AS last_accept_at,
  MAX(created_at) FILTER (WHERE action_status = ANY($reject_statuses)) AS last_reject_at,
  MAX(created_at) FILTER (WHERE action_status = ANY($cancel_statuses)) AS last_cancel_at
FROM item_actions
WHERE (
    (source_item_id = $this_item_id AND source_item_domain = $this_domain)
    OR
    (target_item_id = $this_item_id AND target_item_domain = $this_domain)
  )
  AND action_type IN ($action_types_with_non_null_metric_categories)
  AND (
    -- restrict to (action_type, from_domain, to_domain) tuples whose
    -- interaction has non-null metric_categories; build an IN list
    -- or composite predicate at query-build time
    ...
  )
;
```

If a network declares multiple action_types, all are unioned into the same query — the WHERE shape stays the same.

Each interaction's `metric_categories` map drives which of its raw `event_schema.status` enum values fall in which canonical bucket. The same canonical bucket can pull from multiple raw statuses (`create: ["created", "submitted"]`).

### d. Status

```
input := {
  item_age_days: days_between(profile_created_at, now),
  count: { create, accept, reject, cancel },
  days_since_last: {
    create: days_between(last_create_at, now) if last_create_at else null,
    accept: ..., reject: ..., cancel: ...,
  }
}

For each rule in domain.status_rules (in order):
  if rule.when === 'default' → return rule.status
  if evaluate(rule.when, input) === true → return rule.status

(unreachable — default tail guarantees a match)
```

`evaluate()` is a pure function in `apps/api/src/services/metrics/evaluate_status_rules.ts` (~80 lines + tests). Recursively handles `all` / `any` combinators and the three leaf predicates.

### e. Actionable tags

Only schema-derived `missing_<required_field>` tags. All hardcoded business tags (`all_applications_rejected`, `no_recent_activity`, `no_applications_yet`, `decisions_overdue`) **removed**. If a future need arises, add via a `tag_rules` array following the same DSL shape — out of scope for this spec.

### f. Upsert

```sql
INSERT INTO item_metrics ( ... 18 columns including display_name and 4+4 canonical ... )
VALUES ( ... )
ON CONFLICT (item_id) DO UPDATE SET ...;
```

Batch flush at 1000 rows (unchanged from Plan B).

### Files

**Deleted:**
- `apps/api/src/services/metrics/seeker_status.ts` + tests
- `apps/api/src/services/metrics/provider_status.ts` + tests

**New:**
- `apps/api/src/services/metrics/buckets.ts` — `CANONICAL_BUCKETS` + `CANONICAL_STATUSES` consts, narrow Zod enums.
- `apps/api/src/services/metrics/evaluate_status_rules.ts` — DSL interpreter.
- `apps/api/src/services/metrics/resolve_display_name.ts` — display-name resolution against schema + item state.

**Heavily edited:**
- `metric_categories.ts` — bucket vocab renamed to canonical.
- `actionable_tags.ts` — drop the per-domain business-tag block.
- `recompute.ts` — single unified path; both interaction directions per item; display-name resolution; rule-driven status.
- `packages/config/src/network-config.ts` (or equivalent) — boot validation for `status_rules`, `metric_categories` keys, and `display_name_field`.

---

## Dashboard endpoint

`GET /api/v1/aggregator/dashboard?page=N&limit=L&domain=<>&status=<>&q=<>&refresh=<bool>`

### Query parameters

- `page` / `limit` — pagination over the items list.
- `domain` — optional. Absent → all `org.metadata.domains` in scope.
- `status` — optional. Filters the `items[]` to rows matching `profile_status`. Rollup counts always reflect the full domain population (not the filter).
- `q` — accepted but ignored in pilot.
- `refresh` (new) — boolean. When true, bypass the TTL gate and force a recompute. Per-(org, domain) advisory lock is acquired with the **blocking** variant (`pg_advisory_lock`, not `pg_try_advisory_lock`) so a concurrent in-flight recompute is awaited rather than skipped. `metadata.refreshed` reflects whether a recompute actually ran in this request.

### Response shape

```jsonc
{
  "by_domain": {
    "seeker": {
      "rollup": {
        // 7 fixed tiles
        "total_items":         1247,
        "complete_profiles":    540,
        "has_applications":     894,
        "by_status": { "new": 84, "active": 612, "at_risk": 219, "inactive": 332 },

        // generic derived (network-agnostic)
        "by_action_status":  { "create": 1100, "accept": 421, "reject": 192, "cancel": 18 },
        "avg_items_per_user":     1.06,
        "avg_actions_per_user":   1.11,
        "mode_wise_counts": { "bulk": 800, "link": 320, "voice": 60, "self": 0 }
      },

      "items": [
        {
          "item_network": "purple_dot",
          "item_domain":  "seeker",
          "item_type":    "profile_1.0",
          "name":         "01HX...",        // item_id fallback when no display_name_field
          "onboarded_via": "bulk",

          "profile_status": "at_risk",
          "profile_completion_pct": 67,
          "profile_created_at": "2026-04-11T...",
          "profile_last_updated_at": "2026-05-22T...",
          "age_days": 45,

          "count_create": 4,
          "count_accept": 0,
          "count_reject": 3,
          "count_cancel": 1,

          "last_create_at": "2026-05-20T...",
          "last_accept_at": null,
          "last_reject_at": "2026-05-18T...",
          "last_cancel_at": "2026-05-19T...",

          "actionable_tags": ["missing_email"]
        }
      ],

      "total_matching": 219,
      "next_cursor": "2"
    },
    "provider": { /* same shape; name resolves to organisation_name */ }
  },

  "metadata": {
    "last_computed_at": "2026-05-26T07:00:00.000Z",   // earliest across scoped domains
    "ttl_seconds": 3600,
    "refreshed": false
  }
}
```

### Field semantics

- **`total_items`**: COUNT(*) of `item_metrics` rows in scope.
- **`complete_profiles`**: COUNT(*) WHERE `profile_completion_pct >= 100`.
- **`has_applications`**: COUNT(*) WHERE `count_create + count_accept + count_reject + count_cancel > 0`.
- **`by_status.*`**: histogram of `profile_status`. Always emits the 4 canonical keys (missing keys default to 0).
- **`by_action_status.*`**: SUM of each canonical bucket count across all rows in scope.
- **`avg_items_per_user`**: `total_items / COUNT(DISTINCT owner_user_id)`. `0` if no rows.
- **`avg_actions_per_user`**: `SUM(total_actions) / COUNT(DISTINCT owner_user_id WHERE total_actions > 0)`. `0` if no engaged users.
- **`mode_wise_counts`**: histogram of `onboarded_via`. Includes only non-null entries.
- **`name`** on a row: always non-null. Either the resolved schema field value or the `item_id` string.

### Row shape — 19 fields, identical across domains

No `item_id`, `owner_user_id`, or `onboarded_by_org_id` columns. Acting org context is implicit from the calling header.

### Errors

- `403 NOT_AGGREGATOR` — caller's acting_org is not `aggregator` type.
- `400 NO_DOMAINS_CONFIGURED` — `org.metadata.domains` is empty.
- `400 DOMAIN_NOT_CONFIGURED` — `?domain=` value not in `org.metadata.domains`.
- `400 INVALID_REFRESH` — `?refresh=` parsed to neither boolean.

Same shapes as Plan B's handler.

### Pagination across multi-domain orgs

Per-domain cursors. Each domain's `next_cursor` encodes its own page number. UI passes the same value for all domains on subsequent requests (or filters with `?domain=` to advance one). Domains with no items at this page still appear with `items: []` and `next_cursor: null`.

---

## CSV export

`GET /api/v1/aggregator/dashboard/export?domain=<>&status=<>&refresh=<bool>`

Same 19 columns as the API row, identical order:

```
item_network, item_domain, item_type, name, onboarded_via,
profile_status, profile_completion_pct,
profile_created_at, profile_last_updated_at, age_days,
count_create, count_accept, count_reject, count_cancel,
last_create_at, last_accept_at, last_reject_at, last_cancel_at,
actionable_tags
```

- Filename: `items_<orgid>_<date>.csv` (was `participants_*`).
- `actionable_tags` pipe-joined.
- Timestamps ISO 8601.
- Nullable fields emit empty cells.
- `?refresh=true` honored identically to the dashboard endpoint.
- Streaming via async generator + PG cursor (unchanged from Plan B).
- LEFT JOIN to `user` table goes away (no more `name` from `user.name`).

---

## TTL / staleness / advisory lock

Unchanged from Plan B:

- `MIN(last_computed_at) WHERE onboarded_by_org_id = $org AND item_domain = $domain` is the staleness check.
- Advisory lock key: `hash(aggregator_id || ':' || domain)`. Different `(org, domain)` pairs don't compete.
- Default TTL: `DASHBOARD_CACHE_TTL_SECONDS = 3600`.

New for this spec:
- `?refresh=true` skips the TTL check entirely and uses **blocking** `pg_advisory_lock` instead of `pg_try_advisory_lock`. A concurrent in-flight recompute is awaited.

---

## Implementation plan files (separate doc)

Plan will follow `superpowers:writing-plans` and break into approximately the tasks below. Each is a self-contained subagent unit.

1. Drop `item_metrics`, recreate with new columns (`display_name` + 4 canonical counts + 4 canonical last-ats). Update Drizzle schema + indexes. Regenerate schema bundle.
2. Add `display_name_field` to all current `network.json` files. Update `metric_categories` to use canonical bucket keys. Add `status_rules` to every domain.
3. New `buckets.ts` (CANONICAL_BUCKETS, CANONICAL_STATUSES enums + Zod schemas).
4. Network-config validation: status_rules shape, metric_categories key set, display_name_field existence + non-private. Boot fails on invalid config.
5. New `evaluate_status_rules.ts` — pure DSL interpreter + tests covering each predicate, combinators, default tail, no-match-default.
6. New `resolve_display_name.ts` — schema-field-lookup + item_id fallback + tests.
7. Refactor `metric_categories.ts` and `actionable_tags.ts`.
8. Rewrite `recompute.ts` — bidirectional action aggregation, display-name resolution, rule-driven status, per-item profile completion (existing helper). Tests cover seeker/provider symmetry, multiple action_types, both directions, the default-tail catch.
9. Update `staleness.ts` to support a `force` argument that switches between `pg_try_advisory_lock` and `pg_advisory_lock`.
10. Rewrite `dashboard.ts` for the new response shape (`items` array, `?refresh=`, new rollup keys). Update `DashboardResponse` Zod in `@dpg/schemas`.
11. Rewrite `export.ts` for the new column list and `?refresh=`. Rename filename pattern.
12. Update `dashboard_multidomain.test.ts`, `dashboard.test.ts`, `dashboard.integration.test.ts`, `export.test.ts` to assert new shapes.
13. Postman collection update.
14. `docs/operations/integrating-dpgs.md` update — new response shape, the `status_rules` config contract, `display_name_field` requirement, canonical bucket vocab.

Estimated 4-6 days of subagent execution, depending on review cycles.

---

## Out of scope / deferred

- **Aggregator-org-level rule overrides.** Rules are per-domain in `network.json`. Operators who want different thresholds edit the network file. Defer org overrides until an operator asks.
- **`item_state` field references in the DSL.** No `openings`-style predicates. Blue Dot's old `satisfied` status is gone. If the case returns, add an `item_field` predicate then.
- **Bucket vocab extensions.** 4 canonical buckets are locked. Adding a 5th = code change + migration.
- **Tag rules (`tag_rules`) in `network.json`.** Schema-derived `missing_<field>` tags remain. Hardcoded business tags are deleted. If product needs richer business tags, add a `tag_rules` array next to `status_rules` using the same DSL.
- **Real-time cache invalidation on `/action/perform`.** TTL + `?refresh=true` only.
- **Time-series / historical metrics.** `item_metrics` stays a snapshot.
- **Search (`q` parameter).** Accepted by schema, ignored by route. Needs tsvector + GIN.
- **Async + blob CSV export.** Synchronous streaming.
- **`provider→seeker` invite metrics for any network.** All `provider→seeker` interactions stay at `metric_categories: null`. Future product can populate.

---

## Test plan

### Unit tests

- `evaluate_status_rules.ts` (~15 cases):
  - Each leaf predicate (`item_age_days`, `days_since_last`, `count`) with each operator (`lt/lte/gt/gte/eq/between`).
  - `all` / `any` combinators with mixed-truth children.
  - First-match-wins ordering.
  - `default` tail catches.
  - `days_since_last` predicate fails when no action exists in the listed buckets.
- `resolve_display_name.ts` (~6 cases):
  - Declared field present + non-empty → value.
  - Declared field present but empty/null → item_id fallback.
  - No `display_name_field` declared → item_id fallback.
  - Item_id string-coerced correctly.
- `metric_categories.ts` (~5 cases):
  - Canonical-key validation.
  - Empty-bucket-set mapping.
  - `null` interaction mapping.
- `recompute.ts` (~10 cases):
  - Bidirectional action aggregation (item as source AND target).
  - Multiple interactions per action_type (one with `metric_categories: null` excluded).
  - Status assignment with each of the 4 canonical statuses.
  - Display name resolved from schema vs fallback.
  - Batch flush boundary at 1000.
- Network-config validation (~6 cases):
  - Missing `status_rules` on a domain → error.
  - Missing `default` tail → error.
  - Status outside `CANONICAL_STATUSES` → error.
  - Bucket outside `CANONICAL_BUCKETS` → error.
  - `display_name_field` pointing at private property → error.
  - `display_name_field` pointing at missing property → error.

### Integration test (env-gated)

1. Seed 3 seekers + 2 providers via `POST /admin/participant` (mix of `channel` values).
2. Have 2 seekers initiate `connect` actions to the 2 providers; advance through `created → accepted` and `created → rejected`. Have 1 provider initiate a `connect` to a seeker (provider→seeker direction, `metric_categories: null`) — confirm it does NOT enter any counts.
3. Hit `GET /aggregator/dashboard` — assert rollup counts, `by_action_status`, `mode_wise_counts`, item-level rows, `name` resolution (one provider with `organisation_name`, one seeker with item_id fallback).
4. Force-stale via direct SQL UPDATE → assert `refreshed: true`.
5. Hit `?refresh=true` — assert recompute runs even within TTL.
6. `?domain=seeker` returns only seeker side.
7. `GET /aggregator/dashboard/export` returns CSV with 19 columns; `?refresh=true` honored.

---

## Spec self-review

- **Placeholders**: no TBD / TODO. DSL grammar enumerated. Status rule semantics enumerated. Display-name fallback enumerated.
- **Internal consistency**: schema columns ↔ recompute writes ↔ rollup reads ↔ API row ↔ CSV columns all carry the same 4 canonical bucket names and 4 canonical last-at field names. `name` is non-null at every layer (recompute always writes something; downstream never has to handle null).
- **Scope**: focused on metrics — does not touch action-perform semantics, admin/participant onboarding, or PII reveal flow. Dependencies (Plan A + Plan C already merged) called out.
- **Ambiguity**:
  - `metric_categories: null` semantics ("interaction direction not tracked") explicit.
  - `days_since_last` failure mode when no action exists in the bucket set: predicate evaluates **false**.
  - `between` is **inclusive on both ends**.
  - `default` tail is **required** as last rule; validation enforces this.
  - `display_name_field` fallback to `item_id` when not declared OR when value is null/empty/non-string.
  - `?refresh=true` uses **blocking** advisory lock; caller waits for any in-flight recompute.
- **Aliasing**: the API field `name` is the resolved display name (not `user.name` — that join is removed). `count_<bucket>` and `last_<bucket>_at` are the canonical-bucket projections; the raw `event_schema.status` enum values that map to each bucket come from network.json's `metric_categories`.
