---
title: Architecture Diagrams
description: C4-style runtime, item, network fetch, action, event, and deployment diagrams for DPG backends.
head: []
---

DPG is a decentralized, schema-driven Digital Public Good backend.

Stack: Fastify/Node.js, TypeScript ESM, PostgreSQL with Drizzle ORM, Redis, Better Auth, Docker, and Dokploy.

## 1. System Architecture

Each DPG instance owns its own PostgreSQL and Redis. The Network Schema is the shared runtime contract fetched and cached locally by each instance. Instances communicate only over HTTPS APIs, never through a shared database.

```mermaid
flowchart TB
    Browser["Browser client"]
    UI["apps/ui - React + Vite"]
    Browser -->|HTTPS| UI

    subgraph SharedContract["Network Schema - shared runtime contract"]
        NS["name · domains · instances\nitem_schemas · actions\nrequirement_schema · event_schema · cache TTLs"]
    end

    subgraph IA["DPG Instance A"]
        direction TB
        API_A["apps/api - Fastify/Node.js REST API"]
        AUTH_A["packages/auth - Better Auth\nAPI key tier + session tier"]
        CACHE_A["Disk schema cache\nNetwork Schema + item schemas"]
        PG_A[("dpg-db - PostgreSQL\nitems · item_actions · action_events")]
        RD_A[("dpg-redis - Redis\nfetch cache · count cache")]
        API_A -->|auth_middleware_if_enabled| AUTH_A
        API_A -->|validate item_state, resolve item_type schema| CACHE_A
        API_A -->|durable read/write| PG_A
        API_A -->|cache read/write| RD_A
    end

    subgraph IB["DPG Instance B"]
        direction TB
        API_B["apps/api - Fastify/Node.js"]
        PG_B[("PostgreSQL")]
        RD_B[("Redis")]
        CACHE_B["Disk schema cache"]
        API_B --> PG_B
        API_B --> RD_B
        API_B --> CACHE_B
    end

    subgraph IC["DPG Instance C"]
        direction TB
        API_C["apps/api - Fastify/Node.js"]
        PG_C[("PostgreSQL")]
        RD_C[("Redis")]
        CACHE_C["Disk schema cache"]
        API_C --> PG_C
        API_C --> RD_C
        API_C --> CACHE_C
    end

    UI -->|HTTPS REST| API_A
    API_A -->|"HTTPS: /network/item/count_local, /network/item/fetch_local, /network/action/perform, /event/store"| API_B
    API_A -->|"HTTPS: same endpoints"| API_C

    CACHE_A -.->|fetched and cached from| NS
    CACHE_B -.->|fetched and cached from| NS
    CACHE_C -.->|fetched and cached from| NS
```

## 2. Item Creation Flow

Client submits `item_state` against a typed domain. Auth is verified, the Network Schema confirms the domain binding and resolves the item type's JSON Schema, `item_state` is validated, and the item is durably written to PostgreSQL.

```mermaid
sequenceDiagram
    participant UI as Browser/UI client
    participant API as Instance A - API
    participant AUTH as Better Auth
    participant SCHEMA as Network Schema cache
    participant PG as PostgreSQL (items)

    UI->>API: POST /api/v1/item/create
    Note over UI,API: {network, domain, item_type, item_state}

    API->>AUTH: Verify x-api-key or session cookie
    AUTH-->>API: Auth confirmed - user attached to request

    API->>SCHEMA: Check network/domain binding served by this instance
    SCHEMA-->>API: Binding confirmed

    API->>SCHEMA: Resolve item_type in domain.item_schemas
    SCHEMA-->>API: Concrete JSON Schema for item_type

    Note over API: Validate item_state against JSON Schema (Zod/JSON Schema validation)

    Note over API: Generate item_instance_url and item_schema_url

    API->>PG: INSERT INTO items
    Note over PG: item_network, item_domain, item_type, item_id, item_state JSONB,<br/>item_instance_url, item_schema_url, created_by

    PG-->>API: Created item row
    API-->>UI: 201 Created - item payload
```

## 3. Inter-instance Network Item Fetch Flow

Instance A acts as aggregator. It checks Redis first, discovers peers from Network Schema `instances[]`, fans count and fetch requests out in parallel, merges results, and caches the merged page honoring `minimum_cache_ttl_seconds`.

```mermaid
sequenceDiagram
    participant UI as Browser/UI client
    participant A as Instance A (aggregator)
    participant RD as Redis - Instance A
    participant NS as Network Schema cache
    participant B as Instance B
    participant C as Instance C

    UI->>A: GET /api/v1/network/item/fetch
    Note over UI,A: {network, domain, filters, page, limit}

    A->>RD: GET cache key
    alt Cache hit
        RD-->>A: Cached page result
        A-->>UI: Return cached network items
    else Cache miss
        RD-->>A: nil

        A->>NS: Read instances[] for network/domain
        NS-->>A: instance_url list for A, B, C

        par Fan-out count_local in parallel
            A->>A: POST /api/v1/network/item/count_local (self)
        and
            A->>B: POST /api/v1/network/item/count_local
            B-->>A: {count: N}
        and
            A->>C: POST /api/v1/network/item/count_local
            C-->>A: {count: M}
        end

        Note over A: Exclude zero-count instances. Calculate page offsets across peer counts.

        par Fan-out fetch_local - contributing instances only
            A->>B: POST /api/v1/network/item/fetch_local
            B-->>A: items[]
        and
            A->>A: Fetch own local items
        end

        Note over A: Merge item arrays from all instances

        A->>NS: Read minimum_cache_ttl_seconds
        NS-->>A: TTL value

        A->>RD: SET cache key = merged result (TTL)

        A-->>UI: Merged network-wide items[]
    end
```

## 4. Cross-instance Action Perform Flow

Source instance validates eligibility and `requirements_snapshot` against the `requirement_schema` from the Network Schema, resolves the target instance URL via `instances[]`, then forwards the action over HTTPS. The target stores the action row and initial event.

```mermaid
sequenceDiagram
    participant UI as Source user (UI)
    participant SRC as Source Instance A - API
    participant AUTH_S as Better Auth (A)
    participant NS_S as Network Schema cache (A)
    participant TGT as Target Instance B - API
    participant PG_T as PostgreSQL (B)

    UI->>SRC: POST /api/v1/action/perform
    Note over UI,SRC: {action_type, source_item_id, target_item_id, requirements_snapshot}

    SRC->>AUTH_S: Verify x-api-key or session
    AUTH_S-->>SRC: Auth confirmed

    SRC->>NS_S: Confirm source domain served by this instance
    NS_S-->>SRC: Domain confirmed

    SRC->>NS_S: Load actions[action_type].interactions[]
    NS_S-->>SRC: Interaction definitions (from_items, to_items, schemas)

    Note over SRC: Validate source/target item_type eligibility against interactions[].from_items and to_items

    SRC->>NS_S: Load requirement_schema for matched interaction
    NS_S-->>SRC: requirement_schema (JSON Schema)

    Note over SRC: Validate requirements_snapshot against requirement_schema

    SRC->>NS_S: Resolve target instance URL from instances[]
    NS_S-->>SRC: target_instance_url (Instance B)

    SRC->>TGT: POST /api/v1/network/action/perform
    Note over SRC,TGT: {action_type, source routing, target routing, requirements_snapshot}

    Note over TGT: Validate requirements_snapshot against requirement_schema

    TGT->>PG_T: INSERT INTO item_actions
    Note over PG_T: action_id, action_type, source and target routing,<br/>requirements_snapshot JSONB, action_status, update_count

    TGT->>PG_T: INSERT initial row into action_events

    PG_T-->>TGT: Saved action and initial event
    TGT-->>SRC: 201 Created - action details
    SRC-->>UI: Action created response
```

## 5. Action Status Update and Event Mirroring Flow

Target-side user updates the action status. The event is validated against `event_schema`, stored, and mirrored back to the source instance at `/event/store`. Both instances end with a synchronized `action_events` history.

```mermaid
sequenceDiagram
    participant UI_T as Target user (UI)
    participant TGT as Target Instance B - API
    participant AUTH_T as Better Auth (B)
    participant NS_T as Network Schema cache (B)
    participant PG_T as PostgreSQL (B)
    participant SRC as Source Instance A - API
    participant PG_S as PostgreSQL (A)

    UI_T->>TGT: POST /api/v1/action/update-status
    Note over UI_T,TGT: {action_id, action_status, event_payload}

    TGT->>AUTH_T: Verify auth
    AUTH_T-->>TGT: Confirmed

    TGT->>PG_T: SELECT item_actions WHERE action_id
    PG_T-->>TGT: Existing action row

    Note over TGT: Increment update_count

    TGT->>NS_T: Load event_schema for action interaction
    NS_T-->>TGT: event_schema (JSON Schema)

    Note over TGT: Validate event_payload against event_schema

    TGT->>PG_T: UPDATE item_actions (action_status, update_count)
    TGT->>PG_T: INSERT INTO action_events

    PG_T-->>TGT: Saved

    alt Source instance differs from target - cross-instance mirror
        TGT->>SRC: POST /api/v1/event/store
        Note over TGT,SRC: {mirrored event_payload, action routing}

        Note over SRC: Validate mirrored event_payload against event_schema

        SRC->>PG_S: INSERT INTO action_events (mirrored event)
        PG_S-->>SRC: Saved
        SRC-->>TGT: 200 OK
    end

    TGT-->>UI_T: 200 OK - status updated

    Note over PG_T,PG_S: Both instances now hold synchronized event history
```

## 6. Deployment Architecture

Each DPG instance is an independent Docker Compose deployment. The three services share a private container network. Persistent volumes back both Postgres and Redis. External HTTPS reaches only the API container; peer-to-peer calls traverse the public network using HTTPS instance URLs.

```mermaid
flowchart TB
    subgraph Internet["Public internet"]
        Browser["Browser / UI client\nHTTPS"]
        PeerB["Peer Instance B API\nHTTPS"]
        PeerC["Peer Instance C API\nHTTPS"]
    end

    subgraph Deploy["DPG Instance - Docker Compose deployment"]
        direction TB

        subgraph ContainerNet["Container network (dpg-network) - internal only"]
            direction TB
            API["dpg-api - Fastify Node.js\nport :3000 exposed via reverse proxy as :443\nLoads env config, network/domain bindings,\nNetwork Schema; serves full REST API"]
            DB["dpg-db - PostgreSQL 18 alpine\nport 5432 internal\nitems, item_actions, action_events, auth tables"]
            REDIS["dpg-redis - Redis 7.2 alpine\nport 6379 internal\nfetch/count page cache, session cache"]
            DISK["Disk schema cache\n/app/schema-cache\nNetwork Schema + custom item schemas"]
            API -->|"POSTGRES_URL (internal)"| DB
            API -->|"REDIS_URL (internal)"| REDIS
            API -->|"fs read/write via refetch_schemas"| DISK
        end

        subgraph Volumes["Persistent volumes - durable storage"]
            PG_VOL[("dpg-postgresdb\nPostgres volume")]
            RD_VOL[("dpg-redis\nRedis volume")]
        end

        DB --> PG_VOL
        REDIS --> RD_VOL
    end

    Browser -->|"HTTPS :443 REST API calls"| API
    API -->|"HTTPS: /network/item/count_local, /network/item/fetch_local, /network/action/perform, /event/store"| PeerB
    API -->|"HTTPS: same endpoints"| PeerC
```

## 7. Architectural Boundary Notes

### Schema contract boundary

The Network Schema is the single shared contract: item type validity, action rules, peer discovery, and cache TTLs. Each instance fetches and caches it locally on disk. It is not a central runtime service unless externally hosted.

### Instance isolation boundary

Every DPG instance owns its PostgreSQL and Redis exclusively. No cross-instance DB access occurs. Peers communicate only via four defined HTTP endpoints: `count_local`, `fetch_local`, `network/action/perform`, and `event/store`.

### Cache vs durable storage boundary

PostgreSQL stores durable facts: `items`, `item_actions`, and `action_events`. Redis holds short-lived fetch/count page cache. Disk holds fetched schema files. Redis TTLs respect `minimum_cache_ttl_seconds` from the Network Schema.

### API-to-API communication boundary

All inter-instance calls are HTTPS using `instance_url` values from `instances[]`. The aggregating instance fans out to peers but never queries their databases. Each peer responds only from its own local Postgres store.

### Auth boundary

Auth is evaluated via `auth_middleware_if_enabled`. Two tiers are supported: API key auth through the `x-api-key` header for machine-to-machine callers, and session auth through cookies for browser clients. API key auth has highest priority. Auth can be disabled per config. Inter-instance internal endpoints use separate trust conventions.

:::note[Assumption]
Diagram 4 shows the target instance re-validating `requirements_snapshot` against its own schema cache. The source also validates before forwarding. If the target defers to the source's pre-validation instead, that step on the target side should be removed.
:::
