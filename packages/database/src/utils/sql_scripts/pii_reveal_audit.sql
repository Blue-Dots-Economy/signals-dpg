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
