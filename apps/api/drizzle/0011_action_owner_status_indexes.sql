-- Custom SQL migration file, put your code below! --

-- #439: My-Actions per-profile filter/sort needs to page a profile owner's
-- actions filtered by status and sorted by recency, from either side of the
-- relation (the profile can be the source item or the target item of an
-- action). The existing (source_item_owner, updated_at) /
-- (target_item_owner, updated_at) indexes support "all actions for owner,
-- newest first" but can't index-serve an added `action_status = $1`
-- predicate, so that filter would fall back to a scan of every row for the
-- owner. Add owner+status+updated_at composite indexes on both orderings so
-- "owner X, status Y, newest first" is fully index-served.
--
-- `match_score` (nullable real, 0-10) stores a connect-time relevance score
-- from the match_score service, written once at action-create time and read
-- back for display/sort in later My-Actions tasks; it is not part of either
-- index because it is only ever displayed/sorted client-side alongside the
-- already-fetched page, not filtered on.
--
-- Partition-aware by construction: `item_actions` is PARTITION BY LIST
-- (partition_network) then by action_type at runtime
-- (packages/database/src/utils/partition_by_type.ts). Postgres propagates a
-- column/index added on the partitioned parent to every existing partition
-- and auto-attaches it to future ones, so altering/indexing the root here is
-- sufficient (same reasoning as 0007_facet_item_state_indexes.sql and
-- 0010_action_pair_open_indexes.sql).
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS match_score real;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_target_owner_status_idx
  ON item_actions (target_item_owner, action_status, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_source_owner_status_idx
  ON item_actions (source_item_owner, action_status, updated_at);
