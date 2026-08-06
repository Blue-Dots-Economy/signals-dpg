-- #347: drop the lifecycle_status CHECK constraint entirely.
-- The set of lifecycle states (draft | live | paused | retired) is owned by the
-- application (`LifecycleStatus` in services/items/classifier.ts) — the only
-- writers are the classifier + the lifecycle route. The DB CHECK only
-- duplicated that enum and forced a migration for every new state (this is what
-- retire tripped over), so it is removed rather than extended. Idempotent.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_lifecycle_status_chk;
