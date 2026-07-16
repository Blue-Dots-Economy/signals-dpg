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
  guardian_email         text,
  guardian_phone         text,
  guardian_verified      boolean   NOT NULL DEFAULT false,
  created_at             timestamp NOT NULL DEFAULT now(),
  updated_at             timestamp NOT NULL DEFAULT now()
);

-- Additive columns for storing BOTH guardian contacts (idempotent for
-- already-created tables). guardian_contact still holds the OTP channel.
ALTER TABLE minor_guardian ADD COLUMN IF NOT EXISTS guardian_email text;
ALTER TABLE minor_guardian ADD COLUMN IF NOT EXISTS guardian_phone text;

-- Deterministic HMAC of the guardian contact, to count wards per guardian.
ALTER TABLE minor_guardian ADD COLUMN IF NOT EXISTS guardian_ref text;
CREATE INDEX IF NOT EXISTS minor_guardian_guardian_ref_idx ON minor_guardian (guardian_ref);
