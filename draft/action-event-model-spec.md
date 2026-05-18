# Action And Event Model Draft Spec

## Status

Draft. This document defines the intended action and event write model for the
API and database. It assumes development-only reset semantics, so no migration
compatibility is required.

## Goals

- Remove the requirement for the caller of `perform_action` to know the
  resulting event payload.
- Make actions target-instance owned.
- Make events the append-only source of truth for analytics and user-visible
  tracking.
- Ensure both source and target sides can track the same action lifecycle.
- Keep schemas consistent between item, action, and event flows.
- Support later queueing, retries, rate limits, and event fan-out without
  changing the core contract.

## Core Model

### Items

- `item` remains the ownership root.
- User ownership is resolved through the item.
- Item schemas may mark properties as `public` or `private`.
- Private item properties are not automatically copied to actions or events.
- If a network manager wants a private item field to appear in an action or
  event, it must be explicitly defined in the action or event schema.

### Actions

- An action is initiated by a source item against a target item.
- The action row is created in the target instance.
- The action belongs to the target instance.
- The action stores current state, not full history.
- One action can emit multiple events over time.

### Events

- Events are append-only timeline records.
- Events are created when an action is created and when an action is updated.
- Events are the source of truth for analytics and for user-facing action
  tracking.
- Both source and target sides should have the event record.
- If source and target belong to the same instance, duplicate event creation
  must not occur.

## Interaction Schema Semantics

Each action interaction definition should support these concepts:

- `requirement_schema` Data the source side must provide to request the action.

- `event_schema` Data stored in the emitted event payload for that action
  lifecycle step.

Rules:

- `perform_action` validates request input against `requirement_schema`.
- Event creation must always succeed even if no `event_schema` is defined.
- If no `event_schema` is defined, the created event uses an empty payload
  `{}``.
- `event_metadata` is removed from the main contract.
- If a free-form note field is needed later, it should be introduced
  deliberately as a narrow field such as `remarks`.

## API Domain Identity

Add:

```env
API_DOMAIN='http://localhost'
```

Rules:

- `API_DOMAIN` is the public domain identity of the running API instance.
- It must be used instead of implicit localhost assumptions when creating item
  source domain references.
- It must be used when deciding whether an event should be mirrored to another
  instance.
- If the source item domain equals the current `API_DOMAIN`, the event must not
  be mirrored because both sides are already local to the same instance.

## Write Flow

### 1. Perform Action

Endpoint: `POST /api/v1/action/perform`

Purpose:

- Validate that the action is allowed.
- Create the action in the target instance.
- Create the initial event locally in the target instance.
- Mirror that event to the source instance only when the source domain differs
  from the current `API_DOMAIN`.

Request body:

```json
{
  "action_type": "connect",
  "source_item": {
    "item_network": "network-a",
    "item_domain": "https://source.example",
    "item_type": "profile",
    "item_id": "uuid"
  },
  "target_item": {
    "item_network": "network-a",
    "item_domain": "https://target.example",
    "item_type": "profile",
    "item_id": "uuid"
  },
  "requirements_snapshot": {}
}
```

Behavior:

1. Validate served-domain rules for the target item.
2. Load the target network config.
3. Resolve the interaction by action type, source network/domain, and target
   network/domain.
4. Validate `requirements_snapshot` against `requirement_schema`.
5. Create an action row in the target instance with initial status.
6. Create the first event row locally with:
   - `action_id`
   - `action_type`
   - `action_status`
   - `update_count = 0`
   - source and target item references
   - source and target lat/lng snapshots
   - event payload from the target-side action result, or `{}` when no event
     schema is defined
7. If `source_item.item_domain !== API_DOMAIN`, call the source instance event
   API with the created event.
8. Return the action record.

Notes:

- The caller must not provide response event payload.
- The caller must not provide response event metadata.
- The target instance is authoritative for action creation.

Suggested response body:

```json
{
  "action_id": "uuid",
  "action_type": "connect",
  "action_status": "created",
  "update_count": 0,
  "source_item_id": "uuid",
  "target_item_id": "uuid"
}
```

### 2. Update Action Status

Endpoint: `POST /api/v1/action/update-status`

Purpose:

- Update the state of an existing action in the target instance.
- Create a follow-up event for the new status.
- Mirror that event to the source instance when required.

Request body:

```json
{
  "action_id": "uuid",
  "action_status": "accepted",
  "event_payload": {},
  "remarks": "optional"
}
```

Behavior:

1. Load the target-owned action row.
2. Increment `update_count`.
3. Update the action status.
4. Validate `event_payload` against the configured `event_schema` when present.
5. If no `event_schema` is defined, allow `{}`.
6. Create a new local event row using the new `update_count`.
7. If the source item domain differs from `API_DOMAIN`, mirror the event to the
   source instance.
8. Return the updated action state.

Notes:

- This is a separate API from `perform_action`.
- This is called by the target instance or target-side business flow after
  action creation.

### 3. Store Or Create Event

Endpoint: `POST /api/v1/event/store`

Purpose:

- Accept an already-created event from another instance.
- Persist it locally if it is not a duplicate.

Request body:

```json
{
  "origin_instance_domain": "https://target.example",
  "action_id": "uuid",
  "action_type": "connect",
  "action_status": "accepted",
  "update_count": 1,
  "source_item": {
    "item_network": "network-a",
    "item_domain": "https://source.example",
    "item_type": "profile",
    "item_id": "uuid"
  },
  "target_item": {
    "item_network": "network-a",
    "item_domain": "https://target.example",
    "item_type": "profile",
    "item_id": "uuid"
  },
  "source_item_latitude": 12.34,
  "source_item_longitude": 56.78,
  "target_item_latitude": 23.45,
  "target_item_longitude": 67.89,
  "event_payload": {},
  "remarks": "optional"
}
```

Behavior:

1. Validate the event shape.
2. Validate `event_payload` against the interaction `event_schema` when present.
3. If no event schema is present, allow `{}`.
4. Deduplicate using the chosen event uniqueness rule.
5. Persist the event locally.

Notes:

- This endpoint is the replication path.
- It can later be fronted by queues, retries, rate limits, or workers.

## Database Model

## `item_actions`

Purpose:

- Store the current state of an action.
- Represent the target-instance authoritative action row.

Suggested columns:

- `action_id uuid primary key`
- `action_type text not null`
- `action_status text not null`
- `update_count integer not null default 0`

- `source_item_network text not null`
- `source_item_domain text not null`
- `source_item_type text not null`
- `source_item_id uuid not null`

- `target_item_network text not null`
- `target_item_domain text not null`
- `target_item_type text not null`
- `target_item_id uuid not null`

- `requirements_snapshot jsonb not null default '{}'::jsonb`
- `remarks text null`
- `created_at timestamp not null`
- `updated_at timestamp not null`

Rules:

- Remove misleading user-link fields from write ownership logic.
- Read-side ownership checks should be done by joining through source or target
  items.
- Action rows belong to the target instance.

Partition naming:

- Partition by `action_type`.
- Example: action `connect` uses partition table `connect_action`.

## `action_events`

Purpose:

- Store the append-only action timeline.
- Serve analytics and user action tracking.

Suggested columns:

- `event_id uuid primary key`
- `origin_instance_domain text not null`

- `action_id uuid not null`
- `action_type text not null`
- `action_status text not null`
- `update_count integer not null`

- `source_item_network text not null`
- `source_item_domain text not null`
- `source_item_type text not null`
- `source_item_id uuid not null`
- `source_item_latitude double precision null`
- `source_item_longitude double precision null`

- `target_item_network text not null`
- `target_item_domain text not null`
- `target_item_type text not null`
- `target_item_id uuid not null`
- `target_item_latitude double precision null`
- `target_item_longitude double precision null`

- `event_payload jsonb not null default '{}'::jsonb`
- `remarks text null`
- `created_at timestamp not null`

Uniqueness:

- Unique key on `origin_instance_domain`, `action_id`, `update_count`

Reason:

- One action can emit multiple events.
- `action_id` alone cannot deduplicate updates.
- `origin_instance_domain` distinguishes local-origin vs mirrored copies and
  supports retry-safe replication.

Partition naming:

- Partition by `action_type` for action-derived events.
- Example: action `connect` uses event partition table `connect_event`.

## Event Payload Rules

- `event_payload` contains the event datapoints defined by the interaction
  `event_schema`.
- If additional action-derived attributes are needed for history and analytics,
  prefer:
  - top-level columns for fields needed in filters, joins, sorting, or
    geospatial queries
  - `event_payload` for flexible action-specific details

Current explicit top-level event fields should include:

- `action_status`
- source item identifiers
- target item identifiers
- source latitude and longitude
- target latitude and longitude

## Deduplication Rules

### Same-instance dedupe

- If the source item domain matches the current `API_DOMAIN`, do not mirror the
  event.
- Local event creation alone is sufficient.

### Cross-instance dedupe

- Mirror events only when the source item domain differs from the current
  `API_DOMAIN`.
- Receiving side deduplicates using:
  - `origin_instance_domain`
  - `action_id`
  - `update_count`

This allows:

- safe retries
- queue retries later
- rate-limited or delayed forwarding
- repeated delivery attempts without duplicate timeline rows

## Read Model

- User ownership must be checked during fetches, not during action or event
  writes.
- Fetch APIs should resolve accessible actions and events through item ownership
  rules.
- Events are the primary read source for tracking history.
- Actions are the primary read source for current state.

## Open Questions

- What exact initial `action_status` should be written by `perform_action`? the
  action_status Candidates should come from the action schema. Candidates:
  `created`, `pending`, `submitted`.

- Should `remarks` exist in both `item_actions` and `action_events`, or only in
  events? yes
- Should event payload validation be skipped entirely when `event_schema` is
  absent, or should only `{}` be accepted? Current recommendation: accept any
  object only if explicitly desired; otherwise default to `{}` and validate only
  when schema exists. go with recommendation
- Should action creation capture source and target lat/lng from live item rows
  at write time, or should callers provide them from already-fetched item
  snapshots? Current recommendation: derive them from authoritative item data at
  write time where possible. derive from the items themselves. source sends it's
  lat and lng extracting it from the item. target extracts it from it's item.

## Summary

The intended model is:

- `perform_action` creates an action in the target instance.
- The target instance immediately creates a local event for that action.
- The target instance mirrors the event to the source instance only when the
  domains differ.
- `update_action_status` creates additional events over time.
- Events form an append-only timeline and analytics source.
- Actions store current state.
- User ownership is resolved at read time through item linkage.
