---
title: API Overview
description: How the DPG API is organized and where to find focused API guides.
head: []
---

The DPG API lives in `apps/api`. It is a Fastify service that uses the network schema as runtime contract for item validation, inter-instance reads, action creation, action events, and schema discovery.

## What The API Does

- validates requests with Zod through `fastify-type-provider-zod`
- exposes OpenAPI and Scalar docs at `/api/reference`
- stores items, actions, and events in PostgreSQL
- uses Redis for short-lived fetch caches
- loads network configs from local files, remote URLs, or schema registry URLs
- validates `item_state`, action requirements, and event payloads with JSON Schema
- supports one backend serving one or many `network/domain` bindings
- supports cross-instance item fetch and action/event mirroring

## Guide Pages

| Page | Use it for |
|------|------------|
| [Running And Docker](/apps/api/running) | Local commands, Docker image, and runtime env |
| [Auth](/apps/api/auth) | Auth middleware behavior and Better Auth mount points |
| [Items](/apps/api/items) | Create, fetch, update, validation, ownership, and partitions |
| [Network Fetch](/apps/api/network-fetch) | Inter-instance item fetch, count/fetch local endpoints, and caching |
| [Actions And Events](/apps/api/actions-events) | Action creation, target-side storage, status updates, event mirroring |
| [Schemas And Cache](/apps/api/schemas-cache) | Network schemas, custom schemas, cache refresh, and schema routes |
| [Route Reference](/apps/api/route-reference) | Compact list of mounted API endpoints |

## Mounted Route Groups

```text
GET /
/api/auth/*
/api/v1/item/*
/api/v1/action/*
/api/v1/event/*
/api/v1/network/*
```

The root endpoint returns service health plus the served domain bindings and network config source.

## Current Constraints

- protected routes require auth unless local development disables auth middleware
- production always enables auth middleware
- `SERVED_DOMAINS` decides which `network/domain` pairs an instance may serve
- network-wide fetch relies on `instances[]` in the network config
- action validation relies on `actions[<name>].interactions`
- the current UI focuses on `connect`, but the API can accept any configured action type
