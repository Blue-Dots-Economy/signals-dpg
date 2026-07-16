-- Custom SQL migration (hand-written): item_search — the Signals search-engine
-- V1 index. Raw because it uses pgvector (`vector(1024)`) and PostGIS
-- (`geography(MultiPoint,4326)`) types Drizzle cannot express, plus HNSW/GiST
-- indexes. Authored via `drizzle-kit generate --custom`; run once via the ledger.
--
-- Co-owned by the signals-search service (which reads/writes this table); DDL
-- authority lives here in signals-dpg. No FK to `items` today — deletes are
-- handled by the 'delete' item-event + the reconciliation sweep. Requires the
-- `vector` and `postgis` extensions (provisioning prerequisite; asserted by the
-- migrate-Job preflight).

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
  CONSTRAINT item_search_pk PRIMARY KEY (item_network, item_domain, item_type, item_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_search_embedding_hnsw ON item_search USING hnsw (embedding vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_search_geo_gist ON item_search USING gist (geo);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_search_live ON item_search (item_network, item_domain, item_type) WHERE lifecycle_status = 'live';
