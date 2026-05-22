-- GENERATED FILE — do not edit by hand.
--
-- Source: packages/database/src/utils/sql_scripts/auth.sql, packages/database/src/utils/sql_scripts/create_items.sql, packages/database/src/utils/sql_scripts/create_actions_events.sql
-- Regenerate with: pnpm schema:bundle
-- CI guards drift via: pnpm schema:bundle:check
--
-- Applied by the helm migrate-job at install/upgrade time. Every statement
-- must be idempotent (CREATE … IF NOT EXISTS / ALTER … ADD COLUMN IF NOT
-- EXISTS / DO-block-guarded ADD CONSTRAINT). See docs/operations/migrations.md
-- for the full contract.


-- ─── auth.sql ───

-- packages/database/src/utils/sql_scripts/auth.sql
--
-- Idempotent SQL bootstrap for the better-auth tables. Mirrors the Drizzle
-- schema at apps/api/db/postgres/schema/auth.ts. Applied by:
--   - the helm migrate-job (bundled into helmcharts/dpg/charts/api/files/schema.sql);
--   - is NOT applied by apps/api/scripts/db_init.ts — local dev runs
--     `pnpm db:push:api` which uses Drizzle directly.
--
-- Plan 4 Workstream A.3 will add a CI parity check that fails if this
-- file and the Drizzle schema diverge. Until then, any change to
-- auth.ts MUST be mirrored here in the same PR.
--
-- Every statement is idempotent:
--   CREATE TABLE IF NOT EXISTS
--   CREATE INDEX IF NOT EXISTS
--   ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--   ALTER TABLE ... ADD CONSTRAINT (guarded via DO block — PG doesn't support
--                                   ADD CONSTRAINT IF NOT EXISTS for FKs directly)
--
-- Limitation: the standalone ALTER TABLE ADD COLUMN IF NOT EXISTS lines below
-- can only backfill columns that are nullable or carry a DEFAULT clause.
-- Non-additive transitions — including the better-auth 1.6.x apikey realignment
-- that introduced `reference_id NOT NULL` — cannot be handled here; they must go
-- through a Drizzle migration with an explicit backfill step. On fresh
-- deployments the CREATE TABLE IF NOT EXISTS path covers everything; on
-- populated legacy deployments any non-additive column add is the operator's
-- responsibility (today this is moot because the helm migrate-job short-
-- circuits when the `items` table already exists — see
-- docs/operations/migrations.md).
--
-- Type mapping notes:
--   - Drizzle pg `timestamp(...)` without `{ withTimezone: true }` maps to
--     TIMESTAMP (no timezone). We use TIMESTAMP here to match.
--   - `.$defaultFn(() => ...)` in Drizzle is a runtime default applied by the
--     ORM on insert, NOT a DB default — we deliberately omit DEFAULT for
--     those columns.
--   - `.default(literal)` in Drizzle IS a DB default — we emit it as such.
--   - Foreign key constraint names follow Drizzle's auto-generated convention
--     `<table>_<column>_<reftable>_<refcolumn>_fk` so the A.3 parity check
--     sees identical constraint names.

------------------------------------------------------------------------------
-- 1. user
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "user" (
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
  CONSTRAINT "user_email_unique" UNIQUE ("email"),
  CONSTRAINT "user_phone_number_unique" UNIQUE ("phone_number")
);

-- Columns added after initial CREATE — re-asserted via ADD COLUMN IF NOT EXISTS
-- so existing deployments converge to the current shape.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "banned" boolean;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_reason" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_expires" timestamp;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone_number" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone_number_verified" boolean;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "date_of_birth" timestamp;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "terms_accepted" boolean DEFAULT false;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "privacy_accepted" boolean DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_email_unique'
  ) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_email_unique" UNIQUE ("email");
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_phone_number_unique'
  ) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_phone_number_unique" UNIQUE ("phone_number");
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 2. organization
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text,
  "logo" text,
  "created_at" timestamp NOT NULL,
  "metadata" text,
  "type" text,
  CONSTRAINT "organization_slug_unique" UNIQUE ("slug")
);

ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "type" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_slug_unique'
  ) THEN
    ALTER TABLE "organization" ADD CONSTRAINT "organization_slug_unique" UNIQUE ("slug");
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 3. account  (FK -> user)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "account" (
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'account_user_id_user_id_fk'
  ) THEN
    ALTER TABLE "account"
      ADD CONSTRAINT "account_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 4. verification
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp,
  "updated_at" timestamp
);

------------------------------------------------------------------------------
-- 5. member  (FK -> organization, user)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "team_id" text,
  "created_at" timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'member_organization_id_organization_id_fk'
  ) THEN
    ALTER TABLE "member"
      ADD CONSTRAINT "member_organization_id_organization_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'member_user_id_user_id_fk'
  ) THEN
    ALTER TABLE "member"
      ADD CONSTRAINT "member_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 6. invitation  (FK -> organization, user)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "email" text NOT NULL,
  "role" text,
  "team_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp NOT NULL,
  "inviter_id" text NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invitation_organization_id_organization_id_fk'
  ) THEN
    ALTER TABLE "invitation"
      ADD CONSTRAINT "invitation_organization_id_organization_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invitation_inviter_id_user_id_fk'
  ) THEN
    ALTER TABLE "invitation"
      ADD CONSTRAINT "invitation_inviter_id_user_id_fk"
      FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 7. team  (FK -> organization)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "team" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "organization_id" text NOT NULL,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_organization_id_organization_id_fk'
  ) THEN
    ALTER TABLE "team"
      ADD CONSTRAINT "team_organization_id_organization_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 8. team_member  (FK -> user)
--   Note: team_id has no FK in the Drizzle schema (intentional — teams may
--   be deleted independently and team_member rows tombstoned by the app).
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "team_member" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_member_user_id_user_id_fk'
  ) THEN
    ALTER TABLE "team_member"
      ADD CONSTRAINT "team_member_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
  END IF;
END
$$;

------------------------------------------------------------------------------
-- 9. apikey  (FK -> user, NULLABLE)
--   Realigned in PR #4 to better-auth 1.6.x:
--     - added config_id (NOT NULL, default 'default')
--     - added reference_id (NOT NULL)
--     - user_id is nullable (apikeys may be config-scoped, not user-scoped)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "apikey" (
  "id" text PRIMARY KEY NOT NULL,
  "config_id" text DEFAULT 'default' NOT NULL,
  "name" text,
  "start" text,
  "reference_id" text NOT NULL,
  "prefix" text,
  "key" text NOT NULL,
  "user_id" text,
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

-- Columns added by the PR #4 realignment — re-asserted so older deployments
-- pick them up idempotently. `config_id` is safe because the DEFAULT backfills
-- existing rows. `reference_id` (NOT NULL, no DEFAULT) is intentionally NOT
-- re-asserted here: on a populated legacy apikey table the ALTER would fail
-- because there is no value to backfill. The CREATE TABLE IF NOT EXISTS path
-- above handles fresh deployments; populated legacy deployments must apply
-- this column via a Drizzle migration with an explicit backfill (see the
-- header note on non-additive transitions).
ALTER TABLE "apikey" ADD COLUMN IF NOT EXISTS "config_id" text DEFAULT 'default' NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'apikey_user_id_user_id_fk'
  ) THEN
    ALTER TABLE "apikey"
      ADD CONSTRAINT "apikey_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- ─── create_items.sql ───

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
  item_private_state JSONB NOT NULL DEFAULT '{}'::jsonb,

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

ALTER TABLE IF EXISTS items
ADD COLUMN IF NOT EXISTS item_private_state JSONB NOT NULL DEFAULT '{}'::jsonb;

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

CREATE INDEX IF NOT EXISTS items_private_state_gin_idx
ON items USING GIN (item_private_state);

CREATE INDEX IF NOT EXISTS items_geo_earth_idx
ON items USING GIST (ll_to_earth(item_latitude, item_longitude));

-- ─── create_actions_events.sql ───

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
