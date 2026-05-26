---
title: Actions And Events
description: Action creation, target-side storage, status updates, and event mirroring.
head: []
---

Actions model interactions between items. Events record action creation and status changes.

## Routes

```text
POST /api/v1/action/perform
GET  /api/v1/action/fetch
POST /api/v1/action/update-status
GET  /api/v1/action/:actionId/contact-details
GET  /api/v1/event/fetch
POST /api/v1/event/store
POST /api/v1/network/action/perform
```

## Perform Action

`POST /api/v1/action/perform` is called on the source item instance.

The route:

- checks the source item domain is served locally
- fetches the local source item snapshot
- validates the target domain and target instance URL against the network config
- forwards the request to the target instance's `POST /api/v1/network/action/perform`

## Target-Side Action Creation

`POST /api/v1/network/action/perform` is called on the target item instance.

The route:

- checks the target domain is served locally
- validates the action interaction from source domain to target domain
- validates `requirements_snapshot` against `requirement_schema`
- fetches the target item snapshot
- creates action and event partitions when needed
- inserts the action
- inserts the initial event
- mirrors the event back to the source instance when needed

## Fetch Actions

`GET /api/v1/action/fetch` returns actions visible to the authenticated user.

Filters include:

- `action_id`
- `action_type`
- `action_status`
- `item_id`
- `ownership_role`
- `limit`
- `offset`

`ownership_role` can be `all`, `initiated`, or `received`.

## Update Status

`POST /api/v1/action/update-status` updates an existing target-side action.

It:

- increments `update_count`
- updates `action_status`
- stores a new action event
- validates event payload against `event_schema` when configured
- mirrors the event to the source instance when needed

## Contact Details (PII Reveal)

`GET /api/v1/action/:actionId/contact-details` reveals the other actor's merged item state (public + private fields) when the action is in a network-declared reveal-eligible status.

The route:

- resolves the action and determines the caller's role (source or target side)
- checks the action status against the network config `reveals_pii_on_status` list
- merges the public and private snapshots of the counterpart item
- records an audit row in `pii_reveal_audit`

Returns `403 PII_NOT_REVEALED` when the current status has not been declared reveal-eligible by the network config.

## Fetch Events

`GET /api/v1/event/fetch` returns action events visible to the authenticated user. It uses the same ownership snapshot model as action fetch.

## Store Mirrored Event

`POST /api/v1/event/store` stores an event mirrored from another instance. It validates the event request against the configured network action interaction.
