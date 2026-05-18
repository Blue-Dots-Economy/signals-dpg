---
title: Network Schema Overview
description: A basic explanation of DPG network schemas and what the current API can do with them.
head: []
---

A network schema is the runtime contract for a DPG network. It tells the API and UI what the network is, which roles exist, what each role can publish, where those records are served, and which interactions are allowed.

Think of it as:

```text
Network
  -> Domains
      -> Item types
          -> JSON Schemas for item_state
  -> Instances
      -> Which backend serves which domain
      -> Optional custom schemas
  -> Actions
      -> Allowed from-domain / to-domain pairs
      -> Requirement schema
      -> Event schema
```

## Core Parts

| Part | Meaning |
|------|---------|
| `id` | Stable network id used in API payloads |
| `display_name` | Human-readable network label |
| `domains` | Business roles such as `student`, `tutor`, `seeker`, `provider` |
| `item_schemas` | JSON Schemas for records a domain can publish |
| `instances` | Registered API instances that serve a domain |
| `actions` | Allowed interactions between domains |
| `requirement_schema` | Payload required to request an action |
| `event_schema` | Payload shape for action updates/events |

## What The Current API Supports

When paired with the current API, a network schema supports:

- schema-validated item creation through `POST /api/v1/item/create`
- local item fetch through `GET /api/v1/item/fetch`
- network-wide item fetch through `GET /api/v1/network/item/fetch`
- multi-domain instances through `SERVED_DOMAINS`
- multi-instance discovery through `instances[]`
- instance custom item schemas through `custom_item_schema_urls`
- action creation through `POST /api/v1/action/perform`
- target-side action storage through `POST /api/v1/network/action/perform`
- action status updates through `POST /api/v1/action/update-status`
- action event fetch through `GET /api/v1/event/fetch`
- mirrored event storage through `POST /api/v1/event/store`
- schema cache listing and refresh through `/api/v1/network/schemas` and `/api/v1/network/refetch_schemas`

## What The UI Uses Today

The current UI can autoload:

- networks
- domains
- item schemas
- public card fields
- create/edit forms
- action requirement forms
- map marker data

The UI still has product assumptions:

- it focuses on the `connect` action
- it treats most records as profiles
- it usually picks the first item schema for a domain
- it has field-name heuristics for titles and map locations

The backend contract is more general than the current UI. You can define multiple action types and item types now, but a custom UI may be needed to expose all of them elegantly.
