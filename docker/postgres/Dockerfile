# Postgres 17 with the extensions create_items.sql needs:
#   pgcrypto, cube, earthdistance (base) + vector (pgvector) + postgis.
# The stock postgres:17-alpine image ships neither pgvector nor postgis.
# pgvector/pgvector is multi-arch (amd64 + arm64) and bundles pgvector;
# postgis is added from the PGDG apt repo the base image already carries.
# Trivy DS-0002 (no USER) / DS-0026 (no HEALTHCHECK) are ACCEPTED here, not
# oversights — see #548.
#
# DS-0002: the image intentionally starts as root. postgres's docker-entrypoint.sh
# must chown $PGDATA and /var/run/postgresql to the `postgres` user before the
# server can start on a fresh volume, then hands off with `exec gosu postgres`
# (line ~343 of that script). So the database process does NOT run as root; only
# the short init phase does. Pinning `USER postgres` here breaks first-boot
# initialisation on any volume not already owned by uid 999.
#
# DS-0026: liveness/readiness for Postgres is configured in the deploy chart's
# probes, which Kubernetes uses in preference to a Docker HEALTHCHECK anyway.
FROM pgvector/pgvector:pg17

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
    && rm -rf /var/lib/apt/lists/*
