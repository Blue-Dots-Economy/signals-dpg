
CREATE TABLE IF NOT EXISTS item_actions (
  partition_network TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_id UUID DEFAULT gen_random_uuid() NOT NULL,
  action_status TEXT NOT NULL,
  update_count INTEGER NOT NULL DEFAULT 0,

  source_item_network TEXT NOT NULL,
  source_item_domain TEXT NOT NULL,
  source_item_type TEXT NOT NULL,
  source_item_id UUID NOT NULL,
  source_item_instance_url TEXT NOT NULL,
  source_item_owner TEXT,

  target_item_network TEXT NOT NULL,
  target_item_domain TEXT NOT NULL,
  target_item_type TEXT NOT NULL,
  target_item_id UUID NOT NULL,
  target_item_instance_url TEXT NOT NULL,
  target_item_owner TEXT,

  performed_by_org_id TEXT,
  performed_by_service_user_id TEXT,

  requirements_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  remarks TEXT,
  match_score REAL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT item_actions_pk PRIMARY KEY (partition_network, action_type, action_id),
  CONSTRAINT item_actions_target_item_fk FOREIGN KEY (
    target_item_network,
    target_item_domain,
    target_item_type,
    target_item_id
  ) REFERENCES items (
    item_network,
    item_domain,
    item_type,
    item_id
  ) ON DELETE CASCADE
)
PARTITION BY LIST (partition_network);

-- Plan A: audit trail for on-behalf-of action filing.
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS performed_by_org_id TEXT;
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS performed_by_service_user_id TEXT;

-- #439: connect-time relevance score (0-10) from the match_score service.
-- Upgrade guard for databases created before this column was added to the
-- CREATE TABLE above.
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS match_score REAL;

CREATE INDEX IF NOT EXISTS item_actions_source_item_idx
ON item_actions (
  source_item_network,
  source_item_domain,
  source_item_type,
  source_item_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS item_actions_target_item_idx
ON item_actions (
  target_item_network,
  target_item_domain,
  target_item_type,
  target_item_id,
  created_at DESC
);

-- Per-pair action cap (#370/#422): open-action recount matches the unordered
-- {source, target} pair from either direction, type-agnostic (no action_type
-- filter). Both orderings indexed, partition_network-first, so the count's
-- `(source=A AND target=B) OR (source=B AND target=A)` is index-served either
-- way. The existing *_item_idx indexes lead with source/target network+domain+
-- type (not constrained by that query) so they don't serve it. Mirrors
-- drizzle/0010_action_pair_open_indexes.sql.
CREATE INDEX IF NOT EXISTS item_actions_pair_src_tgt_idx
ON item_actions (partition_network, source_item_id, target_item_id);

CREATE INDEX IF NOT EXISTS item_actions_pair_tgt_src_idx
ON item_actions (partition_network, target_item_id, source_item_id);

CREATE INDEX IF NOT EXISTS item_actions_source_owner_idx
ON item_actions (source_item_owner, updated_at DESC);

CREATE INDEX IF NOT EXISTS item_actions_target_owner_idx
ON item_actions (target_item_owner, updated_at DESC);

-- My-Actions per-profile filter/sort (#439): page an owner's actions by
-- status and recency from either side of the relation. Mirrors
-- drizzle/0011_action_owner_status_indexes.sql.
CREATE INDEX IF NOT EXISTS item_actions_target_owner_status_idx
ON item_actions (target_item_owner, action_status, updated_at);

CREATE INDEX IF NOT EXISTS item_actions_source_owner_status_idx
ON item_actions (source_item_owner, action_status, updated_at);

CREATE INDEX IF NOT EXISTS item_actions_status_idx
ON item_actions (action_status, created_at DESC);

CREATE INDEX IF NOT EXISTS item_actions_update_count_idx
ON item_actions (partition_network, action_type, action_id, update_count DESC);

CREATE INDEX IF NOT EXISTS item_actions_requirements_gin_idx
ON item_actions USING GIN (requirements_snapshot);

CREATE TABLE IF NOT EXISTS action_events (
  partition_network TEXT NOT NULL,
  action_type TEXT NOT NULL,
  event_id UUID DEFAULT gen_random_uuid() NOT NULL,
  origin_instance_domain TEXT NOT NULL,
  action_id UUID NOT NULL,
  action_status TEXT NOT NULL,
  update_count INTEGER NOT NULL,

  source_item_network TEXT NOT NULL,
  source_item_domain TEXT NOT NULL,
  source_item_type TEXT NOT NULL,
  source_item_id UUID NOT NULL,
  source_item_instance_url TEXT NOT NULL,
  source_item_owner TEXT,
  source_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb,

  target_item_network TEXT NOT NULL,
  target_item_domain TEXT NOT NULL,
  target_item_type TEXT NOT NULL,
  target_item_id UUID NOT NULL,
  target_item_instance_url TEXT NOT NULL,
  target_item_owner TEXT,
  target_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb,

  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT action_events_pk PRIMARY KEY (partition_network, action_type, event_id)
)
PARTITION BY LIST (partition_network);

CREATE UNIQUE INDEX IF NOT EXISTS action_events_origin_action_update_idx
ON action_events (partition_network, action_type, origin_instance_domain, action_id, update_count);

CREATE INDEX IF NOT EXISTS action_events_action_idx
ON action_events (partition_network, action_type, action_id, update_count DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS action_events_source_item_idx
ON action_events (
  source_item_network,
  source_item_domain,
  source_item_type,
  source_item_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS action_events_target_item_idx
ON action_events (
  target_item_network,
  target_item_domain,
  target_item_type,
  target_item_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS action_events_source_owner_idx
ON action_events (source_item_owner, created_at DESC);

-- Upgrade guards for databases created before multi-location (#112) replaced
-- the scalar lat/lng columns with the *_item_locations jsonb arrays in the
-- CREATE TABLE above. New columns must appear BOTH in the create statement
-- (fresh installs) and here (existing deployments re-applying the bundle).
ALTER TABLE action_events
  ADD COLUMN IF NOT EXISTS source_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE action_events
  ADD COLUMN IF NOT EXISTS target_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS action_events_target_owner_idx
ON action_events (target_item_owner, created_at DESC);

CREATE INDEX IF NOT EXISTS action_events_payload_gin_idx
ON action_events USING GIN (event_payload);

-- Plan A: FK audit columns -> organization / user. No cascade per spec —
-- keep audit even if the voice org or its service user row is deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_actions_performed_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE item_actions
      ADD CONSTRAINT item_actions_performed_by_org_id_organization_id_fk
      FOREIGN KEY (performed_by_org_id) REFERENCES "organization"(id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_actions_performed_by_service_user_id_user_id_fk'
  ) THEN
    ALTER TABLE item_actions
      ADD CONSTRAINT item_actions_performed_by_service_user_id_user_id_fk
      FOREIGN KEY (performed_by_service_user_id) REFERENCES "user"(id);
  END IF;
END
$$;
