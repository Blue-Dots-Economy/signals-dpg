-- Custom SQL migration (hand-written): the raw, LIST-partitioned core tables
-- that Drizzle's schema DSL cannot model (declarative partitioning has no
-- drizzle-kit API). Authored via `drizzle-kit generate --custom`; run once via
-- the ledger.
--
-- Ordering: runs after 0000 (the declarative better-auth / user / organization
-- tables) because items.created_by and item_actions.performed_by_* FK them.
-- Extensions are NOT created here — they are a provisioning prerequisite
-- (common-services / RDS master in deploy; docker-entrypoint-initdb.d locally),
-- asserted by the migrate-Job preflight before this runs.
--
-- Leaf partitions (per network/domain) are created at runtime by the app
-- (packages/database/.../partition_by_type.ts), never here.

CREATE TABLE IF NOT EXISTS items (
  item_network TEXT NOT NULL,
  item_domain TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id UUID DEFAULT gen_random_uuid() NOT NULL,

  item_instance_url TEXT NOT NULL,
  item_schema_url TEXT NOT NULL,

  item_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  item_private_state TEXT NOT NULL DEFAULT '',

  item_locations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL,

  lifecycle_status TEXT NOT NULL DEFAULT 'draft',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT items_pk PRIMARY KEY (item_network, item_domain, item_type, item_id),
  CONSTRAINT items_created_by_fk FOREIGN KEY (created_by)
    REFERENCES "user" (id) ON DELETE RESTRICT,
  CONSTRAINT items_lifecycle_status_chk
    CHECK (lifecycle_status IN ('draft','live','paused'))
)
PARTITION BY LIST (item_network);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_lookup_idx ON items (item_network, item_domain, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_instance_url_idx ON items (item_instance_url);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_schema_url_idx ON items (item_schema_url);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_created_by_idx ON items (created_by, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_state_gin_idx ON items USING GIN (item_state);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_lifecycle_idx ON items (item_network, item_domain, lifecycle_status);--> statement-breakpoint
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

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT item_actions_pk PRIMARY KEY (partition_network, action_type, action_id),
  CONSTRAINT item_actions_target_item_fk FOREIGN KEY (
    target_item_network, target_item_domain, target_item_type, target_item_id
  ) REFERENCES items (
    item_network, item_domain, item_type, item_id
  ) ON DELETE CASCADE,
  CONSTRAINT item_actions_performed_by_org_id_organization_id_fk
    FOREIGN KEY (performed_by_org_id) REFERENCES "organization" (id),
  CONSTRAINT item_actions_performed_by_service_user_id_user_id_fk
    FOREIGN KEY (performed_by_service_user_id) REFERENCES "user" (id)
)
PARTITION BY LIST (partition_network);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_source_item_idx ON item_actions (source_item_network, source_item_domain, source_item_type, source_item_id, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_target_item_idx ON item_actions (target_item_network, target_item_domain, target_item_type, target_item_id, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_source_owner_idx ON item_actions (source_item_owner, updated_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_target_owner_idx ON item_actions (target_item_owner, updated_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_status_idx ON item_actions (action_status, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_update_count_idx ON item_actions (partition_network, action_type, action_id, update_count DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_actions_requirements_gin_idx ON item_actions USING GIN (requirements_snapshot);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS action_events_origin_action_update_idx ON action_events (partition_network, action_type, origin_instance_domain, action_id, update_count);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS action_events_action_idx ON action_events (partition_network, action_type, action_id, update_count DESC, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS action_events_source_item_idx ON action_events (source_item_network, source_item_domain, source_item_type, source_item_id, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS action_events_target_item_idx ON action_events (target_item_network, target_item_domain, target_item_type, target_item_id, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS action_events_source_owner_idx ON action_events (source_item_owner, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS action_events_target_owner_idx ON action_events (target_item_owner, created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS action_events_payload_gin_idx ON action_events USING GIN (event_payload);
