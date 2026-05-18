---
title: Network Schema Authoring Guide
description: A practical walkthrough for designing a DPG network schema from scratch.
head: []
---

Use this guide when creating a new network schema for a real use case.

## Start With The Business Model

Before writing JSON, answer these questions:

1. What network are you creating?
2. Which actors participate?
3. Which actor records need to be discoverable?
4. Which interactions are allowed?
5. Which payload is needed to request each interaction?
6. Which event/status payload should be produced after the interaction changes?
7. Which instances serve each actor/domain?

## Step 1: Define Domains

Each domain should represent a stable role in the network.

Good examples:

- `student`
- `tutor`
- `seeker`
- `provider`
- `case_worker`
- `farmer`
- `travel_agent`

Avoid making domains too narrow. Use item schema fields for details such as service type, city, category, crop, skill, or subject.

## Step 2: Define Item Types

An `item_type` is the schema id for the record being published.

Use versioned names:

- `profile_1.0`
- `profile_1.1`
- `job_posting_1.0`
- `service_listing_1.0`
- `trip_package_1.0`
- `crop_advisory_request_1.0`

Avoid loose names:

- `profile`
- `job`
- `data`

## Step 3: Add `item_schemas`

Each domain exposes a map of item types to JSON Schemas.

```json
{
  "id": "seeker",
  "minimum_cache_ttl_seconds": 300,
  "item_schemas": {
    "profile_1.0": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": ["name", "skills"],
      "properties": {
        "name": { "type": "string" },
        "skills": {
          "type": "array",
          "items": { "type": "string" }
        },
        "phone": { "type": "string", "private": true }
      }
    }
  }
}
```

Current API behavior:

- `POST /api/v1/item/create` rejects unknown item types
- `item_state` is validated against the selected schema
- missing partitions can be created lazily by the API
- `GET /api/v1/network/schema/:network/:domain/:itemType` exposes the concrete schema

## Step 4: Add Instances

Instances tell the network which API serves a domain.

```json
{
  "domain_id": "provider",
  "instance_name": "Blue Dot Provider",
  "instance_url": "https://provider.bluedot.example.com",
  "custom_item_schema_urls": {
    "job_posting_1.1": "https://provider.bluedot.example.com/schemas/job_posting_1.1.json"
  }
}
```

Current API behavior:

- network fetch discovers instances by domain
- source action calls validate target instance URLs
- `custom_item_schema_urls` can override item schemas per instance

## Step 5: Define Actions

An action defines a named business interaction and one or more allowed domain pairs.

```json
{
  "apply": {
    "description": "A seeker applies to a provider's job posting.",
    "interactions": [
      {
        "from_domain": "seeker",
        "to_domain": "provider",
        "requirement_schema": {
          "type": "object",
          "required": ["job_id", "cover_note"],
          "properties": {
            "job_id": { "type": "string" },
            "cover_note": { "type": "string" }
          }
        },
        "event_schema": {
          "type": "object",
          "required": ["status", "remark"],
          "properties": {
            "status": { "type": "string" },
            "remark": { "type": "string" }
          }
        }
      }
    ]
  }
}
```

Use `requirement_schema` for the request payload. Use `event_schema` for status/event updates.

## Step 6: Add Cache Policy

Every domain can define `minimum_cache_ttl_seconds`.

```json
{
  "id": "provider",
  "minimum_cache_ttl_seconds": 300
}
```

This gives the network administrator a baseline rule for inter-instance item fetch caching.

## Step 7: Test With The API

Use this sequence:

1. configure `SERVED_DOMAINS`
2. set `NETWORK_CONFIG_SOURCE`
3. start the API
4. call `POST /api/v1/network/refetch_schemas`
5. create an item with `POST /api/v1/item/create`
6. fetch local items with `GET /api/v1/item/fetch`
7. fetch network items with `GET /api/v1/network/item/fetch`
8. perform an action with `POST /api/v1/action/perform`
9. update action status with `POST /api/v1/action/update-status`

## Final Authoring Rules

- networks define contracts, not only examples
- domains define stable roles
- `item_type` values are schema identifiers
- actions declare permission and payload shape together
- instances are explicit and enumerable
- cache policy belongs in the network contract
- continuous flows should use multiple action types instead of overloading one action with every step
