-- GENERATED FILE — do not edit by hand.
--
-- Source: packages/database/src/utils/sql_scripts/auth.sql, packages/database/src/utils/sql_scripts/metrics.sql, packages/database/src/utils/sql_scripts/pii_reveal_audit.sql, packages/database/src/utils/sql_scripts/consent_record.sql, packages/database/src/utils/sql_scripts/create_items.sql, packages/database/src/utils/sql_scripts/create_actions_events.sql
-- Regenerate with: pnpm schema:bundle
-- CI guards drift via: pnpm schema:bundle:check
--
-- Applied by the deployment migrate-job at install/upgrade time (charts live
-- in a separate repo). Every statement must be idempotent (CREATE … IF NOT
-- EXISTS / ALTER … ADD COLUMN IF NOT EXISTS / DO-block-guarded ADD
-- CONSTRAINT). See docs/operations/migrations.md for the full contract.


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
  -- Plan 2: participant attribution. Set by /api/v1/admin/onboard_participant.
  "onboarded_by_org_id" text,
  "onboarded_via"       text,
  "onboarded_source_id" text,
  "onboarded_at"        timestamp,
  -- Extensible support/ops markers (e.g. {"is_test": true}). See ADD COLUMN below.
  "tags"                jsonb NOT NULL DEFAULT '{}'::jsonb,
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
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboarded_by_org_id" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboarded_via" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboarded_source_id" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp;
-- Extensible support/ops markers. Keyed jsonb so new flags need no migration.
-- Current key: `is_test` (boolean) — marks a user (and, via the
-- created_by/owner join, their profiles, posts, and applications) as test data
-- for analysis + later bulk cleanup.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '{}'::jsonb;
-- GIN index accelerates `tags @> '{"is_test": true}'` containment lookups.
CREATE INDEX IF NOT EXISTS user_tags_gin_idx ON "user" USING GIN (tags);

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

-- Plan 2: user.onboarded_by_org_id -> organization.id. Declared here (not in
-- section 1) because the referenced "organization" table is created above.
-- No ON DELETE CASCADE — we keep attribution even if the org row is deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_onboarded_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT user_onboarded_by_org_id_organization_id_fk
      FOREIGN KEY ("onboarded_by_org_id") REFERENCES "organization"("id");
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

------------------------------------------------------------------------------
-- 10. indexes
------------------------------------------------------------------------------

-- Plan 2: aggregator dashboard (Plan 3) filters heavily on
-- (onboarded_by_org_id, onboarded_via) to slice participants by source.
CREATE INDEX IF NOT EXISTS user_onboarded_by_org_via_idx
  ON "user" (onboarded_by_org_id, onboarded_via);

-- ─── metrics.sql ───

-- packages/database/src/utils/sql_scripts/metrics.sql
--
-- Idempotent SQL bootstrap for Plan B's item_metrics table. Mirrors the
-- Drizzle schema in apps/api/db/postgres/schema/metrics.ts; CI parity
-- check (Plan 4 A.3) fails if they drift.

-- Plan B: drop the user-keyed participant_metrics (Plan 3) outright.
-- Pre-pilot — no production data to preserve. CASCADE handles any
-- inbound FK; recompute is the only writer so there shouldn't be any.
DROP TABLE IF EXISTS participant_metrics CASCADE;

DROP TABLE IF EXISTS item_metrics CASCADE;

CREATE TABLE IF NOT EXISTS item_metrics (
  item_id                   text PRIMARY KEY,
  item_network              text NOT NULL,
  item_domain               text NOT NULL,
  item_type                 text NOT NULL,
  owner_user_id             text NOT NULL,
  onboarded_by_org_id       text,
  onboarded_via             text,

  display_name              text NOT NULL,

  profile_status            text,
  profile_completion_pct    integer,
  profile_created_at        timestamp,
  profile_last_updated_at   timestamp,
  age_days                  integer,

  -- Directional action counts — full jsonb maps over the 4 canonical buckets.
  initiated                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  received                  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Most-recent action timestamp per bucket, per direction. SPARSE jsonb:
  -- only buckets that occurred carry an ISO-string value.
  last_initiated_at         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_received_at          jsonb NOT NULL DEFAULT '{}'::jsonb,

  actionable_tags           text[],

  last_computed_at          timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_metrics_onboarded_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE item_metrics
      ADD CONSTRAINT item_metrics_onboarded_by_org_id_organization_id_fk
      FOREIGN KEY (onboarded_by_org_id) REFERENCES organization(id);
  END IF;
END
$$;

-- Hot path: dashboard rollup + filter by status within a domain.
CREATE INDEX IF NOT EXISTS item_metrics_org_domain_status_idx
  ON item_metrics (onboarded_by_org_id, item_domain, profile_status);

-- Staleness check: MIN(last_computed_at) per (aggregator, domain).
CREATE INDEX IF NOT EXISTS item_metrics_org_domain_last_computed_idx
  ON item_metrics (onboarded_by_org_id, item_domain, last_computed_at);

-- Per-user rollup queries (avg_profiles_per_user, users_with_applications).
CREATE INDEX IF NOT EXISTS item_metrics_owner_domain_idx
  ON item_metrics (owner_user_id, item_domain);

-- ─── pii_reveal_audit.sql ───

-- pii_reveal_audit.sql
--
-- Idempotent DDL for the PII-reveal audit table. Mirrors the Drizzle
-- definition in apps/api/db/postgres/schema/pii_reveal_audit.ts.
--
-- Append-only. No FKs to item_actions or items (both partitioned).

CREATE TABLE IF NOT EXISTS pii_reveal_audit (
  reveal_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id                      uuid NOT NULL,
  viewer_user_id                 text NOT NULL,
  revealed_item_id               uuid NOT NULL,
  revealed_item_owner            text NOT NULL,
  revealed_action_type           text NOT NULL,
  revealed_action_status_at_view text NOT NULL,
  viewed_at                      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pii_reveal_audit_viewer_idx
  ON pii_reveal_audit (viewer_user_id, viewed_at);

CREATE INDEX IF NOT EXISTS pii_reveal_audit_item_idx
  ON pii_reveal_audit (revealed_item_id, viewed_at);

-- ─── consent_record.sql ───

-- consent_record.sql
--
-- Idempotent DDL for the consent ledger. Mirrors the Drizzle
-- definition in apps/api/db/postgres/schema/consent_record.ts.
--
-- Append-only. No FKs to items/item_actions (both partitioned);
-- app-level integrity only. Latest event per (subject, type) wins
-- by `seq`, never by timestamp.

CREATE TABLE IF NOT EXISTS consent_record (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               bigserial   NOT NULL,
  level             text        NOT NULL,
  consent_category  text        NOT NULL,
  action_type       text,
  action_stage      text,
  user_id           text        NOT NULL,
  item_id           uuid,
  action_id         uuid,
  network           text        NOT NULL,
  brand             text,
  document_version  integer     NOT NULL,
  source            text        NOT NULL,
  accepted_at       timestamp   NOT NULL,
  created_at        timestamp   NOT NULL DEFAULT now(),
  metadata          jsonb
);

CREATE INDEX IF NOT EXISTS consent_record_user_idx
  ON consent_record (user_id, consent_category, action_type, action_stage, seq);

CREATE INDEX IF NOT EXISTS consent_record_item_idx
  ON consent_record (item_id, consent_category);

CREATE INDEX IF NOT EXISTS consent_record_action_idx
  ON consent_record (action_id);

-- Item-level profile_creation is idempotent: at most one acceptance per
-- (user, item). This makes the accept-profile-consent 23505 fallback live and
-- prevents a concurrent double-submit from slipping past the check-then-insert.
-- Terms/privacy/action rows are intentionally append-only and are NOT
-- constrained, so this index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS consent_record_profile_creation_unique
  ON consent_record (user_id, item_id)
  WHERE level = 'item' AND consent_category = 'profile_creation';

-- ─── create_items.sql ───

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;

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
