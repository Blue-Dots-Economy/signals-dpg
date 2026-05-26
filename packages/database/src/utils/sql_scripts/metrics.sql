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

  count_create              integer NOT NULL DEFAULT 0,
  count_accept              integer NOT NULL DEFAULT 0,
  count_reject              integer NOT NULL DEFAULT 0,
  count_cancel              integer NOT NULL DEFAULT 0,

  last_create_at            timestamp,
  last_accept_at            timestamp,
  last_reject_at            timestamp,
  last_cancel_at            timestamp,

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
