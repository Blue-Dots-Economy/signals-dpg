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

Three **independent, optional** request controls — deliberately decoupled so canonical contacts and locations are available regardless of the `item_state` projection (this is the fix for the three gaps: full-state-plus-contacts, provenance, and locations).

1. **`fields?: string[]` — pure `item_state` projection.**
   - **Omitted** → full merged `item_state` (backward-compatible; #579 depends on this).
   - **Present** → only those `item_state` keys (raw keys), plus the envelope (`item_id`/`item_network`/`item_domain`/`item_type`/`created_at`/`updated_at`). Absent/empty keys are omitted. **No canonical special-casing, no `user` fallback** — `fields` only ever projects `item_state`.
   - The raw `item_private_state` ciphertext is never returned (decrypted values are, merged into `item_state`).

2. **`contact?: true | ("name"|"email"|"phone")[]` — canonical contact block (NEW, independent of `fields`).** When set, the response gains a `contact` object; for each requested canonical field:
   - map canonical → the domain's real field (§6; `name` defaults to `display_name_field`/`card.title_field`), read the **decrypted** value from `item_state`;
   - if missing/empty, **fall back** to the account row (`name→user.name`, `email→user.email`, `phone→user.phone_number`);
   - return `{ value, source }` where `source ∈ "item" | "user" | null`; unresolved in both → `{ value: null, source: null }`.
   - `true` = all three; an array = that subset.

3. **`include_locations?: boolean` — item locations (NEW).** When `true`, the response gains `locations`: the item's geocoded `item_locations` as `[{lat,lng,label?}]`. Private primary-location fields are **jittered at storage**, so their point is the jittered one (exact for non-private). Omitted/false → no `locations`.

4. **User-table fallback applies to `name`/`email`/`phone` only** (inside the `contact` block). Nothing else reads `user`.
5. **No auth/ownership change.** Acting-org + `onboarded_by` scoping unchanged; `skipped` semantics unchanged. Never log field values / PII (counts only).
6. Applies in **both** `item_ids` and `user_id` modes.
7. **Mapping completeness validated** (for the `contact` block): a missing/unmapped `(network,domain)` for a requested `phone`/`email` emits a **PII-free warning** (never a silent wrong field). `name` has the `display_name_field`/`title_field` default.
8. **Input guards.** `fields` and `contact`-array entries are non-empty strings; cap `fields` length; `contact` array values must be within `{name,email,phone}`.

## 5. Request / response schema (proposed)

Request (`packages/schemas/src/admin/participant_decrypt.ts` — `DecryptParticipantRequest`):
```ts
{
  item_ids?: uuid[],                               // exactly one of item_ids | user_id (unchanged)
  user_id?: string,
  fields?: string[],                               // OPTIONAL — pure item_state projection; omitted => full item_state
  contact?: boolean | ("name"|"email"|"phone")[],  // OPTIONAL — canonical contact block (fallback + provenance)
  include_locations?: boolean,                     // OPTIONAL — include item_locations
}
```

Response (`DecryptedProfileSnapshot`):
```jsonc
{
  "item_id": "…", "item_network": "…", "item_domain": "…", "item_type": "…",
  "item_state": { … },                 // full (fields omitted) or projected (fields present)
  "contact": {                         // present iff `contact` requested
    "name":  { "value": "Asha Kumari",      "source": "item" },
    "phone": { "value": "+9190…",           "source": "item" },
    "email": { "value": "asha@example.com", "source": "user" }   // not in profile → account fallback
    // unresolved in both → { "value": null, "source": null }
  },
  "locations": [ { "lat": 12.9, "lng": 77.5, "label": "Bengaluru" } ],  // present iff include_locations
  "created_at": "…", "updated_at": "…"
}
```
Combinations:
| `fields` | `contact` | `include_locations` | result |
|---|---|---|---|
| omitted | omitted | – | full `item_state` (today's default) |
| omitted | `true` | – | full `item_state` + full `contact` block |
| `["age"]` | `["phone"]` | – | `item_state`={age} + `contact`={phone} |
| omitted | `true` | `true` | full `item_state` + `contact` + `locations` |
| `[]` | `true` | – | **contact-only** — empty `item_state` (`{}`) + `contact` block |

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

> **DECISION: Option A (mapping in `network.json`).** Chosen to keep the mapping co-located with the schema and eliminate drift. Option B is retained above only as context for reviewers. The resolver (§7) reads the map through a single network-config accessor. Fallback default for `name` when unmapped: `display_name_field` / `card.title_field` (already available). The local `examples/schemas/*/network.json` get `contact_fields` in this change; the canonical bluedots-schemas copies are a cross-repo follow-up (§12).

## 7. Resolver logic (per profile)

Two independent steps, both reading the **decrypted merged** state (`mergedState` from `decryptItemPrivate`) — never the masked public `item_state` (which holds `+91***` placeholders for `private:true` fields).

**(a) item_state projection — from `fields`:**
```
item_state = fields
  ? pick(mergedState, fields.filter(f => hasValue(mergedState[f])))   # raw keys, absent/empty omitted
  : mergedState                                                       # full
```
Pure projection: no canonical logic, no `user` read.

**(b) contact block — from `contact`:**
```
for f in requestedContacts:                 # subset of {name,email,phone}
  field = contactFieldMap(network,domain)[f]        # §6; name defaults to display_name_field/title_field
  v = field ? mergedState[field] : undefined        # decrypted
  if hasValue(v):  contact[f] = { value: v, source: "item" }          # profile wins
  else:
     if f in {phone,email} and !field: warn(PII-free, mapping missing)
     a = account[f]                                 # user.name / user.email / user.phone_number
     contact[f] = hasValue(a) ? { value: a, source: "user" }
                              : { value: null,  source: null }
```

**(c) locations — from `include_locations`:** return the item's `item_locations` column as `locations` (jittered for a private primary field; §4.3).

- The `user` row (item creator) is already joined for ownership; load `name/email/phone_number` **and** `item_locations` in the same query.
- Decrypt failure still lands the item in `skipped` (accepted — §13).
- Never log field values (PII) — counts only.

## 8. Edge cases & decisions

- **`fields` projection:** absent OR empty item_state values are omitted (tight object); `fields` never emits `null` and never reads `user`.
- **`contact` fallback:** a canonical value missing OR empty in item_state triggers the account fallback; unresolved in both → `{value:null, source:null}` (never omitted — callers branch on it: #578 skip-no-email, #577 no-phone).
- **Profile-first precedence:** when a canonical value exists in *both* item_state and account, item_state wins (`source:"item"`).
- **Provider name ambiguity** (org vs person) → resolved by the mapping (§6).
- **Multiple email-ish fields** → mapping is authoritative; no `format:email` guessing.
- **`user_id` mode** → projection + contact + locations applied to every returned item.
- **Unknown mapping** for a domain → `name` falls back to `display_name_field`/`title_field`; `phone`/`email` go straight to account fallback (+ PII-free warn).
- **Intentional overlap:** with full `item_state` + `contact`, `name`/`phone` may appear in both — `item_state` is the raw projection, `contact` is the normalized, provenance-tagged answer (and carries the account `email` that `item_state` lacks).

## 9. Backward compatibility

- `fields` + `contact` + `include_locations` all omitted ⇒ byte-for-byte today's behavior (full `item_state`). #579 export and any existing caller unaffected.
- **Reshape note (supersedes the earlier design):** canonical `name`/`email`/`phone` are **no longer injected into `item_state`** when listed in `fields`; `fields` is now a pure projection and canonical contacts moved to the dedicated `contact` block. Safe because PR #522 is a draft with no consumers yet.

## 10. Consumer usage (after this lands)

- **#577 (voice):** `contact: ["phone","name"]` → read `resp.contact.phone.value` (domain-agnostic, account fallback); `value:null` ⇒ `no_phone_available`.
- **#578 (email):** `contact: ["email","name"]` → `resp.contact.email.value`; `value:null` ⇒ `skipped_no_email`.
- **#579 (export):** unchanged — no `fields`/`contact` → full `item_state`; MAY add `include_locations: true` to include coords in the CSV.

## 11. Testing

- `fields`/`contact`/`include_locations` all omitted → identical full `item_state` (regression guard); no `contact`/`locations` keys in the response.
- `fields:["age","gender"]` → only those keys; absent/empty omitted; no `user` read.
- `contact:true` (no `fields`) → full `item_state` **plus** a `contact` block with all three.
- contact resolution: canonical in item_state → `{source:"item"}`; empty/absent → account `{source:"user"}`; absent in both → `{value:null, source:null}`.
- contact subset `["phone"]` → only `phone` in the block.
- Profile-first: canonical present in *both* → `source:"item"`.
- `include_locations:true` → `locations` present; false/omitted → absent.
- Per-domain mapping (blue_dot seeker/provider; purple_dot `beneficiary_name`/`mobile_number`/`email`).
- Mapping gap for `phone`/`email` → PII-free warning fires (never a silent wrong field).
- `user_id` mode with `contact` + `include_locations`.
- Ownership/`skipped` unchanged; no PII in logs.

## 12. Out of scope

- Aggregator-side wiring (the `signalstack-writer` query gains `fields`; #577/#578 consume it) — separate tickets.
- The per-network mapping *content* (if Option A, edited in bluedots-schemas).
- KC-token auth (aggregator-dpg#576).

## 13. Risks & accepted decisions

**Built into this change (correctness of the feature):**
- **Resolve from decrypted state** (§7) — else masked values leak into the output. Test asserts the real, unmasked value.
- **Mapping-completeness validation + warning** (§4.7) — a config gap must surface as a warning, not silent `null`/dropped participants. Favors **Option A** (mapping in `network.json`, co-located with the schema) to prevent drift.
- **`fields`-omitted regression test** — proves the response is byte-for-byte today's full `item_state` (protects #579).
- **Profile-first precedence** (decision): when a canonical field exists in **both** item_state and the account and they differ, the **item_state (profile) value wins**; the account is fallback only. Rationale: the profile field is the campaign-relevant contact.

**Accepted / deferred (recorded, not mitigated in this change):**
- **Retired-participant account fallback.** `retire` (#347) scrubs the *item* (`item_state` phone/email masked/removed) but not the `user`/account row, and `decrypt` does not filter retired items. So if a caller sends a **retired** item_id and requests a canonical field, the account fallback can return `user.email`/`user.phone_number` that retire meant to erase. **Accepted for the interim** — decrypt only returns an item the caller explicitly asks for, and callers are trusted/internal. **Known caveat:** the campaign prototype works off the twice-daily snapshot, so it could send an id retired *after* the snapshot without knowing. **Revisit before production** (e.g. skip the account fallback — or the item entirely — for retired items, or have retire also clear account contact). Tracked with the KC-token / production hardening (aggregator-dpg#576).
- **Decrypt-failure skips the item.** A corrupt `item_private_state` blob lands the item in `skipped`, even for a canonical field that would have resolved from the account. Accepted (rare); revisit if it affects deliverability in practice.

**Policy / observability:**
- Returning account `email`/`phone` is a **new disclosure class** (login identity) beyond profile PII. The audit log should record when the **account fallback** was used and for which canonical fields; obtain the usual PII sign-off. (Consent gating remains out of scope for the interim, consistent with the aggregator side.)
