# PII Encryption at Rest + Masking — Design

**Status:** spec — awaiting implementation plan
**Author:** brainstorming session, 2026-05-28
**Related:** the `item_state` / `item_private_state` split established in `packages/schemas/src/item_state_privacy.ts`; the post-accept reveal flow established by `docs/superpowers/specs/2026-05-26-pii-reveal-on-accepted-action-design.md`.

## Goal

Replace the current "drop private fields from public reads" model with **encryption at rest + format-aware masking**, so that:

1. Private field values are stored encrypted (AES-256-GCM) in `item_private_state`, never in plaintext at rest.
2. `item_state` always contains every field — public values are real, private values are stored as type-aware masks (`a***@x.com`, `+91-XX-XXXX-X123`, etc.).
3. UI cards render `item_state` as-is, so a viewer sees a complete-looking card whether the private field is masked, missing because the profile is incomplete, or fully revealed.
4. Self-owned reads and post-accept reveal reads decrypt the encrypted blob and overwrite the masked values with real ones before responding.

## Why now

Today, when a viewer fetches an item they don't own, every `private: true` field is filtered out of both the response (`splitItemStateByPrivacy` only puts public fields in `item_state`) and the UI (`apps/ui/src/engine/schema/schema-privacy.ts` strips them again client-side). The user perceives a card with missing rows — and cannot tell whether the field is genuinely empty (profile incomplete) or hidden by privacy.

Adding masks instead of hiding fields makes the card visually consistent and removes the implicit "this person filled less out" signal. Pushing the data to encrypted-at-rest also closes a real gap: today `item_private_state` is plaintext jsonb, readable from any DB dump or replica.

## Approach (high level)

- New service-level master key (`SIGNALS_PII_KEY`, AES-256, 32 bytes base64). Single key per Signals instance. Loaded via `packages/config/src/secrets.ts`, provisioned via Helm Secret.
- New crypto helper (`encryptPiiBlob` / `decryptPiiBlob`) using AES-256-GCM with a 12-byte random IV per call and a 16-byte auth tag. Wire format: `v1:` prefix + base64(`iv(12) || ciphertext || authTag(16)`).
- New masking helper (`maskPrivateState`) driven by JSON-schema `format` + field-key heuristics.
- `item_private_state` column changes from `jsonb` to `text` and holds the encrypted blob (or empty string when the row has no private fields).
- On create/update: split → mask private → merge masks into `item_state` → encrypt private → store both columns.
- On read: existing flow unchanged for non-owner reads (mask travels naturally). Self / approved-via-action reads add a decrypt + merge step that overwrites masked leaves with real values.
- UI: delete the schema-privacy filter; cards render `item_state` as-is.

Greenfield migration: not live yet, so we change the column type and reseed; no data preservation needed.

## Section 1 — Crypto + key handling

### Module

New helper, location: `packages/auth/src/pii_crypto.ts` (sits alongside other secret-handling code).

```ts
export class PiiCryptoError extends Error {
  code: 'KEY_MISSING' | 'BAD_FORMAT' | 'DECRYPT_FAILED';
}

export function encryptPiiBlob(plaintext: string, key: Buffer): string;
export function decryptPiiBlob(blob: string, key: Buffer): string;
```

- Algorithm: **AES-256-GCM** via Node's built-in `crypto`. No new dependency.
- IV: 12 random bytes per call (`crypto.randomBytes(12)`); a fresh IV per write.
- Auth tag: 16 bytes appended to ciphertext; tag mismatch on decrypt throws `PiiCryptoError('DECRYPT_FAILED')`.
- Versioning: output starts with `v1:`. Decrypt rejects any other prefix with `BAD_FORMAT`. This is the rotation hook — future keyed envelopes can use `v2:` without breaking old rows.

### Key loading

`packages/config/src/secrets.ts` gains:

```ts
SIGNALS_PII_KEY: z.string().regex(/^[A-Za-z0-9+/=]+$/).refine(
  (s) => Buffer.from(s, 'base64').length === 32,
  'SIGNALS_PII_KEY must be base64-encoded 32 bytes (AES-256)'
)
```

Also added to `turbo.json` `globalPassThroughEnv` so it reaches filtered tasks (per the gotcha called out in `CLAUDE.md`).

The key is decoded once at startup, held in module scope as a `Buffer`, never logged, never serialised. Callers receive the `Buffer` directly from a `getPiiKey()` accessor; they do not see the env var.

### Ops + docs

- New Kubernetes Secret `pii-key`, provisioned via the same Helm pattern as the aggregator API key (`helmcharts/...`).
- `docs/operations/secrets.md` gets a new entry covering: how to generate (`openssl rand -base64 32`), how to rotate (manual reseed in this iteration), and a "never commit the key" reminder.
- `.env.example` (if present) lists the var with a placeholder.

### Errors

Routes that catch a `PiiCryptoError` return `500 INTERNAL_SERVER_ERROR` with the underlying code logged via `request.log.error({ err, code, item_id }, 'PII crypto failure')`. The code is **not** returned to the client; we don't leak crypto state in API responses.

## Section 2 — Schema, masking, and create/update paths

### DB schema

`packages/database/src/drizzle_ref_tables/items.ts`:

```ts
item_private_state: text('item_private_state').notNull().default(''),
```

- Type changes from `jsonb` to `text`. Default `''` means "no private fields on this row" — cheaper than storing an encrypted empty object.
- Drizzle migration regenerated via `pnpm db:generate:api`. Migration is a simple `ALTER COLUMN ... TYPE text USING ''` because data is being wiped (greenfield).
- Helm-bundled `schema.sql` regenerates via `pnpm schema:bundle`; `pnpm schema:bundle:check` is part of definition-of-done.

### Masking helper

New file `packages/schemas/src/item_state_masking.ts`:

```ts
export function maskPrivateState(
  itemSchema: JsonRecord,
  privateState: JsonRecord
): JsonRecord;
```

Walks the schema in lock-step with `privateState`, mirroring `splitItemStateByPrivacy`'s recursion so nested objects and arrays of objects are handled the same way.

For each leaf private value, masking rules are applied in order:

1. **JSON-schema `format` keyword:**
   - `email` → `a***@x.com` (first char + `***` + `@` + domain).
   - `phone` / `tel` → `+XX-XX-XXXX-X{last4}` (country code preserved if parseable, else `XXXXX` prefix + last 4 digits).
   - `date` / `date-time` → `XXXX-XX-XX`.
   - `uri` / `url` → `<scheme>://***`.
2. **Field-key heuristics** (case-insensitive substring match on the property key):
   - `name`, `first_name`, `last_name`, `full_name` → first letter + `***`.
   - `dob`, `birth` → `XXXX-XX-XX`.
   - `aadhaar`, `pan`, `ssn`, `national_id` → last 4 digits visible, rest `X`.
3. **Fallback**: length-preserving generic — replace every char with `X`.

All rules live in a single `MASKING_RULES` table — an array of `{ test, apply }` entries — so adding a new heuristic is a one-line edit.

Non-string scalars (numbers, booleans) are masked by stringifying first; arrays of primitives map element-wise; nulls and `undefined` pass through unchanged.

### Merge helper

`packages/schemas/src/item_state_privacy.ts` promotes its internal `mergeObjects` to a new exported `mergeMasksIntoPublic(publicState, maskedPrivate)` (identical to `mergeItemStateWithPrivate` but named for its new role). No logic change.

### Create flow

`apps/api/src/services/item_service.ts`, after `splitItemStateByPrivacy` returns `{ publicState, privateState }`:

```ts
const masked = maskPrivateState(itemSchema, privateState);
const itemStateForStorage = mergeMasksIntoPublic(publicState, masked);
const encryptedPrivate = Object.keys(privateState).length === 0
  ? ''
  : encryptPiiBlob(JSON.stringify(privateState), getPiiKey());

await exec.insert(items).values({
  // ...unchanged...
  item_state: itemStateForStorage,
  item_private_state: encryptedPrivate,
});
```

The empty-string short-circuit keeps storage cheap for items whose schema has no `private: true` fields.

### Update flow

`updateItemInternal` follows the same dance, but with a critical extra step. A partial update may touch only public fields, in which case we must **preserve** the existing encrypted private state. Implementation:

1. Fetch the existing row (decrypt the current `item_private_state`).
2. Merge incoming changes into the decrypted full state.
3. Re-split, re-mask, re-encrypt.
4. Write both columns.

This is one extra read per update, which is acceptable. The alternative (touch only `item_state`) would silently desync the masked mirror from the encrypted blob.

### Validation

Unchanged. `validateAgainstJsonSchema` runs against the merged input as today. Masking happens *after* validation, never before.

## Section 3 — Read paths and decryption

### Decrypt helper

New file `apps/api/src/utils/item_decrypt.ts`:

```ts
export function decryptItemPrivate(
  row: { item_state: JsonRecord; item_private_state: string }
): { mergedState: JsonRecord };
```

- Empty `item_private_state` → returns `item_state` unchanged.
- Otherwise: decrypt the blob, `JSON.parse`, call the existing `mergeItemStateWithPrivate(item_state, decrypted)` so real values overwrite masked leaves.
- Throws `PiiCryptoError` on failure — caller logs and translates to 500.

### `fetchLocalItems`

`apps/api/src/utils/item_fetch_runtime.ts` keeps its existing `includePrivateState` flag. The flag's *meaning* changes from "merge jsonb private state" to "decrypt and merge":

```ts
items: result.map((item) => {
  const { item_private_state, ...rest } = item;
  if (!filters.includePrivateState) {
    return rest;   // masked item_state as-is
  }
  return { ...rest, item_state: decryptItemPrivate(item).mergedState };
}),
```

`item_private_state` is never returned in the response either way (it's destructured out) — unchanged from today.

A one-line comment on the `ItemFetchFilters.includePrivateState` field explains the new semantics. Renaming the flag is deferred (touches too many call sites).

### Endpoint behaviour

| Endpoint | `includePrivateState` | Result |
|---|---|---|
| `GET /api/v1/item/fetch` (self-owned) | `true` | Decrypt + merge → real values |
| `GET /api/v1/network/item/fetch` (cross-actor / inter-instance) | `false` | Masked `item_state` as stored |
| `GET /api/v1/action/:id/contact-details` (post-accept reveal) | `true` | Decrypt + merge → real values for the other actor |

Cross-instance reveal still returns `501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` (peers don't share keys). Inter-instance fetches between Signals nodes carry masked `item_state` only; peers cannot distinguish a masked field from a genuinely public one. That's the design.

### Caching

`getCachedLocalItemFetch` (in `apps/api/src/utils/item_fetch_cache.ts`) caches post-merge results. The cache key **must** include `includePrivateState`, otherwise a self-owned cached entry (decrypted) could be served to a stranger. If the cache key does not currently include the flag, that is a bug fixed as part of this change. The contact-details endpoint already sets `Cache-Control: no-store`; keep that.

### Inter-instance fetch

`apps/api/src/utils/inter_instance_fetch.ts`: no changes. Peers see masked `item_state` and have no idea it was masked vs. public.

### Error handling

Decrypt failure on a self read is a hard 500 — the row is corrupt or the key is wrong, both ops issues, not user-recoverable. We do **not** silently fall back to masked values; that would surface stale/inconsistent data. Structured log: `{ err, item_id, item_network }`.

## Section 4 — UI changes

The UI today filters `private: true` properties from the schema before rendering, so private rows simply don't appear on browse cards. After this change the API guarantees `item_state` contains every field (masked or real), so the client-side privacy filter becomes dead code.

### Files touched

- **`apps/ui/src/engine/schema/schema-privacy.ts`** — delete. The whole module exists to filter private fields.
- **`apps/ui/src/components/cards/card-field.tsx`** — drop the `privacyMode` prop on `CardFieldsFromSchema` and the inline `.filter()` that strips private fields. Cards render whatever's in `data` against whatever's in `schema.properties`.
- **`apps/ui/src/components/cards/domain-card.tsx`** — drop the `privacyMode` prop (it's just plumbed through).
- **`apps/ui/src/engine/types.ts`** — remove the `PrivacyMode` type.
- All callers of `DomainCard` / `CardFieldsFromSchema` that pass `privacyMode={'all' | 'public-only'}` — strip the prop. The reveal modal currently passes `'all'`; it just stops passing the prop, with no behavioural change because the contact-details endpoint already returns decrypted `item_state`.

### What the user sees

- Browse cards / network feed → masked values inline. No icons, no tooltips, no visual distinction.
- "My items" view → real values, decrypted by the API.
- Reveal modal after accept → real values for the other actor, same as today.
- Profile incomplete (field empty in `item_state`) → still hidden by `isEmptyValue` in `card-field.tsx`. That logic is unchanged and naturally serves the "card looks the same whether the field is missing or masked" goal.

### Form rendering

The create/edit form (RJSF-based) still accepts private inputs from the owner — that path is unchanged. Forms render every property; only the *card display* was filtering. Implementation must confirm no form-side code references `schema-privacy.ts`.

### Type-checking + tests

`pnpm typecheck` surfaces every removed prop. UI tests that assert "private fields are hidden" get updated to assert masked rendering. The schema-privacy unit tests are deleted with the module.

## Section 5 — Testing, scope, and explicit non-goals

### Unit tests (new / updated)

- `packages/auth/__tests__/pii_crypto.test.ts` — encrypt/decrypt round-trip, IV uniqueness across calls, tamper detection (flip a byte → throw), version-prefix rejection, key-length validation.
- `packages/schemas/__tests__/item_state_masking.test.ts` — every masking rule (email, phone, date, name, id-like keys, length-preserving fallback), nested objects, arrays of objects, non-string scalars, null / undefined passthrough.
- `apps/api/src/services/__tests__/item_service.test.ts` — create with mixed public + private fields: assert `item_state` contains real public values + masked private values, `item_private_state` is a non-empty string and decrypts back to the original private object. Update preserves untouched private fields.
- `apps/api/src/utils/__tests__/item_decrypt.test.ts` — empty-string row returns `item_state` untouched; valid envelope returns merged real values; corrupt envelope throws.
- Existing `fetch_item.test.ts`, `get_action_contact_details.test.ts`, `update_action_status.test.ts`, `perform_action.test.ts` — fixtures move to the new flow; assertions on returned `item_state` change from "field absent" to "field present, masked or real depending on path".
- UI tests touching `privacyMode` — rewrite to assert masked rendering.

### Integration tests

- `apps/api/src/routes/v1/item/__tests__/fetch_item.integration.test.ts` — create item with private fields → fetch via `/item/fetch` as owner = real values; fetch via `/network/item/fetch` as stranger = masked values; `item_private_state` never appears in either response.
- `apps/api/src/routes/v1/action/__tests__/get_action_contact_details.integration.test.ts` — update fixture to use encrypted blob; assert decrypted reveal still works.
- Test setup (`vitest.setup.ts` or equivalent) provides a deterministic `SIGNALS_PII_KEY` (e.g. base64 of 32 zero bytes).

### Greenfield migration check

`pnpm schema:bundle:check` is part of the definition of done. Migration is only correct if the bundled schema matches.

### Seed scripts

`apps/api/scripts/seed_purple_dot.ts` and any examples that insert items directly: update to go through the service (`createItemInternal`) so they exercise the encryption path. If they currently bypass it with raw `db.insert`, that is fixed as part of this change.

### Audit log

`pii_reveal_audit` keeps working unchanged — it records who triggered a reveal via `/action/:id/contact-details`. We deliberately do **not** add an audit row per self-decrypt; that would be high-volume noise (one row per profile-page render).

### Explicit non-goals

- Key rotation tooling (single key, no `keyId` in envelope; the `v1:` prefix is the rotation hook for a future iteration).
- Cross-instance reveal (still 501).
- Per-network or per-tenant keys.
- KMS integration.
- Audit logging of self-reads.
- Encrypting the masked mirror inside `item_state` (it's masked; not sensitive).
- Searchable encryption / encrypted indexes. `item_state @>` filter on a private field will only match the mask, never the plaintext. If a caller tries to filter on a private field they get zero results. That's correct behaviour and is called out here so reviewers don't read it as a bug.

### Risk surface

- Decrypt-on-every-self-read adds CPU per fetch. AES-GCM in Node is ~GB/s per core; negligible at our scale. No benchmark required.
- The "fetch row → decrypt → merge → re-encrypt → write" path on update is one extra read per update. Acceptable.
- Key compromise = full PII compromise. Key handling is documented in `secrets.md`; even without rotation tooling, ops can rotate manually by re-encrypting the database and updating the Secret.
