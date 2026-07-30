-- GENERATED FILE — do not edit by hand.
--
-- Source: packages/database/src/utils/sql_scripts/extensions/extensions.sql, packages/database/src/utils/sql_scripts/core/create_items.sql, packages/database/src/utils/sql_scripts/core/create_actions_events.sql
-- Regenerate with: pnpm schema:bundle
-- CI guards drift via: pnpm schema:bundle:check
--
-- This is the RAW (non-Drizzle) layer: Postgres extensions + the partitioned
-- item/action/event tables. It is applied AFTER the Drizzle migrations
-- (apps/api/drizzle/) — items.created_by FKs to the Drizzle-owned "user" table.
-- Applied by the deploy migrate runner (apps/api/scripts/migrate.mjs). Every
-- statement must be idempotent (CREATE … IF NOT EXISTS / ALTER … ADD COLUMN IF
-- NOT EXISTS / DO-block-guarded ADD CONSTRAINT). See docs/operations/migrations.md.


-- ─── extensions/extensions.sql ───

-- Postgres extensions required by the raw item/action/event schema.
-- Superuser-level: in deploy these are created by common-services
-- (postgresBootstrap) as the RDS master; locally the dev superuser creates them.
-- Idempotent — safe to re-run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── core/create_items.sql ───

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
    REFERENCES "user" (id) ON DELETE RESTRICT
)
PARTITION BY LIST (item_network);

CREATE INDEX IF NOT EXISTS items_lookup_idx
ON items (item_network, item_domain, created_at DESC);

CREATE INDEX IF NOT EXISTS items_instance_url_idx
ON items (item_instance_url);

CREATE INDEX IF NOT EXISTS items_schema_url_idx
ON items (item_schema_url);

CREATE INDEX IF NOT EXISTS items_created_by_idx
ON items (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS items_state_gin_idx
ON items USING GIN (item_state);

-- Upgrade guards for databases created before these columns existed in the
-- CREATE TABLE above. Each new items column must appear BOTH in the create
-- statement (fresh installs) and as an ADD COLUMN IF NOT EXISTS here
-- (existing deployments re-applying the bundle).

-- Multi-location items (2026-06 #112).
ALTER TABLE items ADD COLUMN IF NOT EXISTS item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Lifecycle status (2026-06-03 spec).
-- The allowed values (draft | live | paused | retired) are owned by the
-- application (`LifecycleStatus` in apps/api services/items/classifier.ts).
-- Deliberately NO CHECK constraint: only the classifier + lifecycle route write
-- this column, and a DB enum would force a migration for every new state (#347).
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'draft';

-- Drop the legacy CHECK if an older schema created it (superseded by #347).
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_lifecycle_status_chk;

CREATE INDEX IF NOT EXISTS items_lifecycle_idx
  ON items (item_network, item_domain, lifecycle_status);

-- Facet filter indexes (#203, drizzle/0006_facet_item_state_indexes.sql).
-- Expression btree per declared `filterable` facet path, NOT a blanket GIN —
-- a GIN on item_state only accelerates `@>`/`?` operators, not the
-- `item_state->>'field' = ANY(...)` pattern the map/list facet filters use.
CREATE INDEX IF NOT EXISTS items_item_state_gender_idx
  ON items ((item_state ->> 'gender'));
CREATE INDEX IF NOT EXISTS items_item_state_work_experience_idx
  ON items ((item_state ->> 'workExperience'));
CREATE INDEX IF NOT EXISTS items_item_state_nature_of_jobs_interested_in_idx
  ON items ((item_state ->> 'natureOfJobsInterestedIn'));

-- Provider (job_posting) facet filter indexes (#394,
-- drizzle/0010_job_posting_facet_indexes.sql). Same expression-btree
-- rationale as the seeker facets above, for the blue_dot job_posting_1.0
-- fields declared `filterable: true`.
CREATE INDEX IF NOT EXISTS items_item_state_nature_of_job_idx
  ON items ((item_state ->> 'natureOfJob'));
CREATE INDEX IF NOT EXISTS items_item_state_candidate_experience_type_idx
  ON items ((item_state ->> 'candidateExperienceType'));
CREATE INDEX IF NOT EXISTS items_item_state_work_experience_years_idx
  ON items ((item_state ->> 'workExperienceYears'));

-- ── item_search (Signals search engine V1) ──────────────────────────────────
-- Search/discovery index maintained by the signals-search service.
-- DDL authority lives here (shared dpg DB); the signals-search repo carries an
-- identical dev/test mirror. No FK to items: deletes are handled by the
-- 'delete' item-event + the reconciliation sweep.
CREATE TABLE IF NOT EXISTS item_search (
  item_network     text NOT NULL,
  item_domain      text NOT NULL,
  item_type        text NOT NULL,
  item_id          uuid NOT NULL,
  embedding        vector(1024),
  geo              geography(MultiPoint, 4326),
  lifecycle_status text NOT NULL DEFAULT 'draft',
  model_version    text,
  content_hash     text,
  indexed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_network, item_domain, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS item_search_embedding_hnsw
  ON item_search USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS item_search_geo_gist
  ON item_search USING gist (geo);
CREATE INDEX IF NOT EXISTS item_search_live
  ON item_search (item_network, item_domain, item_type) WHERE lifecycle_status = 'live';

-- ─── core/create_actions_events.sql ───

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
