# Metrics service

`item_metrics` is a **lazily-recomputed derived cache** of per-item interaction counts and status, read by the aggregator dashboard/export routes. Root `CLAUDE.md` already warns: never key ownership or authorization off this table — it's a cache, not a source of truth (see its "Auth model" section, the `item_metrics` mention). This doc covers the *mechanics* of that cache: when it recomputes, and the one non-obvious invariant (directionality) every file here is built around.

## When it recomputes: `staleness.ts`

`staleness.ts` is the entry point a route actually calls. It checks a TTL (`DASHBOARD_CACHE_TTL_SECONDS`, default `3600` seconds) against the metrics row's last-computed timestamp; on a miss it calls `recompute_aggregator_domain_metrics` (`recompute.ts`) and blocks until it finishes. There is no background job — recompute is triggered synchronously by whichever request first finds the cache stale.

## The one thing to understand before touching anything here: directionality

An action event (e.g. a seeker `connect`-ing to a provider) is directional — it has a `source_item_domain` and a `target_item_domain`. `recompute.ts` counts it from **each item's own point of view**:

- The item is `initiated` when its domain is the action's **source**.
- The item is `received` when its domain is the action's **target**.
- **A self-domain interaction** (source domain == target domain == the domain being recomputed) emits **both** an `initiated` row and a `received` row for the same action, since the same item plays both roles at once.

This is `recompute.ts:59-67`'s header comment verbatim (worth reading in full there) — it's the crux of the whole subsystem and easy to get backwards when adding a new tracked interaction. Per-item **status** (via `evaluate_status_rules.ts`) is evaluated against the **combined** (initiated + received) counts, not either direction alone — that preserves status semantics that predate the directional split.

## How the recompute query is built

`recompute.ts`'s `buildInteractionEvents` generates a `UNION ALL` of one `SELECT` per `(tracked interaction, canonical bucket, direction)` combination against `item_actions`, using the network's configured `metric_categories` mapping (`metric_categories.ts` — maps a network's raw `event_schema.status` values onto the 4 **canonical buckets**, `buckets.ts`). The outer query in `recompute.ts` `GROUP BY`s that union into per-item directional counts and `MAX(created_at)` timestamps (columns named dynamically via `count_col`/`last_col`, e.g. `initiated_create`, `last_received_accept_at`). Rows are processed in batches of `BATCH_SIZE = 1000` (`recompute.ts:13,344`) to bound memory on large domains.

## Supporting files (one-liners)

- `buckets.ts` — the 4 canonical action buckets (Signals-internal vocabulary; a network's own status strings never appear in code, only in `metric_categories.ts`'s mapping).
- `metric_categories.ts` — reads a network's `metric_categories` config and produces the bucket mapping `recompute.ts` consumes.
- `evaluate_status_rules.ts` — turns combined counts + recency into the network-configured per-item status.
- `profile_completion.ts` — completion-percentage scoring from a narrow, local JSON-Schema shape (deliberately not pulling in `@types/json-schema` — see its header comment).
- `actionable_tags.ts` — derives "needs attention" tags from missing required fields (built on `profile_completion.ts`'s `is_populated`).
- `resolve_display_name.ts` — resolves the configured `display_name_field` for dashboard display.
- `schema_lookup.ts` — fetches the domain's item schema via `getNetworkConfigById`/`getDomainItemSchema`, used by the two schema-shape consumers above.

## If you're adding a new tracked interaction or bucket

Get the directionality right first (which domain is source vs target for *this* interaction), then trace through `metric_categories.ts` → `buckets.ts` → `recompute.ts`'s `buildInteractionEvents` in that order — each is a thin transform over the previous one's output.
