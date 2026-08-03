-- Custom SQL migration file, put your code below! --

-- #370/#422: the per-pair action cap counts OPEN actions between two items,
-- bidirectionally and across ALL action types, on every /network/action/perform
-- (services/action_pair_cap.ts `assertPairCapAvailable`). That query is
-- deliberately NOT prunable by `action_type` (the cap is type-agnostic), and
-- `item_actions` previously had no index on source/target item ids — only
-- (source_item_owner, updated_at) / (target_item_owner, updated_at). So the
-- recount was an unindexed scan across every action_type sub-partition, run
-- while holding the pair advisory lock on the write hot path.
--
-- Add btree indexes on the pair columns in BOTH orderings so the count's
-- `(source=A AND target=B) OR (source=B AND target=A)` predicate is index-served
-- from either direction (Postgres BitmapOr). `partition_network` leads each
-- index so the planner still prunes to the network partition first, then uses
-- the index within it.
--
-- Partition-aware by construction: `item_actions` is PARTITION BY LIST
-- (partition_network) then by action_type at runtime
-- (packages/database/src/utils/partition_by_type.ts). Postgres propagates an
-- index created on the partitioned parent to every existing partition and
-- auto-attaches it to future ones, so creating these on the root is sufficient
-- (same reasoning as 0007_facet_item_state_indexes.sql).
CREATE INDEX IF NOT EXISTS item_actions_pair_src_tgt_idx
  ON item_actions (partition_network, source_item_id, target_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_pair_tgt_src_idx
  ON item_actions (partition_network, target_item_id, source_item_id);
