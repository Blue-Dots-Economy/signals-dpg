-- Custom migration: self-heal a legacy `items`/`item_actions`/`action_events`
-- that predates columns added after the original schema. 0001 only CREATEs
-- IF NOT EXISTS (a no-op on an existing table), so a behind-schema legacy table
-- never gets these columns without this ALTER. All idempotent → no-op on a
-- fresh/up-to-date DB, adds the missing columns on an old one.

ALTER TABLE items ADD COLUMN IF NOT EXISTS item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'draft';--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_lifecycle_status_chk') THEN
    ALTER TABLE items ADD CONSTRAINT items_lifecycle_status_chk CHECK (lifecycle_status IN ('draft','live','paused'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_lifecycle_idx ON items (item_network, item_domain, lifecycle_status);--> statement-breakpoint

ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS performed_by_org_id TEXT;--> statement-breakpoint
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS performed_by_service_user_id TEXT;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_actions_performed_by_org_id_organization_id_fk') THEN
    ALTER TABLE item_actions ADD CONSTRAINT item_actions_performed_by_org_id_organization_id_fk
      FOREIGN KEY (performed_by_org_id) REFERENCES "organization" (id);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_actions_performed_by_service_user_id_user_id_fk') THEN
    ALTER TABLE item_actions ADD CONSTRAINT item_actions_performed_by_service_user_id_user_id_fk
      FOREIGN KEY (performed_by_service_user_id) REFERENCES "user" (id);
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE action_events ADD COLUMN IF NOT EXISTS source_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE action_events ADD COLUMN IF NOT EXISTS target_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
