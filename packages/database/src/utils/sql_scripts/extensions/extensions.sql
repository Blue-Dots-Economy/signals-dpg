-- Postgres extensions required by the raw item/action/event schema.
-- Superuser-level: in deploy these are created by common-services
-- (postgresBootstrap) as the RDS master; locally the dev superuser creates them.
-- Idempotent — safe to re-run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;
