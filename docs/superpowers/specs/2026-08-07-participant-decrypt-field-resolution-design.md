# participant/decrypt — field selection + canonical PII resolution — Design

- **Repo:** Signals-DPG (this change is Signals-side only)
- **Umbrella:** Blue-Dots-Economy/signals-dpg#237 (campaign integrations)
- **New issue:** signals-dpg#TBD (to be created before implementation)
- **Consumers:** aggregator-dpg #577 (voice → needs `phone`), #578 (email → needs `email`), #579 (PII export → unchanged; needs full `item_state`)
- **Date:** 2026-08-07
- **Status:** Proposed design, pre-implementation

## In Plain Terms

Today, when the aggregator asks Signals to decrypt a participant's profile, Signals returns the whole decrypted profile. Two upcoming features need something narrower and smarter: the voice feature needs just the **phone number**, and the email feature needs just the **email** — and for some networks those live on the profile, but for others they only exist on the person's **account** (login) record, and they're **named differently per network** (e.g. `phone` vs `mobile_number` vs `hiringManagerPhoneNumber`). This change lets the caller ask for specific fields, teaches Signals how to find the real name/phone/email regardless of how a network names them, and falls back to the account record when the profile doesn't carry them — without changing who is allowed to see what.

## 1. Terminology clarification (important for review)

- **`item_private_state`** = the **encrypted ciphertext blob** stored on the `items` row. This raw blob is **never** returned by this endpoint (before or after this change).
- **Decrypted private *values*** (real `name`, `phone`, `location`, …) **are** returned — Signals decrypts the blob and **merges those values into `item_state`** in the response. So "we never return `item_private_state`" refers to the ciphertext, **not** the PII values. (This is why the export CSV already contains real PII.)

## 2. Current behavior (baseline)

`POST /api/v1/admin/participant/decrypt` (`apps/api/src/routes/v1/admin/participant_decrypt.ts`):
- Request: exactly one of `item_ids: uuid[]` **or** `user_id: string`.
- Auth: apikey + `x-acting-org-id`; ownership scoped by the item creator's `user.onboarded_by_org_id` (aggregator sees only what it onboarded; `network_service` sees all in served networks).
- Response: `{ profiles: [{ item_id, item_network, item_domain, item_type, item_state, created_at, updated_at }], skipped: [] }` where `item_state` is the **full** public+decrypted-private merge.

## 3. Why the change

- **#577 (voice)** needs the participant's **phone**; **#578 (email)** needs the **email**.
- These fields are **named differently per network/domain** and sometimes **do not exist on the profile at all** (they live only on the account/`user` record). Examples:

  | Concept | blue_dot seeker | purple_dot seeker | provider (blue/purple) |
  |---|---|---|---|
  | name  | `name` | `beneficiary_name` | `jobProviderName` / `organisation_name` / `contact_name` |
  | phone | `phone` | `mobile_number` | `hiringManagerPhoneNumber` / `contact_phone` |
  | email | *(none — account only)* | `email` | `hiringManagerEmail` / `contact_email` |

- So the aggregator can't hardcode field names, and for some domains (e.g. blue_dot seeker email) the value only exists on `user.email`.

## 4. Requirements

1. **New optional request field `fields: string[]`.**
   - **Omitted** → return the **full `item_state`** exactly as today (backward-compatible; #579 depends on this).
   - **Present** → return **only** the requested fields per profile (plus the item envelope: `item_id`, `item_network`, `item_domain`, `item_type`, `created_at`, `updated_at`). The raw `item_private_state` ciphertext is still never returned.
2. **Canonical PII fields = `name`, `email`, `phone`.** When any of these appears in `fields`:
   - Resolve the domain's real field name via the **canonical→field mapping** (§6) and read the (decrypted) value from `item_state`.
   - If that value is **missing or empty**, **fall back** to the account record: `name → user.name`, `email → user.email`, `phone → user.phone_number`.
   - Return the value under its **canonical key** (`name`/`email`/`phone`), so callers stay domain-agnostic.
   - If unresolved in **both** item_state and `user` → return the key with value **`null`** (present-but-unavailable, so the caller can branch — e.g. #578 `skipped_no_email`, #577 `no_phone_available`).
3. **Non-canonical requested fields** (any field name that isn't `name`/`email`/`phone`) → returned from `item_state` under their **raw key**, **no fallback**. Absent → simply omitted (or `null`; see §8).
4. **User-table fallback applies to `name`/`email`/`phone` only.** No other field ever reads the `user` table.
5. **No auth/ownership change.** Acting-org resolution and `onboarded_by` scoping are unchanged; `skipped` semantics unchanged (not-found / not-owned / undecryptable, undifferentiated).
6. Applies in **both** `item_ids` and `user_id` modes.

## 5. Request / response schema (proposed)

Request (`packages/schemas/src/admin/participant_decrypt.ts` — `DecryptParticipantRequest`):
```ts
{
  item_ids?: uuid[],        // exactly one of item_ids | user_id (unchanged)
  user_id?: string,
  fields?: string[],        // NEW, optional. canonical: "name" | "email" | "phone"
                            //   + any raw item_state field name. omitted => full item_state.
}
```

Response (`DecryptedProfileSnapshot`): unchanged envelope; `item_state` semantics:
- `fields` omitted → `item_state` = full merged state (today).
- `fields` present → `item_state` = only the requested keys: canonical PII under canonical keys (`name`/`email`/`phone`, possibly `null`), non-canonical under raw keys.
```jsonc
// fields: ["name","phone","email"] against a blue_dot seeker (email is account-only)
{
  "item_id": "…", "item_network": "blue_dot", "item_domain": "seeker",
  "item_type": "profile_1.0",
  "item_state": { "name": "Asha Kumari", "phone": "+9190…", "email": "asha@example.com" },
  //                ^ from item_state        ^ from item_state   ^ fell back to user.email
  "created_at": "…", "updated_at": "…"
}
```

## 6. Canonical→field mapping (the crux) — TWO OPTIONS (decide before implementation)

The mapping tells Signals which `item_state` field is the `name`/`phone`/`email` for a given `(network, domain)`. Precedent: location fields already carry a role marker `"location": "primary"` in `network.json`.

**Option A — in `network.json` (per network/domain).** Add an explicit contact-field map to each domain, e.g.:
```jsonc
"domains": {
  "provider": {
    "card": { "title_field": "organisation_name" },
    "contact_fields": { "name": "jobProviderName", "phone": "hiringManagerPhoneNumber", "email": "hiringManagerEmail" }
  }
}
```
- Pros: single source of truth alongside the schema; travels with the network definition; loader already parses `network.json`.
- Cons: cross-repo edit (bluedots-schemas) across every network; loader (`network_runtime.ts`) must expose it.

**Option B — a separate Signals mapping config** (per network/domain), shaped like the aggregator's existing `field_overrides`:
```yaml
blue_dot:
  field_overrides:
    seeker:   { name: name,            phone: phone,                    email: email }
    provider: { name: jobProviderName, phone: hiringManagerPhoneNumber, email: hiringManagerEmail }
```
- Pros: no schema-repo change; fast to iterate.
- Cons: second place that can drift from the schemas; must be maintained per network.

> **Decision pending.** Implementation will pick one; the resolver (§7) reads the map from a single accessor either way, so the choice is isolated to where the map is loaded from. Fallback default for `name` when unmapped: `display_name_field` / `card.title_field` (already available).

## 7. Resolver logic (per profile, when `fields` present)

```
out = {}
for f in fields:
  if f in {name, email, phone}:                     # canonical PII
     field_name = mapping(network, domain)[f]        # §6; for name, default to display_name_field/title_field
     v = item_state[field_name] (decrypted)          # may be undefined/empty
     if v is empty/missing:
        v = user[{name:name, email:email, phone:phone_number}[f]]   # account fallback
     out[f] = v ?? null                               # canonical key
  else:                                               # non-canonical
     if f in item_state: out[f] = item_state[f]       # raw key, no fallback
return { …envelope, item_state: out }
```
- `user` row is the item creator (already joined for ownership). Load `name/email/phone_number` in the same query.
- Decryption path unchanged (`decryptItemPrivate`); a decrypt failure still lands the item in `skipped`.
- Never log field values (PII) — counts only, as today.

## 8. Edge cases & decisions

- **Empty vs absent** for **canonical** fields → triggers fallback (missing OR empty string both fall back).
- **Non-canonical** absent field → omit the key (do not emit `null`) to keep the object tight. *(Confirm; canonical uses `null`.)*
- **Provider name ambiguity** (org name vs person `contact_name`) → resolved explicitly by the mapping (§6) — the map names the field we treat as canonical `name`.
- **Multiple email-ish fields** → the mapping is authoritative; no `format:email` guessing.
- **`user_id` mode** → same field resolution applied to every returned item.
- **Unknown canonical field mapping** (network/domain not in the map) → `name` falls back to `display_name_field`/`title_field`; `phone`/`email` resolve to account fallback directly (nothing to read from item_state).

## 9. Backward compatibility

- `fields` omitted ⇒ byte-for-byte today's behavior. #579 (export) and any existing caller are unaffected.
- Additive request field; additive mapping. No response envelope change.

## 10. Consumer usage (after this lands)

- **#577 (voice):** `fields: ["phone", "name"]` → domain-agnostic phone (+ name) with account fallback.
- **#578 (email):** `fields: ["email", "name"]` → domain-agnostic email (+ name); `null` email ⇒ aggregator marks `skipped_no_email`.
- **#579 (export):** unchanged — no `fields`, full `item_state`.

## 11. Testing

- `fields` omitted → identical full `item_state` (regression guard).
- Canonical field present in item_state → returned from item_state, no `user` read.
- Canonical field empty/absent in item_state → falls back to `user.*`.
- Canonical field absent in both → `null`.
- Non-canonical field → raw key from item_state; absent → omitted; never reads `user`.
- Per-domain mapping correctness (blue_dot seeker vs provider; purple_dot seeker `beneficiary_name`/`mobile_number`/`email`).
- `user_id` mode with `fields`.
- Ownership/`skipped` unchanged; no PII in logs.

## 12. Out of scope

- Aggregator-side wiring (the `signalstack-writer` query gains `fields`; #577/#578 consume it) — separate tickets.
- The per-network mapping *content* (if Option A, edited in bluedots-schemas).
- KC-token auth (aggregator-dpg#576).
