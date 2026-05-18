---
title: Network Schema Reference
description: Reference documentation for DPG network schema structure and current runtime behavior.
head: []
---

The DPG network schema is a runtime contract.

## Top-Level Shape

```json
{
  "id": "blue_dot",
  "display_name": "Blue Dot",
  "description": "Jobs and hiring network.",
  "schema_standard": "https://json-schema.org/draft/2020-12/schema",
  "domains": [],
  "instances": [],
  "actions": {}
}
```

## Top-Level Fields

| Field | Required | Runtime use |
|-------|----------|-------------|
| `id` | yes | API payload network id and default action network |
| `display_name` | no | UI/network display label |
| `description` | no | Human-readable context |
| `schema_standard` | no | JSON Schema draft reference |
| `domains` | yes | Domain, item schema, and cache contract |
| `instances` | yes | Instance discovery and action target validation |
| `actions` | yes | Allowed interactions and payload validation |

## Domain Fields

Each domain entry should expose an `item_schemas` map keyed by schema identifier.

It can also define `minimum_cache_ttl_seconds` for inter-instance item fetch caching.

Example:

```json
{
  "id": "student",
  "minimum_cache_ttl_seconds": 300,
  "item_schemas": {
    "profile_1.0": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object"
    },
    "profile_1.1": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object"
    }
  }
}
```

`default_item_schemas` is still accepted for backward compatibility. At runtime, `default_item_schemas` is merged first and `item_schemas` wins on duplicate keys. Prefer `item_schemas` for new network documents.

## Instance Fields

If a specific instance needs to override the payload for a supported `item_type`, it should publish a `custom_item_schema_urls` map:

```json
{
  "domain_id": "tutor",
  "instance_url": "https://tutor.yellowdot.example.com",
  "custom_item_schema_urls": {
    "profile_1.1": "https://tutor.yellowdot.example.com/schemas/profile_1.1.json"
  }
}
```

`schema_url` is also accepted as a compatibility shortcut for the `profile` item type. During parsing it is converted into `custom_item_schema_urls.profile`.

## Action Fields

Actions define interaction rules.

```json
{
  "connect": {
    "interactions": [
      {
        "from_network": "yellow_dot",
        "from_domain": "student",
        "from_items": ["profile_1.0"],
        "to_network": "yellow_dot",
        "to_domain": "tutor",
        "to_items": ["profile_1.0"],
        "requirement_schema": { "...": "..." },
        "event_schema": { "...": "..." }
      }
    ]
  }
}
```

`from_network` and `to_network` are optional. When omitted, the current network id is used. `from_items` and `to_items` restrict the allowed source and target item types; omit them only when all item types for the domains are allowed.

## Runtime Usage In DPG

API-enforced behavior:

- `POST /api/v1/item/create` checks that `item_type` exists in `domains[].item_schemas`
- `POST /api/v1/item/create` validates `item_state` and generates `item_instance_url` and `item_schema_url`
- `GET /api/v1/item/fetch` is instance-local
- `GET /api/v1/network/item/fetch` is inter-instance and honors `minimum_cache_ttl_seconds`
- `POST /api/v1/action/perform` validates item-type eligibility and `requirements_snapshot` against `requirement_schema`
- `POST /api/v1/network/action/perform` creates the target-side action and initial event
- `POST /api/v1/action/update-status` validates generated event payloads against `event_schema`
- `POST /api/v1/event/store` validates mirrored event payloads against `event_schema`
- `GET /api/v1/network/schemas` returns cached schema documents
- `GET /api/v1/network/schema/:network/:domain/:itemType` exposes one concrete schema
- `POST /api/v1/network/refetch_schemas` refreshes schema cache

UI-interpreted behavior:

- `domains[]` drives the sidebar and create-profile domain choices
- `item_schemas` drive forms and cards
- `private: true` hides fields on public cards and map markers
- action `requirement_schema` drives action modal forms
- the current UI focuses on `connect`, though the schema/API model supports multiple action types
