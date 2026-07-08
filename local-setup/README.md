# local-setup — signals-dpg standalone local stack

One `docker compose up -d` that brings up **signals-dpg alone** — API + UI plus
only its own backing dependencies — wired for localhost. No aggregator, no
Keycloak, no sibling repos.

- **signals-api** — Fastify backend (`:2742`)
- **signals-ui** — Vite UI (`:5173`)
- **postgres** — Postgres 17 + pgvector + PostGIS (extensions `db:init` needs)
- **redis** — password-protected (`:5555`)

👉 **Full walkthrough: [`LOCAL_SETUP.md`](./LOCAL_SETUP.md)** (Track A = all-in-Docker,
Track B = hybrid hot-reload).

## Quick start (Track A)

```bash
cd signals-dpg/local-setup
cp .env.example .env          # set SIGNALS_PII_KEY (openssl rand -base64 32)
docker compose up -d --build
docker compose ps             # wait for signals-api
```

UI → http://localhost:5173 · API → http://localhost:2742 (`/reference` for Swagger)

## Contents

| File | Purpose |
|---|---|
| `docker-compose.yml` | signals stack (API + UI + Postgres + Redis) |
| `.env.example` | working dev defaults — copy to `.env` |
| `LOCAL_SETUP.md` | from-scratch guide, both run modes, troubleshooting |
| `infra/postgres.Dockerfile` | Postgres 17 + pgvector + PostGIS image |
| `infra/signals-bootstrap.Dockerfile` | one-shot schema + `db:init` tools image |

> Local dev only — plain-HTTP host ports. It builds only this repo (build
> contexts are `..`), so no other checkout is required. The repo-root
> `docker-compose.yaml` (db + redis only) remains for the hand-rolled hybrid
> flow; this folder is the batteries-included alternative.
