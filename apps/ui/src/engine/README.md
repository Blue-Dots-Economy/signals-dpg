# Schema-driven rendering engine

Small (7 files, ~500 LOC) but the highest-leverage code in the UI — every domain in every network flows through this before it becomes a form or a card. Read this before changing anything here; a subtle bug in ref resolution silently breaks every network at once, not just one.

## The type triad (`types.ts`)

- **`DotProfileSchema`** — a domain's item schema, wrapped: `{ schema_type: 'profile', schema: RJSFSchema, ... }`. The wrapper carries metadata (`info`, `name`, `version`, `details.dot`/`details.domain`) alongside the actual JSON Schema.
- **`DotActionSchema`** — an action definition: `{ action_type, from_domain, to_domain, requirement_schema, event_schema?, reveals_pii_on_status? }`.
- **`DotCardConfig`** — the network.json `card` block controlling read-only display: `title_field`/`subtitle_field`/`avatar_from` (which fields drive the heading/avatar), `default_fields` (shown collapsed) vs `extra_fields` (behind "view more"), and `status_rules` (server-evaluated predicates the client only enumerates for the filter panel — it never evaluates the predicate itself).

Everything downstream — form rendering, card rendering, the resolvers below — is built from these three shapes.

## `resolveRefs` vs `resolveNetworkRefs` — both are real, both are used, pick correctly

Two `$ref`-resolution functions exist in `schema/resolve-schema.ts` and **both are in active use** — this is not dead code from a migration, it's two resolvers for two different kinds of document:

- **`resolveNetworkRefs(network, options)`** — walks an arbitrary **network-document** tree (not necessarily schema-shaped). It:
  - detects and unwraps `DotProfileSchema` wrappers (via `extractSchema`) as it recurses,
  - deliberately **skips local JSON Pointers** (`#/...`) rather than resolving them — RJSF resolves `$defs`/`definitions` natively at render time and this resolver doesn't have the schema's own root to resolve against anyway,
  - supports an optional `refMap` (pre-loaded/build-time-embedded schemas, avoiding a fetch).
  - **Used by:** `pages/profile-form-page.tsx`, `pages/home-page.tsx` — anywhere you're resolving a real domain/network config, which can contain profile wrappers and local pointers.

- **`resolveRefs(schema, baseUrl)`** — walks a **plain RJSF schema** (`properties`/`items`/`allOf`/`oneOf`/`anyOf`), resolving `$ref` via straightforward HTTP fetch only. It has **no** `DotProfileSchema` unwrapping and **no** `refMap`, and its internal `resolveRef` helper explicitly throws on a local JSON Pointer (`"Local JSON Pointer resolution not yet supported"`).
  - **Used by:** `components/actions/action-modal.tsx` — action request/response schemas (`requirement_schema`/`event_schema`), which are plain schemas without profile wrappers or local pointers.

**Rule:** if what you're resolving came from a network's domain/profile config, use `resolveNetworkRefs`. If it's a plain schema fragment (e.g. an action's `requirement_schema`) with no wrapper and no local `#/...` refs, `resolveRefs` is fine. Don't reach for `resolveRefs` on network-config data — it will throw the moment it hits a local pointer or a profile wrapper it doesn't know how to unwrap.

Both share the same underlying cache (`schema-loader.ts`'s `getCachedSchema`/`setCachedSchema`, keyed by ref string) and the same `resolveJsonPointer`/`extractSchema`/`mergeAllOf` utilities exported from this module's `index.ts`.

## Map / wallet "registries" — a different mechanism, don't conflate

`map/map-registry.ts` and `wallet/wallet-registry.ts` are **not** schema-driven — they're small runtime provider registries (`Map<string, Component>`) selected by name (`getRuntimeEnv('VITE_MAP_PROVIDER')`, defaulting to `leaflet`; similarly for wallet providers like Dhiway/DigiLocker). A network's schema never dictates which map/wallet provider renders — that's a deployment-level choice (env var), while everything else in this directory is schema-level. If you're adding a new provider, register it via `registerMapProvider`/similar — don't try to route the choice through `network.json`.
