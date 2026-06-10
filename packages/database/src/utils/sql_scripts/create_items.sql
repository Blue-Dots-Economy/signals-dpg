CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE TABLE IF NOT EXISTS items (
  item_network TEXT NOT NULL,
  item_domain TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id UUID DEFAULT gen_random_uuid() NOT NULL,

  item_instance_url TEXT NOT NULL,
  item_schema_url TEXT NOT NULL,

  item_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  item_private_state TEXT NOT NULL DEFAULT '',

  item_latitude DOUBLE PRECISION,
  item_longitude DOUBLE PRECISION,
  created_by TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT items_pk PRIMARY KEY (item_network, item_domain, item_type, item_id),
  CONSTRAINT items_created_by_fk FOREIGN KEY (created_by)
    REFERENCES "user" (id) ON DELETE RESTRICT,
  CONSTRAINT items_geo_lat_chk CHECK (
    item_latitude IS NULL OR (item_latitude >= -90 AND item_latitude <= 90)
  ),
  CONSTRAINT items_geo_lng_chk CHECK (
    item_longitude IS NULL OR (item_longitude >= -180 AND item_longitude <= 180)
  ),
  CONSTRAINT items_geo_pair_chk CHECK (
    (item_latitude IS NULL AND item_longitude IS NULL)
    OR
    (item_latitude IS NOT NULL AND item_longitude IS NOT NULL)
  )
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

CREATE INDEX IF NOT EXISTS items_geo_earth_idx
ON items USING GIST (ll_to_earth(item_latitude, item_longitude));

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
