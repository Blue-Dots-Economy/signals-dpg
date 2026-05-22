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
-- pick them up idempotently.
ALTER TABLE "apikey" ADD COLUMN IF NOT EXISTS "config_id" text DEFAULT 'default' NOT NULL;
ALTER TABLE "apikey" ADD COLUMN IF NOT EXISTS "reference_id" text NOT NULL;

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
