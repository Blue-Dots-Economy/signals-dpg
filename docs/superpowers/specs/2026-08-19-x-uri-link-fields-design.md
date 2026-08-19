# `x-uri` Link Fields — Design

**Issue:** [signals-dpg#565](https://github.com/Blue-Dots-Economy/signals-dpg/issues/565)
**Date:** 2026-08-19
**Branch:** `feat/565-x-uri-link-fields` (off `feature`)

## Problem

A `network.json` item schema can hold any number of fields whose value is a URL
(`catalog_url`, `website`, a portfolio link, a registration link…). Today every
one of them renders as **plain text** in the profile/item cards — the user sees
the URL but cannot click it.

Two things are missing:

1. **Rendering.** A schema author has no way to say "this field is a link".
2. **Input validation.** Nothing stops a user typing `companyabc` into a URL
   field. Such a value could never produce a working link, so the render fix is
   only half a fix without it.

## Non-goals

- **No action buttons.** The requirement is an inline clickable link *in the
  field row of the card*, not another button in the card footer. (The existing
  "Website" button on the orange-dot tourist card is a separate, hardcoded
  feature — `apps/ui/src/tourist/practitioner-card.tsx:31` reads `data.website`
  by field name. It is unrelated to this work and is left untouched.)
- **No `card` config change.** Whether a field is a link is a property of the
  field, not of the card layout, so the marker lives on the field.

## Why a new marker rather than `format: "uri"`

The schemas already carry `"format": "uri"` on `orange_dot.website` and
`purple_dot.catalog_url`. It was still rejected as the marker:

- **`format: "uri"` rejects what users actually type.** ajv's `uri` format
  requires a scheme, so `www.example.com` fails. Forcing the format onto every
  link field would make the profile form reject the most common input.
- **`format` is already overloaded.** `packages/schemas/src/item_state_masking.ts:44`
  keys off `format === 'uri' | 'url'` to decide the *masking* shape
  (`https://***`). Reusing it for rendering would couple two unrelated concerns.
- **`format` is not enforced on the server at all.** See "Enforcement" below.

An explicit `"x-uri": true` marker is an opt-in with no other meaning, matching
the established `x-show-if` / `x-form-layout` / `x-reference-source` convention.

## Design

### 1. The marker

```jsonc
"catalog_url": {
  "type": "string",
  "title": "Catalog URL",
  "description": "URL to a catalog or service list you provide",
  "x-uri": true
}
```

Also valid on an array-of-strings property, so a domain can offer "add as many
links as you like":

```jsonc
"reference_links": {
  "type": "array",
  "items": { "type": "string" },
  "x-uri": true
}
```

Any number of fields per schema may carry it. It is orthogonal to `format`,
`private`, `x-show-if`, and the `card` block.

### 2. Validation rule

One shared `URL_PATTERN`, injected as a JSON Schema `pattern` wherever
`x-uri: true` is present and the author has not written their own `pattern`:

```
^\s*$|^\s*(https?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(:\d{1,5})?(\/[^\s]*)?\s*$
```

| Input | Result |
|---|---|
| `example.com`, `www.example.com`, `my-site.org` | accept — scheme optional |
| `https://example.com`, `http://a.co.uk/x?q=1#f`, `https://example.com:8443/x` | accept |
| `  https://example.com  ` | accept — surrounding whitespace tolerated |
| `""` | accept — presence is `required[]`'s job, not the pattern's |
| `companyabc` | **reject** — no dot, cannot be a host |
| `javascript:alert(1)`, `data:text/html,x`, `ftp://example.com` | **reject** |
| `http://localhost:3000`, `http://192.168.1.1` | **reject** — not a public profile link |
| `a@b.com`, `foo bar`, `https://` | **reject** |

Decisions embedded in this rule:

- **Scheme-less input is accepted** and stored exactly as the user typed it. The
  card prefixes `https://` when building the `href`. This matches the existing
  `normalizeWebsiteUrl` behaviour (`apps/ui/src/lib/geo/directions.ts:45`) and
  avoids rejecting the most common input.
- **Empty string is accepted** so clearing an optional field does not raise a
  validation error. A *required* link field should carry `minLength: 1`, which
  is already this repo's convention for required strings (e.g.
  `purple_dot.service_details`).
- **`pattern`, not `format`.** `pattern` is a core ajv keyword that works with
  zero configuration on both sides. Registering `ajv-formats` server-side to
  make `format: "uri"` bite would simultaneously switch on `email` and `date`
  enforcement for all existing data and could start rejecting live items.

### 3. Enforcement — both sides

The UI validator (`@rjsf/validator-ajv8`) registers `ajv-formats`; the API
validator does **not** — `packages/schemas/src/network_workflow.ts:613`
constructs `new Ajv2020({ strict: false })` with no formats. So `format` is
silently ignored on every write today, and client-side validation alone would be
bypassable via the API, bulk import, or the aggregator.

The pattern injection therefore runs in **one shared function used by both**:

- Client: before `normalizeSchemaForRjsf` in `apps/ui/src/components/forms/schema-form.tsx`.
- Server: inside `validateAgainstJsonSchema` in `packages/schemas/src/network_workflow.ts`,
  alongside the existing `allowAdditionalProperties` / `omitRequiredSchemaKeys`
  schema transforms.

Identical rules on both sides, one place to change them.

### 4. Where the shared code lives

A new **dependency-free** module `packages/schemas/src/uri_fields.ts`, mirroring
`location_fields.ts`. This matters: the `@dpg/schemas` barrel re-exports
DB-bound modules (`@dpg/database` → `pg`) and **breaks the browser build**, so
`apps/ui/vite.config.ts:355` and `apps/ui/tsconfig.json:27` already carry a
dedicated deep-import alias for `@dpg/schemas/location_fields`. `uri_fields`
gets the same treatment.

### 5. Card rendering

`CardRow` (`apps/ui/src/components/cards/resolve-card-fields.ts`) currently
carries only `{key, label, value, type, isEmpty}` and discards the rest of the
property schema. It gains `isUri`.

Rendering goes through a shared `UriValue` component used by both render
surfaces:

- `apps/ui/src/components/cards/item-card.tsx` → `FieldRow` — the single render
  point for the browse grid, map popup, connected-profile modal
  (`profile-card-modal.tsx` → `domain-card.tsx`) and the tourist card.
- `apps/ui/src/pages/public-profile-page.tsx:591` — the public `/p/` page calls
  `formatCardValue()` directly and bypasses `FieldRow`, so it needs the same
  treatment or the acceptance criterion only half-holds.

Href construction (`toSafeHref`) rules, in order:

1. Trim. Empty → not a link.
2. Contains `***` → **not a link**. The API rewrites uri-ish fields to
   `https://***` in masked public projections
   (`packages/schemas/src/item_state_masking.ts:44`); a masked stub must render
   as plain text, never as a dead link.
3. Has a scheme that is not `http`/`https` → not a link (blocks `javascript:`,
   `data:`, `mailto:`).
4. No scheme → prefix `https://`.
5. Final gate: `new URL(href)` must parse and its protocol must be `http:` or
   `https:`, else not a link.

Anything that is not a link falls back to today's plain-text rendering, so a
bad value degrades instead of breaking.

Link attributes: `target="_blank"`, `rel="noopener noreferrer"`, and
`onClick={e => e.stopPropagation()}` — list cards have their own `onClick` that
would otherwise fire on a link click.

Long URLs: the existing 140-char "Show more" toggle is skipped for link rows.
A URL does not need progressive disclosure — the display text is truncated to
60 chars with an ellipsis, `title` carries the full value, and `href` is
complete.

Arrays: each entry renders as its own link, comma-separated.

### 6. Scope of schema changes

**No `network.json` field is flagged in this pass.** The mechanism ships with
tests; schema authors opt fields in afterwards. Consequently nothing changes in
`bluedots-schemas` or the `bluedots-automation` ConfigMap this pass, and the
issue's "synced downstream" acceptance item is satisfied by documenting the
marker.

**Caution to record for whoever flags fields later:** because the pattern is
enforced server-side, marking an existing field `x-uri` will cause updates to
items that already hold a non-URL value in that field to be rejected with
`INVALID_ITEM_STATE`. Audit existing data before flagging a live field.

## Acceptance (from the issue)

- [x] Fields flagged as URI in `network.json` render as hyperlinks in cards —
      covered by tests on both render surfaces.
- [x] Non-flagged fields render unchanged — covered by regression tests.
- [x] Marker documented and synced downstream — documented in `CLAUDE.md`;
      no downstream schema edit needed since no field is flagged yet.
- [x] *(added)* A field flagged as URI rejects non-URL input in the profile
      form, and on the API.
