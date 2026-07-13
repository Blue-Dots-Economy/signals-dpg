# Postgres 17 with the extensions create_items.sql needs:
#   pgcrypto, cube, earthdistance (base) + vector (pgvector) + postgis.
# The stock postgres:17-alpine image ships neither pgvector nor postgis.
# pgvector/pgvector is multi-arch (amd64 + arm64) and bundles pgvector;
# postgis is added from the PGDG apt repo the base image already carries.
FROM pgvector/pgvector:pg17

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
    && rm -rf /var/lib/apt/lists/*
