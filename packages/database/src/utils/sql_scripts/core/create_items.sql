
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
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'draft';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_lifecycle_status_chk'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT items_lifecycle_status_chk
      CHECK (lifecycle_status IN ('draft','live','paused'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS items_lifecycle_idx
  ON items (item_network, item_domain, lifecycle_status);

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
