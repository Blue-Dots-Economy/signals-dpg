-- DPG schema bootstrap. Applied once by the post-install migrate Job.
-- Sources (kept canonical; do not edit by hand):
--   apps/api/drizzle/0000_init.sql                          -> auth tables
--   packages/database/src/utils/sql_scripts/create_items.sql -> items + indexes
--   packages/database/src/utils/sql_scripts/create_actions_events.sql -> actions/events
-- Extensions (pgcrypto, cube, earthdistance) are created upfront by the Job
-- with admin creds, and again by postgres initdb on first boot, so the
-- CREATE EXTENSION calls are intentionally omitted here.

-- ============================================================================
-- Auth tables (drizzle 0000_init.sql)
-- ============================================================================

CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"team_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"team_id" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	"type" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"role" text,
	"banned" boolean,
	"ban_reason" text,
	"ban_expires" timestamp,
	"phone_number" text,
	"phone_number_verified" boolean,
	"date_of_birth" timestamp,
	"terms_accepted" boolean DEFAULT false,
	"privacy_accepted" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;

-- ============================================================================
-- items table + indexes (create_items.sql)
-- ============================================================================

CREATE TABLE IF NOT EXISTS items (
  item_network TEXT NOT NULL,
  item_domain TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id UUID DEFAULT gen_random_uuid() NOT NULL,

  item_instance_url TEXT NOT NULL,
  item_schema_url TEXT NOT NULL,

  item_state JSONB NOT NULL DEFAULT '{}'::jsonb,

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
PARTITION BY LIST (item_type);

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

-- ============================================================================
-- item_actions + action_events (create_actions_events.sql)
-- ============================================================================

CREATE TABLE IF NOT EXISTS item_actions (
  action_name TEXT NOT NULL,
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

  CONSTRAINT item_actions_pk PRIMARY KEY (action_name, action_id),
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
PARTITION BY LIST (action_name);

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
ON item_actions (action_name, action_id, update_count DESC);

CREATE INDEX IF NOT EXISTS item_actions_requirements_gin_idx
ON item_actions USING GIN (requirements_snapshot);

CREATE TABLE IF NOT EXISTS action_events (
  action_name TEXT NOT NULL,
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

  CONSTRAINT action_events_pk PRIMARY KEY (action_name, event_id)
)
PARTITION BY LIST (action_name);

CREATE UNIQUE INDEX IF NOT EXISTS action_events_origin_action_update_idx
ON action_events (action_name, origin_instance_domain, action_id, update_count);

CREATE INDEX IF NOT EXISTS action_events_action_idx
ON action_events (action_name, action_id, update_count DESC, created_at DESC);

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
