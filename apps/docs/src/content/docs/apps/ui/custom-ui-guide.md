---
title: Custom UI Guide
description: How to reuse the DPG schema-driven behavior in another frontend.
head: []
---

Use this sequence to build a custom interface that behaves like `apps/ui` without copying its product-specific layout.

## Minimum Flow

1. Fetch network configs from `/api/v1/network/schemas`.
2. Select a network by env, user choice, or first returned config.
3. Resolve JSON Schema `$ref` values before rendering.
4. Render create/edit forms from `domains[].item_schemas`.
5. Hide public fields with the `private: true` convention.
6. Fetch user-owned local items from `/api/v1/item/fetch`.
7. Fetch target browsing items from `/api/v1/network/item/fetch`.
8. Derive allowed actions from `actions[<action_type>].interactions`.
9. Render action requirement forms from `requirement_schema`.
10. Submit actions with source item, target item, and validated `requirements_snapshot`.

## What To Reuse

For fastest implementation, reuse or extract:

- `src/engine/schema/*`
- `src/engine/map/map-registry.ts`
- `src/lib/api-config.ts`
- `src/lib/api-client.ts`
- `src/lib/network-api.ts`
- `src/lib/item-api.ts`
- `src/lib/auth-api.ts`
- `SchemaForm`
- `CardFieldsFromSchema`
- `ActionHandler`
- `ActionModal`
- `MapView`

## What To Replace

Replace these for your own product:

- page layout
- visual component library
- action naming and labels
- domain icons
- title-field heuristics
- profile wording
- default map center
- login screens if you do not use phone OTP

## Multiple Actions

The current UI focuses on `connect`. A general UI should do:

```ts
for (const [actionType, action] of Object.entries(network.actions)) {
  for (const interaction of action.interactions) {
    // render actionType when from/to domains match the active source and target
  }
}
```

Use each interaction's `requirement_schema` to render the form and submit the selected `actionType` to the API.

## Multiple Item Types

The current UI picks the first item schema for a domain. A generic UI should show an item type selector when `Object.keys(domain.item_schemas).length > 1`.

When creating an item, submit:

- `item_network`
- `item_domain`
- selected `item_type`
- form data as `item_state`
- optional coordinates

The backend derives `item_instance_url`, `item_schema_url`, and ownership.
