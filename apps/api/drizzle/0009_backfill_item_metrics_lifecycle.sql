-- Custom SQL migration file, put your code below! --

-- Backfill item_metrics.lifecycle_status from the source-of-truth items table.
-- 0008 added the column with DEFAULT 'draft'; without this, every existing
-- rollup row would read 'draft' and drop out of the dashboard's default
-- (live,paused) filter until its next TTL-driven recompute. This one-off UPDATE
-- seeds the true lifecycle so no profile disappears in the gap. Ongoing
-- freshness is handled by recompute (mirrors items.lifecycle_status on read).
-- items.item_id is uuid, item_metrics.item_id is text — cast to compare.
UPDATE "item_metrics" m
SET "lifecycle_status" = i."lifecycle_status"
FROM "items" i
WHERE i."item_id"::text = m."item_id"
  AND m."lifecycle_status" <> i."lifecycle_status";
