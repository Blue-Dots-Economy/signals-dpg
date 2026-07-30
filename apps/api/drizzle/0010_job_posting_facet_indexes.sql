-- #394: expression btree indexes on declared `filterable` facet paths inside
-- `items.item_state`, for the blue_dot *provider* domain (`job_posting_1.0`)
-- — the same convention 0007_facet_item_state_indexes.sql established for
-- the seeker domain (`profile_1.0`). Declaring `filterable: true` on a
-- job_posting field makes it appear in the provider filter panel (map
-- `/markers` + list `/discover` and its native fallback); the server-side
-- filter (`item_state->>'field' = ANY($1)`) needs a matching expression
-- index to get an index scan instead of a seq scan at 10k-50k items per
-- partition — see 0007's header comment for why a whole-column GIN
-- (`items_state_gin_idx` from 0001_core.sql) doesn't cover this access
-- pattern.
--
-- Partition-aware by construction: `items` is PARTITION BY LIST
-- (item_network), then further list-partitioned by item_domain at runtime
-- (packages/database/src/utils/partition_by_type.ts). Postgres auto-
-- propagates an index created on a partitioned parent to every existing
-- partition and auto-attaches a matching index to any partition created
-- afterwards, so creating these on the `items` root here is sufficient.
--
-- Facets indexed (blue_dot provider job_posting_1.0, declared
-- `filterable: true` in examples/schemas/blue_dot/network.json):
-- natureOfJob, candidateExperienceType, workExperienceYears.
CREATE INDEX IF NOT EXISTS items_item_state_nature_of_job_idx
  ON items ((item_state ->> 'natureOfJob'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_item_state_candidate_experience_type_idx
  ON items ((item_state ->> 'candidateExperienceType'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_item_state_work_experience_years_idx
  ON items ((item_state ->> 'workExperienceYears'));
