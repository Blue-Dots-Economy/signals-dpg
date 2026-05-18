---
title: Running And Docker
description: How to run, build, preview, and containerize the API.
head: []
---

## Local Commands

Run the API in watch mode:

```bash
pnpm dev:api
```

Build the API:

```bash
pnpm build:api
```

Preview the built API:

```bash
pnpm preview:api
```

Start the built API:

```bash
pnpm start:api
```

## Required Services

The API expects:

- PostgreSQL
- Redis

For local development:

```bash
docker compose up -d db redis
```

## Docker Image

Run the API container against the Compose PostgreSQL and Redis services:

```bash
docker compose up -d db redis
DOCKER_NETWORK=dpg_internal pnpm docker:api
```

The `docker:api` script builds `dpg-api:local`, normalizes quoted values from
`.env` for Docker, and runs the API container on the `dpg_internal` network.

You can still build the image directly with `docker build -f apps/api/Dockerfile -t dpg-api:local .` when needed.

The Dockerfile:

- uses Node 24 Alpine
- prunes the monorepo with Turbo for the `api` app
- installs dependencies with pnpm
- builds only `apps/api`
- installs production dependencies for the final image
- starts `node apps/api/dist/server.js`

The container listens on `0.0.0.0:${API_PORT}`. `API_PORT` defaults to `2742` in the image.

## Core Runtime Env

| Variable | Purpose |
|----------|---------|
| `INSTANCE_NAME` | Service name returned by health endpoint and used by auth |
| `INSTANCE_ENV` | `development` or `production` |
| `API_DOMAIN` | Public API base domain |
| `API_PORT` | API listen port |
| `AUTH_SECRET` | Better Auth secret |
| `SERVED_DOMAINS` | Comma-separated `network/domain` bindings |
| `NETWORK_CONFIG_SOURCE` | `local` or `remote` |
| `NETWORK_CONFIG_LOCAL_FILE` | Local network config path |
| `NETWORK_CONFIG_URLS` | Remote `network=url` mappings |
| `SCHEMA_REGISTRY_URL` | Registry base URL or explicit mappings |
| `POSTGRES_URL` | Full Postgres URL |
| `REDIS_URL` | Full Redis URL |

Use full `POSTGRES_URL` and `REDIS_URL` in container deployments when possible.
