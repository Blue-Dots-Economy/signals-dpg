-- #203 (P-follow-1): expression btree indexes on declared `filterable` facet
-- paths inside `items.item_state`, so server-side map/list filters like
-- `item_state->>'gender' = ANY($1)` (native /markers path, Task 3 of the
-- map-serverside-search plan) can use an index scan instead of a seq scan at
-- 10k-50k items per partition.
--
-- Why expression btree and not a GIN on the whole `item_state` column
-- (`items_state_gin_idx` already exists from 0001_core.sql): a jsonb GIN
-- index (jsonb_ops or jsonb_path_ops) only accelerates the containment (`@>`)
-- and existence (`?`/`?|`/`?&`) operators. It does NOT accelerate the
-- `item_state->>'field' = value` text-extraction-equality pattern the
-- markers/list filters actually use — confirmed empirically (EXPLAIN still
-- shows Seq Scan with a GIN present). Only an expression index on the
-- extracted text value accelerates that pattern, including the `= ANY(...)`
-- form used for multi-select facet filters. So this migration adds one
-- expression btree per declared facet path rather than a blanket GIN.
--
-- Partition-aware by construction, not by extra code: `items` is
-- PARTITION BY LIST (item_network), then further list-partitioned by
-- item_domain at runtime (packages/database/src/utils/partition_by_type.ts).
-- Postgres auto-propagates an index created on a partitioned parent to every
-- existing partition and auto-attaches a matching index to any partition
-- created afterwards (verified against a 2-level nested LIST partition probe
-- mirroring items' exact shape) — so creating these on the `items` root here
-- is sufficient; no per-partition runtime index creation is needed.
--
-- Facets indexed (blue_dot seeker profile_1.0, declared `filterable: true`
-- in examples/schemas/blue_dot/network.json): gender, workExperience,
-- natureOfJobsInterestedIn. Deliberately NOT indexing all of item_state —
-- only fields a network has explicitly marked filterable. Adding a facet on
-- another network/domain later means adding another expression index here
-- (a new migration), which is the accepted tradeoff for this being a
-- narrowly-targeted index rather than a blanket GIN.
CREATE INDEX IF NOT EXISTS items_item_state_gender_idx
  ON items ((item_state ->> 'gender'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_item_state_work_experience_idx
  ON items ((item_state ->> 'workExperience'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_item_state_nature_of_jobs_interested_in_idx
  ON items ((item_state ->> 'natureOfJobsInterestedIn'));
