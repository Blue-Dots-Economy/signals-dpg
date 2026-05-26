---
title: Route Reference
description: Compact list of current API route groups and endpoint purposes.
head: []
---

## Health And Docs

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Health, served domains, network config source |
| `GET` | `/api/reference` | Scalar API reference |
| — | `/api/auth/*` | Better Auth handler |

## Items

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/item/create` | Create local item |
| `GET` | `/api/v1/item/fetch` | Fetch local items |
| `PATCH` | `/api/v1/item/:itemId` | Update owned item |

## Actions

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/action/perform` | Source-side action request |
| `GET` | `/api/v1/action/fetch` | Fetch owned actions |
| `POST` | `/api/v1/action/update-status` | Update target-side action status |
| `GET` | `/api/v1/action/:actionId/contact-details` | Reveal contact details for an action in a reveal-eligible status |
| `POST` | `/api/v1/network/action/perform` | Target-side action creation |

## Events

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/event/fetch` | Fetch owned events |
| `POST` | `/api/v1/event/store` | Store mirrored event |

## Network Items

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/network/item/fetch` | Fetch items across registered instances |
| `POST` | `/api/v1/network/item/count_local` | Internal local count for network fetch |
| `POST` | `/api/v1/network/item/fetch_local` | Internal local page fetch for network fetch |

## Network Schemas

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/network/schemas` | List cached schemas |
| `GET` | `/api/v1/network/schema/:network/:domain/:itemType` | Fetch one concrete item schema |
| `POST` | `/api/v1/network/refetch_schemas` | Refresh network/schema cache |
