# DPG

DPG is a network-aware backend for publishing, validating, discovering, and interacting with schema-typed items across many independent instances.

The core model is:

- a network defines the shared contract
- a domain defines a role inside that network
- an instance serves one or more domains
- an item is a versioned schema-typed record
- an action is an interaction between items
- an event is the structured result of that action

This repository contains the current DPG API runtime, schema-driven UI app, docs site, example network schemas, and shared packages.

## Repository Layout

- `apps/api`: Fastify API runtime
- `apps/docs`: documentation site
- `apps/ui`: schema-driven React UI for browsing domains, creating items, and triggering actions
- `examples/schemas`: example network definitions such as `yellow_dot` and `blue_dot`
- `examples/api`: example request payloads in Markdown
- `packages/config`: env parsing and network config loading
- `packages/database`: database helpers and partitioning
- `packages/schemas`: API request schemas and network schema parsing
- `packages/auth`: auth integration
- `packages/notification`: notification service client for OTP and outbound messages
- `packages/match_score`: match score service client for item comparison

## Current API Shape

Main route groups:

- `/api/v1/item`
- `/api/v1/action`
- `/api/v1/event`
- `/api/v1/network`

Important behavior:

- `POST /api/v1/item/create` creates an item on the current instance
- `GET /api/v1/item/fetch` fetches items from the current instance only
- `GET /api/v1/network/item/fetch` performs inter-instance fetch for a network/domain
- `GET /api/v1/network/schema/:network/:domain/:itemType` returns one concrete item schema
- `GET /api/v1/network/schemas` returns cached schemas known to the instance
- `POST /api/v1/network/refetch_schemas` refreshes schema cache

Item typing is schema-driven. `item_type` is not arbitrary; it should be a schema identifier defined by the network, for example `profile_1.0` or `profile_1.1`.

## UI App

The UI app lives in `apps/ui`. It is a React 19 + Vite frontend that renders pages from network and item schemas instead of hard-coding per-domain forms and cards.

Source: [`apps/ui` on GitHub](https://github.com/dhiway/dpg-monorepo/tree/main/apps/ui). Documentation: `/apps/ui` in the docs app.

Current UI responsibilities:

- browse items by domain
- create and edit schema-driven profiles
- render public item cards
- trigger action flows
- show map-based views through a pluggable map provider layer

UI runtime envs:

- `VITE_API_URL`: base URL of the API app
- `VITE_MAP_PROVIDER`: active map provider, default `leaflet`
- `VITE_GEOCODING_API_URL`: optional geocoding override

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Start from `.env.example` and set at least:

```bash
INSTANCE_ENV="development"
API_DOMAIN="http://localhost"
API_PORT="2742"
SERVED_DOMAINS="yellow_dot/student"
NETWORK_CONFIG_SOURCE="local"
NETWORK_CONFIG_LOCAL_FILE="examples/schemas/yellow_dot/network.json"
POSTGRES_HOST="127.0.0.1"
POSTGRES_PORT="5432"
REDIS_HOST="127.0.0.1"
REDIS_PORT="5555"
```

For remote network configs, use:

```bash
NETWORK_CONFIG_SOURCE="remote"
NETWORK_CONFIG_URLS="yellow_dot=https://registry.example.com/schemas/yellow_dot/network.json"
```

Or use `SCHEMA_REGISTRY_URL` with either:

- one base URL
- comma-separated `network=url` mappings

### 3. Start PostgreSQL and Redis

```bash
docker compose up -d db redis
```

### 4. Run database migrations

```bash
pnpm db:migrate:api
```

### 5. Start the API

```bash
pnpm dev:api
```

To run the API itself as a container against the Compose PostgreSQL and Redis services:

```bash
docker compose up -d db redis
DOCKER_NETWORK=dpg_internal pnpm docker:api
```

Optional:

```bash
pnpm dev:docs
```

To run the UI app:

```bash
pnpm dev:ui
```

Typical local UI env:

```bash
VITE_API_URL="http://localhost:2742"
VITE_MAP_PROVIDER="leaflet"
```

## Useful Commands

- `pnpm dev:api`
- `pnpm build:api`
- `pnpm preview:api`
- `pnpm start:api`
- `pnpm db:pull:api`
- `pnpm db:push:api`
- `pnpm db:generate:api`
- `pnpm db:migrate:api`
- `pnpm db:studio:api`
- `pnpm dev:docs`
- `pnpm build:docs`
- `pnpm dev:ui`
- `pnpm build:ui`
- `pnpm preview:ui`

## Examples

Local schema examples:

- `examples/schemas/yellow_dot/network.json`
- `examples/schemas/blue_dot/network.json`

API payload examples:

- `examples/api/yellow_dot.md`
- `examples/api/blue_dot.md`

## Service Integrations

DPG treats notification delivery and match scoring as replaceable service integrations behind package-level clients.

- Notification service: [dhiway/notification-service](https://github.com/dhiway/notification-service.git)
- Match score service client: [`packages/match_score`](https://github.com/dhiway/dpg-monorepo/tree/main/packages/match_score)

## Fetch Model

DPG uses two fetch paths:

- `GET /api/v1/item/fetch`: instance-local fetch, intended for local reads such as a user's own items; cached briefly in Redis
- `GET /api/v1/network/item/fetch`: inter-instance fetch, which performs count-first discovery, selects only relevant peer instances, then fetches the required slices and caches the result in Redis

## Documentation

The full documentation lives in `apps/docs`. A good reading order is:

1. `apps/docs/src/content/docs/index.md`
2. `apps/docs/src/content/docs/concepts/vocabulary.md`
3. `apps/docs/src/content/docs/concepts/architecture.md`
4. `apps/docs/src/content/docs/getting-started.md`
5. `apps/docs/src/content/docs/environment.md`
6. `apps/docs/src/content/docs/schemas/authoring.md`
7. `apps/docs/src/content/docs/apps/api.md`
8. `apps/docs/src/content/docs/apps/ui.md`

The docs cover:

- vocabulary and architecture
- local setup, Docker, Dokploy, and Nixpacks hosting
- single-instance and multi-instance deployment
- schema authoring and versioning
- API behavior
- onboarding new networks and domains

## Notes

- `item_type` values should come from the network schema, not from freeform client input.
- The backend generates `item_instance_url` and `item_schema_url` during item creation.
- Inter-instance schema fetching and caching are part of the network layer, not the item-local layer.
