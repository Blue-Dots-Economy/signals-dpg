-- packages/database/src/utils/sql_scripts/minor_guardian.sql
--
-- Idempotent DDL for the U18 guardian-consent record. Mirrors the Drizzle
-- definition in apps/api/db/postgres/schema/minor_guardian.ts.
--
-- One row per ward (better-auth user_id). The ward's date of birth lives on
-- `user.date_of_birth` (full date); is_minor is DERIVED at read time, never
-- stored here. guardian_name/guardian_contact/guardian_email/guardian_phone
-- hold PII (encrypted at the write path). guardian_ref is a deterministic HMAC
-- of the guardian's OTP-channel contact, used to cap wards per guardian
-- without decrypting. No FKs — app-level integrity only.

CREATE TABLE IF NOT EXISTS minor_guardian (
  user_id                text      PRIMARY KEY,
  guardian_name          text,
  guardian_contact       text,
  guardian_contact_type  text,
  guardian_email         text,
  guardian_phone         text,
  guardian_ref           text,
  guardian_verified      boolean   NOT NULL DEFAULT false,
  created_at             timestamp NOT NULL DEFAULT now(),
  updated_at             timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS minor_guardian_guardian_ref_idx ON minor_guardian (guardian_ref);
