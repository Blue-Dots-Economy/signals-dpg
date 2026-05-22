-- packages/database/src/utils/sql_scripts/metrics.sql
--
-- Idempotent SQL bootstrap for the participant_metrics table. Mirrors the
-- Drizzle schema in apps/api/db/postgres/schema/metrics.ts; CI parity
-- check (Plan 4 A.3) fails if they drift.

CREATE TABLE IF NOT EXISTS participant_metrics (
  user_id                 text PRIMARY KEY,
  onboarded_by_org_id     text,
  onboarded_via           text,
  profile_status          text,
  profile_completion_pct  integer,
  profile_created_at      timestamp,
  profile_last_updated_at timestamp,
  age_days                integer,
  applications_pending    integer DEFAULT 0,
  applications_accepted   integer DEFAULT 0,
  applications_rejected   integer DEFAULT 0,
  applications_total      integer DEFAULT 0,
  actionable_tags         text[],
  last_computed_at        timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_metrics_user_id_user_id_fk'
  ) THEN
    ALTER TABLE participant_metrics
      ADD CONSTRAINT participant_metrics_user_id_user_id_fk
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_metrics_onboarded_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE participant_metrics
      ADD CONSTRAINT participant_metrics_onboarded_by_org_id_organization_id_fk
      FOREIGN KEY (onboarded_by_org_id) REFERENCES organization(id);
  END IF;
END
$$;

-- Hot path: list per aggregator + filter by status.
CREATE INDEX IF NOT EXISTS participant_metrics_org_status_idx
  ON participant_metrics (onboarded_by_org_id, profile_status);

-- Staleness check: MIN(last_computed_at) per aggregator.
CREATE INDEX IF NOT EXISTS participant_metrics_org_last_computed_idx
  ON participant_metrics (onboarded_by_org_id, last_computed_at);
