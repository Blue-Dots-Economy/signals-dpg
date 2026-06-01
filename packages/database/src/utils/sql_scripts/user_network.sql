-- packages/database/src/utils/sql_scripts/user_network.sql
--
-- Idempotent SQL bootstrap for the user_network bridge table.
-- Mirrors the Drizzle schema in apps/api/db/postgres/schema/user_network.ts.
--
-- Tracks a user's membership across one or more networks. PK enforces
-- "one domain per network per user" at the database level; cross-network
-- multi-membership is the multi-row shape.

CREATE TABLE IF NOT EXISTS user_network (
  user_id  text NOT NULL,
  network  text NOT NULL,
  domain   text NOT NULL,
  CONSTRAINT user_network_user_id_network_pk PRIMARY KEY (user_id, network)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_network_user_id_user_id_fk'
  ) THEN
    ALTER TABLE user_network
      ADD CONSTRAINT user_network_user_id_user_id_fk
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
  END IF;
END
$$;

-- Reverse lookup: "all users in (network, domain)" — aggregator dashboards.
CREATE INDEX IF NOT EXISTS user_network_by_binding_idx
  ON user_network (network, domain);
