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
