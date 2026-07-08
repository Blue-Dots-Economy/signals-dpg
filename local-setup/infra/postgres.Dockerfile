# Postgres 17 with pgvector AND PostGIS — the extension set signals-dpg needs.
#
# WHY: signals-dpg's `db:init` applies apps/api/db/postgres/schema.sql, which runs
#   CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector (item_search embeddings)
#   CREATE EXTENSION IF NOT EXISTS postgis;     -- geo
#   CREATE EXTENSION IF NOT EXISTS cube;         -- earthdistance dep (bundled)
#   CREATE EXTENSION IF NOT EXISTS earthdistance;-- distance sort (bundled)
#   CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- (bundled)
# No single stock image ships both pgvector and PostGIS, and the official
# `postgis/postgis` image has NO arm64 build (breaks on Apple Silicon). So we
# base on `pgvector/pgvector:pg17` (multi-arch, already has pgvector) and add
# PostGIS from the PGDG apt repo the base image already configures. cube /
# earthdistance / pgcrypto are contrib modules bundled with the base image.
FROM pgvector/pgvector:pg17

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*
