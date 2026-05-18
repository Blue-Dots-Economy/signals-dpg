---
title: Schema-Generated Parts
description: What the UI autoloads and renders from DPG network schemas.
head: []
---

The UI loads network config documents from the API and renders most domain behavior from that data.

| Network schema source | UI behavior |
|-----------------------|-------------|
| `network.id` | API context, item requests, action payloads |
| `display_name` | Network selector label |
| `description` | Optional user-facing context |
| `domains[]` | Sidebar domain list and create-profile role choices |
| `domains[].description` | Human-readable domain labels |
| `domains[].item_schemas` | Profile forms, card fields, map marker public data |
| `instances[]` | Instance metadata available to create/fetch flows |
| `actions.*.interactions[]` | Visible target domains and available action buttons for the current source domain |
| `requirement_schema` | Dynamic action form in the modal/drawer |
| `event_schema` | Stored in action metadata; not yet rendered as a full event UI |
| JSON Schema `$ref` | Expanded before rendering through `resolveNetworkRefs()` / `resolveRefs()` |
| property `private: true` | Hidden from public cards and map markers |
| `x-import-aliases`, `x-import-paths`, `x-wallet-aliases` | Extra field names the import mapper can use when matching wallet or DigiLocker payloads into the form |

## Forms

`SchemaForm` renders `domains[].item_schemas` with RJSF and AJV8.

Generated behavior:

- field order follows schema property order
- `format: "date"` uses `DatePickerWidget`
- `format: "email"` gets an email placeholder
- string enums get select-style placeholder behavior
- `private: true` fields are hidden in compact mode

## Cards

`DomainCard` and `CardFieldsFromSchema` render item cards from schema properties. Public cards filter out fields marked `private: true`.

The component does not need domain-specific code if it receives:

- the JSON Schema
- the item state data
- optional action metadata

## Actions

Action modals render `requirement_schema` dynamically. When an action has no requirement schema, the UI can submit an empty requirements object.

`HomePage` walks every entry in `network.actions` and matches `interactions` by `from_domain` and `to_domain`, so the list UI can render any configured action type without a dedicated `connect` code path.

## Import Mapping

Credential import does not render from the network schema directly, but it does depend on schema metadata when mapping imported values into a form.

- every schema property is matched against its raw property name plus normalized `snake_case`, `camelCase`, and alphanumeric-only variants
- optional `x-import-aliases`, `x-import-paths`, and `x-wallet-aliases` extensions let a project describe provider-specific field names without changing UI code
- number and integer fields are coerced from strings when the schema expects a numeric value
- unmatched imported fields are retained as skipped values for user feedback instead of silently failing
