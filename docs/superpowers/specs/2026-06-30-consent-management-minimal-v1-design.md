# Consent Management — Minimal v1 (Signals-DPG only)

**Date:** 2026-06-30
**Status:** Design — pending user review before the implementation plan
**Branch:** `feat/consent-management-v1` (based on `origin/feature`)
**Issue:** [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99) — first-version consent capture covering the four scenarios listed by `vineela-ekstep`
**Relationship to the cross-DPG canonical spec:** This is a deliberately **scoped-down v1**. The cross-DPG design (`2026-06-25-consent-management-design.md`, branch `feat/consent-management`) defines a standalone shared `consent-service` keyed on Keycloak `sub`, with OTP, minors, erasure, revoke, multi-channel capture, and consent receipts. **None of that is in scope here.** v1 is a single Signals table + a config-driven content layer that captures the four consent moments today, in a shape that does not block migrating to the canonical service later.

---

## 1. Goal

Capture consent at the four moments raised on issue #99, recording the **event, the version, and the timestamp** for each, in a single Signals table:

1. **Terms & privacy** at signup / login — explicit acceptance, never implicitly clicked.
2. **Profile creation** — an acknowledgement shown before the profile item is created.
3. **Connect / apply initiated** — the initiator's data-sharing acknowledgement.
4. **Connect / apply accepted** — the receiver's data-sharing acknowledgement.

Today consent is scattered and untrustworthy:
- `terms_accepted` / `privacy_accepted` booleans on the `user` table are **hardcoded to `true`** at signup (`packages/auth/plugins/unified_otp.ts`), with no timestamp and no version.
- The sign-in footer (`apps/ui/src/components/layout/auth-footer.tsx`) says *"By continuing you agree to the Privacy Policy and Terms"* — **implicit** consent. The `Privacy Policy` / `Terms` links point at `/privacy` and `/terms`, which **do not exist** → blank pages.
- Per-action consent text lives **inline in `network.json`** (`consent_text_initiator` / `consent_text_receiver`), is only **logged** (`request.log.info('consent recorded')`) in `perform_action.ts` / `update_action_status.ts`, and is embedded into `action_events.event_payload` JSONB — there is **no queryable consent record** and **no version**.

v1 replaces this with: one append-only **`consent_record`** table (event + version + timestamp), and a **config-driven content layer** (`consent.json`) that is per-network with per-brand override.

### Non-goals (explicitly out of scope for v1)

- No standalone `consent-service`, no Keycloak, no cross-DPG sharing.
- No OTP / verification, no minors / guardian consent.
- No revoke, withdrawal, stop-processing, or erasure flows.
- No voice / aggregator / bulk channels — **UI channel only**.
- No DPV / DEPA / consent-receipt shaping.

These remain the domain of the canonical cross-DPG spec.

---

## 1.1 Architecture — UI-merge + backend-ledger (confirmed)

The backend has **no brand concept** (verified: brand is resolved only in the UI via `window.__DPG_UI_CONFIG__.VITE_BRAND_NAME` → build default → `'standard'`; no `brand.json` is read by the API, no brand header/param exists). Consequently, for v1:

- **Backend = ledger + config server.** The API stores `consent_record` rows and returns a user's accepted versions. It also **serves the network-default `consent.json`** through the existing schema pipeline (`GET /api/v1/network/schemas`, new `kind: 'consent_config'`), and — because the deployment knows its own brand at config-load time — **also serves a brand-scoped consent entry** when a brand override file is configured.
- **UI = merge + gate.** The UI receives the network-default (and, if present, the brand) consent entries, applies the per-brand override (it is the only layer that knows the active brand), renders `current_version`, computes `needs_consent`, and gates the flows.
- **`network`** is authoritative server-side for item/action rows (derived from the item/action). For user-level `terms`/`privacy`, the UI supplies the served network, validated against the instance's `served_domains`. **`brand`** and **`document_version`** are supplied by the UI (accepted v1 tradeoff — not server-validated; the canonical service hardens this later).
- **Action-consent required-ness stays server-enforced** via `reveals_pii_on_status` in `network.json` (unchanged). Only the recorded version comes from the UI.

Tradeoff accepted for v1: terms/privacy/profile gating is **client-side**. A user bypassing the popup simply gets no consent row written; PII-revealing actions remain server-gated as today.

---

## 2. The consent types — network-agnostic

Action types are **not** universal. Verified against the shipped configs:

| Network | Actions defined | Has consent text today |
|---|---|---|
| `blue_dot` | `apply` + `connect` | yes (both) |
| `purple_dot` | `connect` only (3 interaction variants) | yes |
| `yellow_dot` | `connect` only | no |
| `orange_dot` | **none** | — |
| inter-network `blue_dot` / `yellow_dot` | `apply` / `connect` | no |

So the action consent types **must be derived from each network's `network.json`**, never hardcoded. A future network may define a different action type entirely, or none.

Only **three** consent categories are universal (present for any network): `terms`, `privacy`, `profile_creation`. Everything action-related is derived from config.

| `consent_category` | `action_type` | `action_stage` | `level` | When captured |
|---|---|---|---|---|
| `terms` | — | — | `user` | signup / login (only when needed) |
| `privacy` | — | — | `user` | same accept action as `terms` |
| `profile_creation` | — | — | `item` | before profile item is created |
| `action` | e.g. `connect`, `apply` (from `network.json`) | `initiate` | `item` | when the action is initiated |
| `action` | e.g. `connect`, `apply` (from `network.json`) | `accept` | `item` | when the action is accepted |

- **`terms` + `privacy` are two rows** written on the single "I agree" click. The statement is combined ("I agree to terms and conditions and privacy policy"), but each document carries its own version, so each is tracked as a separate row — this satisfies requirement #1 ("recorded separately").
- A network with only `apply` never produces `connect` rows. `orange_dot` (no actions) produces only `terms` / `privacy` / `profile_creation`. An action with no configured statement (e.g. `yellow_dot` `connect` today) captures no action-consent. **Adding or removing an action type requires zero code change** — it is purely config-driven.

---

## 3. Single table — `consent_record` (append-only)

One row per consent event. Append-only; the latest event per `(subject, type)` wins by `seq`, never by timestamp.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `seq` | bigserial NOT NULL | authoritative event order |
| `level` | text NOT NULL | `user` \| `item` — the user-vs-item differentiator |
| `consent_category` | text NOT NULL | `terms` \| `privacy` \| `profile_creation` \| `action` (closed, universal set) |
| `action_type` | text NULL | only for `action` (e.g. `connect`, `apply`) — derived from `network.json` |
| `action_stage` | text NULL | only for `action`: `initiate` \| `accept` |
| `user_id` | text NOT NULL | the authenticated user who gave consent (always known in v1) |
| `item_id` | text NULL | set for the item-level rows (profile + action) |
| `action_id` | text NULL | set for `action` rows (per the "both item_id + action_id" decision) |
| `network` | text NOT NULL | server-derived (never trusted from the request body) |
| `brand` | text NULL | which brand variant of the config applied (config is brand-overridable) |
| `document_version` | int NOT NULL | the version the user accepted (= `current_version` at accept time). **Content is NOT stored** — it is looked up from `consent.json` by `(type, version)` when needed (see §4). |
| `source` | text NOT NULL | `signup` \| `login` \| `profile` \| `action` (the occasion of capture) |
| `accepted_at` | timestamptz NOT NULL | the consent timestamp |
| `created_at` | timestamptz NOT NULL default now() | row insert time |
| `metadata` | jsonb NULL | extensibility |

> **Storage decision (resolved):** the row stores only the consent **type + version**, not the text. The literal content is recovered from `consent.json` via `(type, version)` lookup, which is safe because the config retains every version (§4). This keeps rows small and avoids duplicating full document markdown per user per acceptance.

**Levels & keys:**

| Category | level | keys stored |
|---|---|---|
| `terms` | `user` | `user_id` |
| `privacy` | `user` | `user_id` |
| `profile_creation` | `item` | `user_id` + `item_id` (the profile being created) |
| `action` / `initiate` | `item` | `user_id` + `item_id` (initiator's item) + `action_id` |
| `action` / `accept` | `item` | `user_id` + `item_id` (receiver's item) + `action_id` |

**Indexes:**
- `(user_id, consent_category, action_type, action_stage, seq desc)` — latest-event lookup per user (drives "needs_consent" for terms/privacy).
- `(item_id, consent_category)` — "all consents for this item".
- `(action_id)` — "consent for this action".

**Conventions:** Postgres via Drizzle; schema in `apps/api/db/postgres/schema/`; migration generated via `pnpm db:generate:api` (or the idempotent SQL-script path under `packages/database/src/utils/sql_scripts/`, matching the existing two-layer migration approach in `docs/operations/migrations.md`). **Never hand-edit migrations.**

---

## 4. Consent-content config — `consent.json` (per-network default + per-brand override)

The consent text moves **out of `network.json`** into a new `consent.json`, scoped **per-network with per-brand override** — mirroring the existing `brand.json` override-and-inherit merge (`2026-06-25-brand-specific-deployments-design.md`): the network folder holds the default; a brand declares only the deltas, merged over the network default. Ships as a configmap, same as the other schema config.

**Version history is retained in the config (resolved decision).** Each document holds a `current_version` (the active/required one) and an **append-only `versions` array**. Nothing is ever edited or removed in place; a new version is a new array entry. This is what lets a `consent_record` row storing only `(type, version)` always resolve its exact content later.

**`examples/schemas/blue_dot/consent.json`** (network default — `blue_dot` has both `connect` and `apply`):

```jsonc
{
  "documents": {
    "terms": {
      "current_version": 2,
      "versions": [
        { "version": 1, "title": "Terms of Service", "content": "# Terms …(v1 markdown)", "effective_from": "2026-06-01" },
        { "version": 2, "title": "Terms of Service", "content": "# Terms …(v2 — current)", "effective_from": "2026-07-01" }
      ]
    },
    "privacy": {
      "current_version": 1,
      "versions": [
        { "version": 1, "title": "Privacy Policy", "content": "# Privacy …", "effective_from": "2026-06-01" }
      ]
    },
    "profile_creation": {
      "current_version": 1,
      "versions": [
        { "version": 1, "statement": "The information collected will be used to match you with services and opportunities. You can opt out anytime by pausing, or deleting your profile in the portal. Tap \"I agree to continue\".", "effective_from": "2026-06-01" }
      ]
    }
  },
  "actions": {
    "connect": {                                  // present only if this network defines `connect`
      "initiate": {
        "current_version": 1,
        "versions": [
          { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider if they accept my request. The request may be cancelled at any time.", "effective_from": "2026-06-01" }
        ]
      },
      "accept": {
        "current_version": 1,
        "versions": [
          { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider.", "effective_from": "2026-06-01" }
        ]
      }
    },
    "apply": {
      "initiate": { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider if they accept my request. The request may be cancelled at any time.", "effective_from": "2026-06-01" } ] },
      "accept":   { "current_version": 1, "versions": [ { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider.", "effective_from": "2026-06-01" } ] }
    }
  }
}
```

- **`documents`** — the universal `terms` / `privacy` (full markdown `content`, rendered in the tabbed popup) and `profile_creation` (a single inline `statement`).
- **`actions`** — keyed by the network's **own** action types. A network only declares the action keys it actually has. A network with no actions (e.g. `orange_dot`) omits `"actions"` entirely; a `connect`-only network (`purple_dot`, `yellow_dot`) omits `apply`.
- **Per-interaction override:** `purple_dot` `connect` has different statements per interaction variant (seeker→provider vs provider→provider). The action stage entry supports an optional per-interaction override keyed by `(from_domain, to_domain)`, so no existing wording is lost. Default is per-action-stage; the override is opt-in.
- **`reveals_pii_on_status` stays in `network.json`.** It is PII-reveal gating logic tied to the event status enum, not consent text. Only `consent_text_initiator` / `consent_text_receiver` move to `consent.json`. Validation for the moved fields is added to the `consent.json` loader/schema; the corresponding `network_workflow.ts` fields are deprecated and removed once the loader reads from `consent.json`.

### 4.1 `current_version` semantics — display, capture, and re-consent

- **Display:** the UI always renders the content of `current_version`, looked up from the `versions` array by that number. If an operator sets `current_version` back to `1` while `2` exists, the UI shows **v1** — the older version is fully usable because it is retained.
- **Capture:** on accept, the row records **exactly the version that was shown** (= `current_version` at accept time). Roll back to v1 → new acceptances store `version = 1`.
- **Re-consent trigger (`needs_consent`):** a user needs to consent when they have **no acceptance row for the current `current_version`** of that document. This is correct in both directions: a forward bump (v1→v2) re-prompts everyone who only accepted v1; a rollback (v2→v1) re-prompts users who only accepted v2, so everyone converges on the active version. (Not "accepted version ≠ current" — specifically "no row equal to current".)

### 4.2 Adding a new version of any content

1. Open the relevant `consent.json` (network default, or the brand's override file).
2. **Append** a new object to that document's `versions` array with `version = max + 1`, the new `title`/`content` (or `statement`), and `effective_from`. **Never edit or delete existing version entries.**
3. Bump that document's `current_version` to the new number (or to any existing number, to roll back).
4. Deploy the config (configmap). On next login, users without an acceptance row for the new `current_version` are re-prompted; historical acceptances still resolve their old content from the retained `versions` entry.

### 4.3 Per-brand override

A brand declares only the documents it changes, in its own `consent.json` under the brand folder, merged over the network default **per document** (a brand-provided document node replaces that whole document's `current_version` + `versions`; everything not mentioned inherits the network default).

**`examples/schemas/blue_dot/upsdm/consent.json`** (UPSDM overrides only privacy):

```jsonc
{
  "documents": {
    "privacy": {
      "current_version": 1,
      "versions": [
        { "version": 1, "title": "UPSDM Privacy Policy", "content": "# UPSDM Privacy …", "effective_from": "2026-06-15" }
      ]
    }
  }
}
```

→ UPSDM gets `terms`, `profile_creation`, and all actions from the `blue_dot` default; `privacy` is the UPSDM one. The `brand` column in `consent_record` records which variant applied, so a version int is always resolved against the right (network-or-brand) document.

**Loading & serving (per §1.1):** the backend loads `consent.json` alongside `network.json` (local file in dev; schema-registry/remote URL in prod) and caches it in the schema pipeline as a `kind: 'consent_config'` entry served by `GET /api/v1/network/schemas`. When the deployment is configured with a brand that has an override file, the backend also caches a **brand-scoped** `consent_config` entry (tagged with the brand). The **UI performs the per-document merge** of network-default + brand entries — the backend does not merge, because it has no brand concept at request time (§1.1).

---

## 5. Flows

### A. Terms & privacy (user-level)

Replace the implicit footer with explicit capture. **Popup = layout Variant A (top segmented tabs: `Privacy Policy` | `Terms of Service`)**, styled with the **existing theme tokens/classes** (`bg-brand-cta`, `--primary`, etc.) so it themes per network automatically — no hardcoded colors. Prototype: `docs/superpowers/prototypes/consent-popup-prototype.html`.

**Behavior (confirmed):**
- **Gate on `Continue`.** When the user clicks `Continue` on the sign-in page: if they have **not** accepted the current version of terms/privacy (new user, or a version bump since their last acceptance), the popup opens and must be accepted before the flow proceeds (OTP send). If they **have** accepted the current versions, `Continue` proceeds with **no popup** ("only when needed").
- **Determining need pre-OTP:** the sign-in flow already calls the OTP `check-user` step; that response is extended to also carry the identified user's accepted terms/privacy versions (null for a new user). The UI compares them against the merged config `current_version` (§4.1) to decide whether to show the popup. Acceptance is **persisted via `POST /consent/accept` immediately after OTP verify** (when `user_id` exists); for a brand-new user the user_id is created at verify, then the held acceptance is written.
- **Footer links are always available.** "By continuing you agree to the `Privacy Policy` and `Terms`." — both are links; clicking `Privacy Policy` opens the popup on the **Privacy tab**, `Terms` opens it on the **Terms tab** (read-only view; available to any user anytime, independent of the gate).
- **Content is Markdown**, rendered (sanitized) in the popup tabs and on the `/privacy` `/terms` pages. If the UI has no Markdown renderer, add one (sanitized GFM, raw HTML stripped) as part of Phase 2.
- **Re-consent applies to terms/privacy ONLY.** A `current_version` bump re-opens the popup on next `Continue`. **Profile creation, connect, and apply consent are ALWAYS asked** every time the action occurs — there is no "already accepted, skip" for those (see §5B, §5C).
- The `Privacy Policy` / `Terms` links open a **modal with two tabs** (privacy + terms content from `consent.json`), with **one checkbox + Accept button**. The checkbox is **never pre-checked**.
- **`GET /api/v1/consent/status`** returns the user's accepted versions; the UI compares them against the merged config's `current_version` per document to decide whether to show the modal. New user, or a version bump since their last acceptance → the modal must be cleared before continuing. A returning user already on the current version is **not interrupted** ("only when needed"). Gating is computed client-side (§1.1).
- Consent is recorded via **`POST /api/v1/consent/accept`** **right after OTP verify** (when `user_id` exists), writing the `terms` + `privacy` rows. This keeps the better-auth OTP plugin untouched — no need to thread consent through `unified_otp.ts`.
- The legacy `terms_accepted` / `privacy_accepted` booleans **stop being hardcoded `true`**; they are set from the accept call for backward compatibility. The `consent_record` table is the system of record; the booleans are deprecated (column removal deferred to a later cleanup, consistent with the canonical spec's stance).
- Build the missing **`/privacy`** and **`/terms`** routes/pages so the footer links resolve (today → blank). These render the same `consent.json` content as the popup tabs.

**Capture timing note:** there is no `user_id` until OTP verify completes. The popup acceptance is collected client-side during the sign-in flow and persisted via `POST /consent/accept` immediately after the session is established. The app does not proceed past the gate until the accept call succeeds.

### B. Profile creation (item-level)

**Always asked** on profile creation (no version-based skip — the profile is created once, and consent is captured at that moment). RJSF (`@rjsf/shadcn`) does **not** expose a public `isValid` / `formState.isValid`. We compute validity with the RJSF AJV validator (`validator.isValid(schema, formData, rootSchema)`) on each `onChange`.

- Hide RJSF's built-in submit button (`ui:submitButtonOptions` norender) and render a **custom footer**:
  - The `profile_creation` statement + checkbox **appear only when all required fields validate clean** (no validation error).
  - The custom submit button stays **disabled until valid AND checked**.
- **`POST /api/v1/item/create`** accepts an optional consent payload `{ category: 'profile_creation', version }` (version = the `current_version` the UI displayed) and writes the `profile_creation` row with the new `item_id` **after** the item is created — atomic with creation, so the consent row always has a real `item_id`. The server validates the submitted version equals the current `current_version` (rejects a stale client).

### C. Connect / apply (item-level)

**Always asked** each time an action is initiated or accepted (no version-based skip — consent is per-action). Keep the existing `ConsentCheckbox` + network-driven UI (`action-modal.tsx` for initiate, `action-status-updater.tsx` / `bulk-status-dialog.tsx` for accept), but **source the statement text from `consent.json`** instead of `network.json`.

- `perform_action.ts` (initiate) writes a `consent_record` row: `category=action`, `action_type`, `action_stage=initiate`, `item_id` (initiator's item), `action_id`, `document_version`.
- `update_action_status.ts` (accept) writes the `accept` row analogously, with the receiver's `item_id`.
- The existing `action_events.event_payload` consent snapshot is **kept** (no regression) — the new table is the queryable system of record; the event payload remains for the event-history view.
- PII reveal continues to be gated by `reveals_pii_on_status` in `network.json`, unchanged.

---

## 6. API surface (v1)

Minimal, Signals-internal (no service-to-service auth — same app):

- `GET /api/v1/consent/status?network=` — auth. Returns, per universal `consent_category`, the user's **latest accepted version** (raw — no gating verdict, since `current_version` lives in the UI-merged config). The UI computes `needs_consent` = **no accepted version equal to the document's current `current_version`** (§4.1) by comparing this response against the merged config.
- `POST /api/v1/consent/accept` — auth. Body: `{ network, brand, items: [{ category, version }] }` — one entry per document accepted (e.g. `terms` v1, `privacy` v1). Writes one row per item. `network` is validated against the instance's `served_domains`; `brand`/`version` are recorded as supplied.
- `POST /api/v1/item/create` — **extended** with an optional `consent: { category: 'profile_creation', version, brand }`; writes the `profile_creation` row with the new `item_id`, `network` derived from the created item.
- `perform_action` / `update_action_status` — **extended** to write the `action` rows. The existing `consent` payload changes from `{ acknowledged, text }` to `{ acknowledged, version, brand }` (text no longer stored); `network`/`item_id`/`action_id` are derived server-side from the action.
- **Consent config is served, not a bespoke endpoint** — it rides the existing `GET /api/v1/network/schemas?network=` response as `kind: 'consent_config'` (network default) plus a brand-scoped entry when configured. The `/privacy` & `/terms` pages and the popup read from that (public, pre-login, same as network config today).

Error codes are machine-readable; routes never throw across boundaries (existing repo convention).

---

## 7. Migration & backward compatibility

- **No backfill.** Existing users are re-prompted at their next login if a current version isn't recorded (truthful ledger — no fabricated historical acceptances).
- Stop hardcoding `terms_accepted` / `privacy_accepted` in `unified_otp.ts`; set them from `POST /consent/accept`. Relax/deprecate the booleans (read paths move to the table; column removal deferred).
- Move `consent_text_initiator` / `consent_text_receiver` from `network.json` to `consent.json`; deprecate those `network_workflow.ts` fields once the loader reads from `consent.json`. **No API response shape changes** (nothing returns those fields directly today).
- `reveals_pii_on_status` is untouched.

---

## 8. Testing

- **Unit:** `needs_consent` logic (no row for `current_version`, incl. the rollback case where the user only accepted a higher version); `current_version` display/capture resolution; profile-form validity gate (checkbox hidden until valid, submit disabled until valid AND checked); brand-override per-document merge of `consent.json`; version-history immutability check; action-type derivation from `network.json` (network with only `connect`, only `apply`, both, none).
- **Integration:** `POST /consent/accept` writes the correct `terms` + `privacy` rows with versions; `GET /consent/status` returns needs-consent correctly across new/returning/version-bumped users; profile-create records the item-level row with the real `item_id`; action perform/accept record rows with `item_id` + `action_id` + derived `action_type`/`action_stage`; per-interaction statement override resolves for `purple_dot`.
- **UI:** tabbed privacy/terms popup, checkbox not pre-checked, gate blocks continue until accepted; profile checkbox appears only when the form is valid; `/privacy` and `/terms` routes resolve and render config content.

---

## 9. Resolved decisions (previously open)

These two were flagged as open questions and have now been decided by the reviewer:

### Decision 1 — version content retention → **version history in the config**

`consent.json` retains an **append-only `versions` array** per document; nothing is overwritten (§4). Any historical version is renderable for anyone, and a `consent_record` row storing only `(type, version)` always resolves its exact content. Cost accepted: the config file grows over time, and authors must never edit or delete past `versions` entries (enforced by review + a loader/schema check that `versions` are monotonic and immutable relative to the prior deploy where feasible).

*(The canonical cross-DPG spec achieves the same with immutable versioned `consent_document` rows in a DB. v1 is config-file-driven, hence version history lives in the file.)*

### Decision 2 — do **not** store full document text per user → **type + version only**

Each `consent_record` row stores only the consent **type + version** (no content, not even the short statement line). The full content is recovered from `consent.json` by `(type, version)` lookup, which is safe precisely because Decision 1 retains every version. This keeps rows small and avoids duplicating document markdown per user per acceptance.

---

## 10. Phasing (single plan, or split if the reviewer prefers)

1. **Schema + config layer** — `consent_record` table; `consent.json` loader with per-brand override; move action text out of `network.json`; seed v1 `consent.json` per network.
2. **Terms & privacy** — `GET /consent/status`, `POST /consent/accept`, tabbed popup + login gate, `/privacy` & `/terms` pages, stop hardcoding the booleans.
3. **Profile creation** — RJSF validity gate + custom footer checkbox; extend `item/create` to record the row.
4. **Connect / apply** — source statements from `consent.json`; record `action` rows in `perform_action` / `update_action_status`.
