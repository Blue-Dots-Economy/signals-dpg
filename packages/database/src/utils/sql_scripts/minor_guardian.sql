-- packages/database/src/utils/sql_scripts/minor_guardian.sql
--
-- Idempotent DDL for the U18 guardian-consent record. Mirrors the Drizzle
-- definition in apps/api/db/postgres/schema/minor_guardian.ts.
--
-- One row per ward (better-auth user_id). birth_year/birth_month are
-- plaintext (no exact day); is_minor is DERIVED at read time, never stored.
-- guardian_name/guardian_contact hold PII (encrypted at the write path in a
-- later phase). No FKs — app-level integrity only.

CREATE TABLE IF NOT EXISTS minor_guardian (
  user_id                text      PRIMARY KEY,
  birth_year             integer   NOT NULL,
  birth_month            integer   NOT NULL,
  guardian_name          text,
  guardian_contact       text,
  guardian_contact_type  text,
  guardian_verified      boolean   NOT NULL DEFAULT false,
  created_at             timestamp NOT NULL DEFAULT now(),
  updated_at             timestamp NOT NULL DEFAULT now()
);
