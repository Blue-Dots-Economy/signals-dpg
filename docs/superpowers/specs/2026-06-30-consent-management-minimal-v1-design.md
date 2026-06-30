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
| `document_version` | int NOT NULL | the version the user accepted |
| `consent_text` | text NOT NULL | the exact statement/line shown at the moment of consent (see Open Question 2 re: full document text) |
| `source` | text NOT NULL | `signup` \| `login` \| `profile` \| `action` (the occasion of capture) |
| `accepted_at` | timestamptz NOT NULL | the consent timestamp |
| `created_at` | timestamptz NOT NULL default now() | row insert time |
| `metadata` | jsonb NULL | extensibility (and the snapshot/hash fields if Open Question 1 resolves that way) |

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

The consent text moves **out of `network.json`** into a new `consent.json`, scoped **per-network with per-brand override** — mirroring the existing `brand.json` override-and-inherit merge (`2026-06-25-brand-specific-deployments-design.md`): the network folder holds the default; a brand declares only the deltas, deep-merged over the network default. Ships as a configmap, same as the other schema config.

```jsonc
{
  "documents": {
    "terms":            { "version": 1, "title": "Terms of Service", "content": "<sanitized markdown>" },
    "privacy":          { "version": 1, "title": "Privacy Policy",  "content": "<sanitized markdown>" },
    "profile_creation": { "version": 1, "statement": "The information collected will be used to match you with services and opportunities. You can opt out anytime by pausing, or deleting your profile in the portal. Tap \"I agree to continue\"." }
  },
  "actions": {
    "connect": {                                  // present only if this network defines `connect`
      "initiate": { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider if they accept my request. The request may be cancelled at any time." },
      "accept":   { "version": 1, "statement": "I agree to share my contact details (name, email, phone) with this seeker / provider." }
    },
    "apply": {
      "initiate": { "version": 1, "statement": "..." },
      "accept":   { "version": 1, "statement": "..." }
    }
  }
}
```

- **`documents`** — the universal `terms` / `privacy` (full markdown content, rendered in the tabbed popup) and `profile_creation` (a single inline statement).
- **`actions`** — keyed by the network's **own** action types. A network only declares the action keys it actually has.
- **Per-interaction override:** `purple_dot` `connect` has different statements per interaction variant (seeker→provider vs provider→provider). The action entry supports an optional per-interaction override keyed by `(from_domain, to_domain)`, so no existing wording is lost. Default is per-action; the override is opt-in.
- **`reveals_pii_on_status` stays in `network.json`.** It is PII-reveal gating logic tied to the event status enum, not consent text. Only `consent_text_initiator` / `consent_text_receiver` move to `consent.json`. Validation for the moved fields is added to the `consent.json` loader/schema; the corresponding `network_workflow.ts` fields are deprecated and removed once the loader reads from `consent.json`.
- **Versioning** — each document carries its own `version` int; bumping one (e.g. `terms`) does not force re-consent on the others. See Open Question 1 for content-retention handling.

The `consent.json` is loaded the same way `network.json` is, with the brand-override layer applied identically to `brand.json`. (Exact loader wiring is an implementation detail to confirm against the network-config loader during planning.)

---

## 5. Flows

### A. Terms & privacy (user-level)

Replace the implicit footer with explicit capture:

- The `Privacy Policy` / `Terms` links open a **modal with two tabs** (privacy + terms content from `consent.json`), with **one checkbox + Accept button**. The checkbox is **never pre-checked**.
- A new endpoint **`GET /api/v1/consent/status`** tells the UI whether the current versions are already accepted by this user. New user, or a version bump since their last acceptance → the modal must be cleared before continuing. A returning user already on the current version is **not interrupted** ("only when needed").
- Consent is recorded via **`POST /api/v1/consent/accept`** **right after OTP verify** (when `user_id` exists), writing the `terms` + `privacy` rows. This keeps the better-auth OTP plugin untouched — no need to thread consent through `unified_otp.ts`.
- The legacy `terms_accepted` / `privacy_accepted` booleans **stop being hardcoded `true`**; they are set from the accept call for backward compatibility. The `consent_record` table is the system of record; the booleans are deprecated (column removal deferred to a later cleanup, consistent with the canonical spec's stance).
- Build the missing **`/privacy`** and **`/terms`** routes/pages so the footer links resolve (today → blank). These render the same `consent.json` content as the popup tabs.

**Capture timing note:** there is no `user_id` until OTP verify completes. The popup acceptance is collected client-side during the sign-in flow and persisted via `POST /consent/accept` immediately after the session is established. The app does not proceed past the gate until the accept call succeeds.

### B. Profile creation (item-level)

RJSF (`@rjsf/shadcn`) does **not** expose a public `isValid` / `formState.isValid`. We compute validity with the RJSF AJV validator (`validator.isValid(schema, formData, rootSchema)`) on each `onChange`.

- Hide RJSF's built-in submit button (`ui:submitButtonOptions` norender) and render a **custom footer**:
  - The `profile_creation` statement + checkbox **appear only when all required fields validate clean** (no validation error).
  - The custom submit button stays **disabled until valid AND checked**.
- **`POST /api/v1/item/create`** accepts an optional consent payload `{ category: 'profile_creation', version, statement }` and writes the `profile_creation` row with the new `item_id` **after** the item is created — atomic with creation, so the consent row always has a real `item_id`.

### C. Connect / apply (item-level)

Keep the existing `ConsentCheckbox` + network-driven UI (`action-modal.tsx` for initiate, `action-status-updater.tsx` / `bulk-status-dialog.tsx` for accept), but **source the statement text from `consent.json`** instead of `network.json`.

- `perform_action.ts` (initiate) writes a `consent_record` row: `category=action`, `action_type`, `action_stage=initiate`, `item_id` (initiator's item), `action_id`, `document_version`.
- `update_action_status.ts` (accept) writes the `accept` row analogously, with the receiver's `item_id`.
- The existing `action_events.event_payload` consent snapshot is **kept** (no regression) — the new table is the queryable system of record; the event payload remains for the event-history view.
- PII reveal continues to be gated by `reveals_pii_on_status` in `network.json`, unchanged.

---

## 6. API surface (v1)

Minimal, Signals-internal (no service-to-service auth — same app):

- `GET /api/v1/consent/status` — auth. Returns, per universal `consent_category`, the user's latest accepted version (if any) and whether re-consent is needed against the current `consent.json` versions. Drives the login gate.
- `POST /api/v1/consent/accept` — auth. Body carries the categories + versions being accepted (e.g. `terms` v1, `privacy` v1). Writes one row per accepted document. Used by the signup/login gate.
- `POST /api/v1/item/create` — **extended** to accept an optional consent payload and write the `profile_creation` row.
- `perform_action` / `update_action_status` — **extended** to write the `action` rows (the consent payload already flows through these routes today).
- `GET /api/v1/consent/content?network=&brand=` *(optional, if the UI needs the resolved config client-side)* — returns the merged `consent.json` for rendering popups/pages. Public (pre-login) for the privacy/terms pages.

`network` is always server-derived. Error codes are machine-readable; routes never throw across boundaries (existing repo convention).

---

## 7. Migration & backward compatibility

- **No backfill.** Existing users are re-prompted at their next login if a current version isn't recorded (truthful ledger — no fabricated historical acceptances).
- Stop hardcoding `terms_accepted` / `privacy_accepted` in `unified_otp.ts`; set them from `POST /consent/accept`. Relax/deprecate the booleans (read paths move to the table; column removal deferred).
- Move `consent_text_initiator` / `consent_text_receiver` from `network.json` to `consent.json`; deprecate those `network_workflow.ts` fields once the loader reads from `consent.json`. **No API response shape changes** (nothing returns those fields directly today).
- `reveals_pii_on_status` is untouched.

---

## 8. Testing

- **Unit:** `needs_consent` logic (no record / older version / current version already accepted); per-document version compare; profile-form validity gate (checkbox hidden until valid, submit disabled until valid AND checked); brand-override deep-merge of `consent.json`; action-type derivation from `network.json` (network with only `connect`, only `apply`, both, none).
- **Integration:** `POST /consent/accept` writes the correct `terms` + `privacy` rows with versions; `GET /consent/status` returns needs-consent correctly across new/returning/version-bumped users; profile-create records the item-level row with the real `item_id`; action perform/accept record rows with `item_id` + `action_id` + derived `action_type`/`action_stage`; per-interaction statement override resolves for `purple_dot`.
- **UI:** tabbed privacy/terms popup, checkbox not pre-checked, gate blocks continue until accepted; profile checkbox appears only when the form is valid; `/privacy` and `/terms` routes resolve and render config content.

---

## 9. Open questions (for reviewer)

### Open Question 1 — version content retention

`consent.json` is **mutable config**. When a document is bumped (e.g. `terms` v1 → v2) the file is overwritten in place, so the **literal content of v1 is lost at runtime**, even though we still store `document_version = 1` against past acceptances. We can always tell *which version* a user accepted, but not necessarily *reproduce what that version said* at runtime. Three resolutions, with trade-offs — **reviewer to pick:**

1. **Snapshot into the table.** At acceptance, copy the exact title + content (and a content hash) into the `consent_record` row. Each row becomes self-contained legal proof of what *that user* agreed to, even after the file changes. The config stays small; git history of `consent.json` preserves authored versions for reference. *Limitation:* you cannot re-render an arbitrary historical version for someone who never accepted it (only what was accepted is retained).
2. **Version history in the config.** `consent.json` keeps an append-only list of all versions per document; nothing is ever overwritten; the table stores only the version int and looks content up from the config. Any historical version is renderable for anyone, but the file grows over time and authors must never edit past entries.
3. **Both.** Full history in the config *and* snapshot in the table. Maximum fidelity (re-render any historical version for anyone, plus per-user proof), at the cost of more moving parts and storage.

*(The canonical cross-DPG spec resolves this with immutable versioned `consent_document` rows in a DB — option (2)/(3) in DB form. v1 is config-file-driven, hence the trade-off.)*

### Open Question 2 — store the full consent document text per user?

Distinct from Open Question 1's *mechanism* choice: should each `consent_record` row store the **complete document text** the user agreed to (the full markdown of terms / privacy, not just the short statement line), or is storing the **short statement + version int** sufficient for v1?

- **Store full text per user** — strongest audit/legal posture: every acceptance row is a complete, self-contained record of exactly what the user read. Costs storage (full terms/privacy markdown duplicated per user per acceptance) and is the heavier option.
- **Store statement + version only** — leaner: the row records the version int and the short statement line; the full document content is recovered from the config (or from the snapshot, if Open Question 1 chose option 1/3). Lighter, but relies on the config/version lookup to reconstruct the full text.

**Reviewer to decide whether full per-user text storage is required for v1.** (Note this interacts with Open Question 1: if (1)/(3) snapshots full content into the row, that already satisfies "full text per user".)

---

## 10. Phasing (single plan, or split if the reviewer prefers)

1. **Schema + config layer** — `consent_record` table; `consent.json` loader with per-brand override; move action text out of `network.json`; seed v1 `consent.json` per network.
2. **Terms & privacy** — `GET /consent/status`, `POST /consent/accept`, tabbed popup + login gate, `/privacy` & `/terms` pages, stop hardcoding the booleans.
3. **Profile creation** — RJSF validity gate + custom footer checkbox; extend `item/create` to record the row.
4. **Connect / apply** — source statements from `consent.json`; record `action` rows in `perform_action` / `update_action_status`.
