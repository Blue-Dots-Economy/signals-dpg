# DPG

DPG is a network-aware backend for publishing, validating, discovering, and interacting with schema-typed items across many independent instances.

> 📚 **Documentation**: https://blue-dots-economy.github.io/bluedots-docs/ — source at [Blue-Dots-Economy/bluedots-docs](https://github.com/Blue-Dots-Economy/bluedots-docs)
>
> 🚀 **Getting started locally?** `SETUP.md` is the step-by-step local walkthrough (Signals API + UI, plus the optional aggregator-dpg integration). The Quick Start below is the condensed version.

The core model is:

- a network defines the shared contract
- a domain defines a role inside that network
- an instance serves one or more domains
- an item is a versioned schema-typed record
- an action is an interaction between items
- an event is the structured result of that action

This repository contains the current DPG API runtime, schema-driven UI app, example network schemas, and shared packages.

## Repository Layout

- `apps/api`: Fastify API runtime
- `apps/ui`: schema-driven React UI for browsing domains, creating items, and triggering actions
- `examples/schemas`: example network definitions such as `yellow_dot`, `blue_dot`, `purple_dot`, and `orange_dot`, each with a `network.json` and a companion `consent.json` (terms/privacy/profile/action consent copy; brand overrides live in sub-folders)
- `examples/api`: example request payloads in Markdown
- `packages/config`: env parsing, network config loading, and consent config loading
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
- `/api/v1/match-score`
- `/api/v1/consent` — user- and item-level consent capture (terms/privacy, profile creation, per-action)
- `/api/v1/admin` — service-to-service admin surface (requires `x-acting-org-id`)
- `/api/v1/aggregator`

Important behavior:

- `POST /api/v1/item/create` creates an item on the current instance (accepts an optional `consent` block for profile-creation acceptance)
- `GET /api/v1/item/fetch` fetches items from the current instance only
- `GET /api/v1/network/item/fetch` performs inter-instance fetch for a network/domain
- `GET /api/v1/network/schema/:network/:domain/:itemType` returns one concrete item schema
- `GET /api/v1/network/schemas` returns cached schemas known to the instance (now includes `consent_config` entries)
- `POST /api/v1/network/refetch_schemas` refreshes schema cache
- `GET`/`POST /api/v1/consent/*` reads and records consent; the accepted document **version is always derived server-side** from the loaded `consent.json`, never trusted from the client
- `POST /api/v1/admin/participant/decrypt` returns decrypted participant profile `item_state` for owned items (aggregator scoped to items it onboarded; `network_service` scoped to its served networks)

Item typing is schema-driven. `item_type` is not arbitrary; it should be a schema identifier defined by the network, for example `profile_1.0` or `profile_1.1`.

## UI App

The UI app lives in `apps/ui`. It is a React 19 + Vite frontend that renders pages from network and item schemas instead of hard-coding per-domain forms and cards.

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

There is a **single `.env` at the repo root** covering the API, database, cache,
and the UI (`VITE_*`). Copy it and it works out of the box for a local `blue_dot`
run — no edits required:

```bash
cp .env.example .env
```

The values that matter most (all pre-filled in `.env.example`):

```bash
INSTANCE_ENV="development"
API_DOMAIN="http://localhost"
API_PORT="2742"
SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"
NETWORK_CONFIG_SOURCE="local"
# Path is resolved from apps/api/, so it must start with ../../
NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/blue_dot/network.json"
POSTGRES_HOST="127.0.0.1"
POSTGRES_PORT=5432
REDIS_HOST="127.0.0.1"
REDIS_PORT=5555
# Required: base64-encoded 32 bytes (AES-256) used to encrypt participant PII.
# A working dev key is pre-filled; generate a fresh one for any deployed env:
#   openssl rand -base64 32
SIGNALS_PII_KEY='<replace-me>'
```

Consent documents are loaded from a `consent.json` beside the active
`network.json` (`CONSENT_CONFIG_SOURCE=local` by default).

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

### 4. Set up the database (first time only)

```bash
pnpm db:push:api           # apply better-auth + Drizzle schema (may prompt to confirm)
pnpm db:init:api           # create partitioned items / actions / events tables
pnpm db:seed:services:api  # mint the service user + apikey (idempotent)
```

See `SETUP.md` for the full walkthrough and the aggregator integration steps.

### 5. Start the API

```bash
pnpm dev:api
```

To run the API itself as a container against the Compose PostgreSQL and Redis services:

```bash
docker compose up -d db redis
DOCKER_NETWORK=dpg_internal pnpm docker:api
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
- `pnpm db:generate:api`
- `pnpm db:migrate:api`
- `pnpm db:push:api`
- `pnpm db:init:api` — create partitioned items / actions / events tables
- `pnpm db:seed:services:api` — mint the service user + apikey
- `pnpm db:seed:purple_dot:api` — seed purple_dot sample data
- `pnpm db:studio:api`
- `pnpm dev:ui`
- `pnpm build:ui`
- `pnpm preview:ui`
- `pnpm dev:tourist` / `pnpm build:tourist` — the tourist (OneTAC) UI build variant
- `pnpm typecheck`
- `pnpm schema:bundle` — regenerate `apps/api/db/postgres/schema.sql` from the Drizzle schema

## Examples

Local schema examples:

- `examples/schemas/yellow_dot/network.json`
- `examples/schemas/blue_dot/network.json`

API payload examples:

- `examples/api/yellow_dot.md`
- `examples/api/blue_dot.md`

## Service Integrations

DPG treats notification delivery and match scoring as replaceable service integrations behind package-level clients.

- Notification service: [signals-dpg-notification-service](https://github.com/Blue-Dots-Economy/notification-service)
- Match score service client: [signals-dpg-match-engine](https://github.com/Blue-Dots-Economy/match-engine)

## Fetch Model

DPG uses two fetch paths:

- `GET /api/v1/item/fetch`: instance-local fetch, intended for local reads such as a user's own items; cached briefly in Redis
- `GET /api/v1/network/item/fetch`: inter-instance fetch, which performs count-first discovery, selects only relevant peer instances, then fetches the required slices and caches the result in Redis

## Consent

Consent Management v1 records participant consent as an append-only ledger
(`consent_record`) across three levels:

- **User-level** — terms of service and privacy policy (`/api/v1/consent`).
- **Item-level** — profile-creation consent, captured with the profile item
  (`create_item` accepts an optional `consent` block).
- **Action-level** — per-action consent at `initiate` and `accept` stages of
  interactions such as `connect` and `apply`.

Consent copy lives in a `consent.json` beside each network's `network.json`
(brand overrides in a brand-named sub-folder), is loaded via
`CONSENT_CONFIG_SOURCE` (`local` by default) and cached alongside network
schemas. The **document version recorded in the ledger is always resolved
server-side** from the loaded config for the `(network, brand, category[,
actionType, stage])` tuple — the client cannot record acceptance of a version it
never saw. This replaces the old inline `consent_text_initiator` /
`consent_text_receiver` fields that used to live in `network.json` action
definitions.

## Notes

- `item_type` values should come from the network schema, not from freeform client input.
- The backend generates `item_instance_url` and `item_schema_url` during item creation.
- Inter-instance schema fetching and caching are part of the network layer, not the item-local layer.
