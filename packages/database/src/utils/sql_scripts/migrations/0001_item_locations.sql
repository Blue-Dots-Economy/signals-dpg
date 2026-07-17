-- Migration: replace scalar lat/lng columns with item_locations JSONB on items and action_events
-- Safe to run multiple times (all operations guarded with IF EXISTS / IF NOT EXISTS).

-- items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'items' AND column_name = 'item_latitude'
  ) THEN
    UPDATE items
       SET item_locations = jsonb_build_array(jsonb_build_object('lat', item_latitude, 'lng', item_longitude))
     WHERE item_latitude IS NOT NULL
       AND item_longitude IS NOT NULL
       AND item_locations = '[]'::jsonb;
  END IF;
END $$;

DROP INDEX IF EXISTS items_geo_earth_idx;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_geo_lat_chk;
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_geo_lng_chk;
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_geo_pair_chk;

ALTER TABLE items DROP COLUMN IF EXISTS item_latitude;
ALTER TABLE items DROP COLUMN IF EXISTS item_longitude;

-- action_events table
ALTER TABLE action_events ADD COLUMN IF NOT EXISTS source_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE action_events ADD COLUMN IF NOT EXISTS target_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_events' AND column_name = 'source_item_latitude'
  ) THEN
    UPDATE action_events
       SET source_item_locations = jsonb_build_array(jsonb_build_object('lat', source_item_latitude, 'lng', source_item_longitude))
     WHERE source_item_latitude IS NOT NULL
       AND source_item_longitude IS NOT NULL
       AND source_item_locations = '[]'::jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_events' AND column_name = 'target_item_latitude'
  ) THEN
    UPDATE action_events
       SET target_item_locations = jsonb_build_array(jsonb_build_object('lat', target_item_latitude, 'lng', target_item_longitude))
     WHERE target_item_latitude IS NOT NULL
       AND target_item_longitude IS NOT NULL
       AND target_item_locations = '[]'::jsonb;
  END IF;
END $$;

ALTER TABLE action_events DROP COLUMN IF EXISTS source_item_latitude;
ALTER TABLE action_events DROP COLUMN IF EXISTS source_item_longitude;
ALTER TABLE action_events DROP COLUMN IF EXISTS target_item_latitude;
ALTER TABLE action_events DROP COLUMN IF EXISTS target_item_longitude;
