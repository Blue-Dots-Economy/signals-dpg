CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

  requirements_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  remarks TEXT,

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

CREATE INDEX IF NOT EXISTS item_actions_source_owner_idx
ON item_actions (source_item_owner, updated_at DESC);

CREATE INDEX IF NOT EXISTS item_actions_target_owner_idx
ON item_actions (target_item_owner, updated_at DESC);

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
  source_item_latitude DOUBLE PRECISION,
  source_item_longitude DOUBLE PRECISION,

  target_item_network TEXT NOT NULL,
  target_item_domain TEXT NOT NULL,
  target_item_type TEXT NOT NULL,
  target_item_id UUID NOT NULL,
  target_item_instance_url TEXT NOT NULL,
  target_item_owner TEXT,
  target_item_latitude DOUBLE PRECISION,
  target_item_longitude DOUBLE PRECISION,

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

CREATE INDEX IF NOT EXISTS action_events_target_owner_idx
ON action_events (target_item_owner, created_at DESC);

CREATE INDEX IF NOT EXISTS action_events_payload_gin_idx
ON action_events USING GIN (event_payload);
