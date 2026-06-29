# Decrypted Profile Export (Signals + Aggregator)

**Date:** 2026-06-26
**Status:** Approved (design) — pending implementation plan
**Repos:** Signals-DPG (new admin endpoint) + aggregator-dpg (export integration)
**Branch (both):** `feat/profile-export-decrypted`

## Problem

The aggregator dashboard's "Export CSV" downloads the **dashboard rollup** (status/metrics). Operators also need to download the participants' **full profile data**. That data lives in signals, where private profile fields are stored **encrypted** (`items.item_private_state`, AES-256-GCM) and the public `items.item_state` holds those fields **masked** (e.g. `name: "V***"`). Every existing inter-instance fetch returns masked/encrypted data, so the aggregator cannot today produce a usable profile export.

We need: a signals **admin endpoint that returns decrypted `item_state`** for given item_ids (scoped to the calling aggregator's own participants), and an aggregator **"Export profile data"** action that sends the selected rows' item_ids, gets the decrypted profiles, and downloads them as CSV.

Server-side decryption is feasible: signals holds a symmetric key (`SIGNALS_PII_KEY`) and already has `decryptItemPrivate()` (used by `GET /admin/participant`, `POST /admin/participant`, and the dashboard display-name path).

## Goals

- New signals admin endpoint returning **decrypted** profile `item_state`, accepting **either** a set of `item_ids` **or** a `user_id` — both modes implemented now. (The aggregator UI uses `item_ids` first; `user_id` is for later UI use.)
- Aggregator "Export profile data" downloads a **separate** CSV of decrypted profiles for the **selected** dashboard rows.
- Decrypted PII is exposed only to the aggregator that **onboarded** those participants (`onboarded_by_org_id`); `network_service` may read all.
- No browser ever holds the signals admin key — the decrypt call is server-to-server.

## Non-goals

- No change to the existing dashboard rollup export (`/v1/dashboard/export`) — the profile export is a separate, sibling option.
- No end-to-end / per-user key encryption change — decryption stays server-side with the existing `SIGNALS_PII_KEY`.
- No new permission/role concept — authorization reuses the existing two-header + acting-org scoping.
- The signals endpoint **fully implements both `item_ids` and `user_id` modes now** (both functional + tested). "Future" applies only to the **aggregator UI**, which uses `item_ids` for now and will surface the `user_id` mode later — no signals-side stub.

## Key decisions

| Decision | Choice |
| --- | --- |
| UI delivery | **Separate "Export profile data" CSV** (sibling to existing Export CSV) |
| Export scope | **Selected rows** (send their item_ids) |
| Signals endpoint | **New dedicated** `POST /api/v1/admin/participant/decrypt` (item_ids now, user_id future) |
| PII access scope | **Aggregator's own onboarded items only**; `network_service` = all |
| Response shape | `{ profiles: [...], skipped: string[] }` — keep `skipped` (informational) |
| Export build location | **Server-side** (aggregator API); browser never holds the admin key |

---

## Part A — Signals changes

### A1. New endpoint: `POST /api/v1/admin/participant/decrypt`

Registered in `apps/api/src/routes/v1/admin/admin_routes.ts` (same `auth_middleware` + `acting_org_preHandler` preHandlers as the other admin routes). Org types allowed: `aggregator`, `network_service` (reject others with `403 NOT_AGGREGATOR`-style error, matching `participant_read.ts`).

**Request schema** — new file `packages/schemas/src/admin/participant_decrypt.ts`, exported from `packages/schemas/src/index.ts`. Exactly one of:
- `{ item_ids: string[] }` — 1..N uuids (used now)
- `{ user_id: string }` — (future)

Validate that exactly one is present (Zod refine; reject both/neither with `400`).

**Handler** (`apps/api/src/routes/v1/admin/participant_decrypt.ts`):
- **`item_ids` path:** load matching rows by joining `items` to `item_metrics` on `item_id` — partition-pruned with `inArray(items.item_network, apiConfig.served_domains-derived networks)` + `inArray(items.item_id, item_ids)` (mirrors `participant_read.ts:158-162`). Select `items.{item_id, item_network, item_domain, item_type, item_state, item_private_state, created_at, updated_at}` + `item_metrics.onboarded_by_org_id`.
- **Scoping (per mode — different source tables):**
  - `item_ids` mode scopes on **`item_metrics.onboarded_by_org_id`** (`metrics.ts:26`; `item_metrics.item_id` is the PK == `items.item_id`). For `org_type === 'aggregator'`, add `eq(item_metrics.onboardedByOrgId, acting_org.org_id)` to the WHERE — this is the **same table the dashboard scopes by**, so "decryptable" == "visible on your dashboard." For `network_service`, drop that clause (keep all).
  - `user_id` mode scopes on **`user.onboarded_by_org_id`** — the exact chain `participant_read.ts:118-127` uses (look up user, check `user.onboardedByOrgId === acting_org.org_id`, else `items: []`; `network_service` skips the check).
- **Decrypt:** for each kept row call `decryptItemPrivate()` (`apps/api/src/utils/item_decrypt.ts`) → `mergedState`. Drop `item_private_state` before returning.
- **`skipped`:** any requested `item_id` not present in the kept set (not found, not in a served network, OR not owned) → added to `skipped` (no distinction, to avoid leaking existence of other aggregators' items).
- **`user_id` path:** reuse the existing `readItemsForUser` decrypt logic (the same function `participant_read.ts` uses), applying the `user.onboarded_by_org_id` scoping above; `skipped` is `[]`.
- **Audit:** emit one **structured audit log entry** per call via `request.log.info` with a stable marker (`operation: 'admin.participant.decrypt'`, `acting_org_id`, `org_type`, `mode` (`item_ids`/`user_id`), `requested_count`, `returned_count`, `skipped_count`) — this exposes raw PII so the call must be traceable. We deliberately do **not** reuse the `pii_reveal_audit` table: its columns (`action_id`, `revealed_action_type`, `revealed_action_status_at_view`) are all `NOT NULL` and action-scoped, so a bulk item_ids/user_id reveal doesn't fit without a schema change. A durable DB audit table is a follow-up, out of scope here.

**Response** (`200`): `{ profiles: ParticipantDecryptedSnapshot[], skipped: string[] }` where each snapshot is `{ item_id, item_network, item_domain, item_type, item_state /* decrypted, full cleartext */, created_at, updated_at }`. `item_private_state` is never serialized. **Invariant (item_ids mode):** every requested id appears in exactly one of `profiles` or `skipped`, so `len(profiles) + len(skipped) == len(distinct item_ids requested)`.

### A2. Signals files

- New: `packages/schemas/src/admin/participant_decrypt.ts` (+ export in `index.ts`)
- New: `apps/api/src/routes/v1/admin/participant_decrypt.ts` (route + handler)
- Modify: `apps/api/src/routes/v1/admin/admin_routes.ts` (register route)
- Reuse: `apps/api/src/utils/item_decrypt.ts` (`decryptItemPrivate`), `apps/api/src/middleware/acting_org.ts`, the `readItemsForUser` query pattern.
- Config: `SIGNALS_PII_KEY` must be set (already validated in `packages/config/src/secrets.ts`).

---

## Part B — Aggregator changes

### B1. signalstack-writer (base-class pattern: base + http + memory + testing)

New method on `SignalStackWriterBase` (`packages/signalstack-writer/src/interface.ts`):
```
abstract fetchDecryptedProfiles(
  input: { actingOrgId: string; itemIds: string[] },
): Promise<Result<{ profiles: SignalStackDecryptedProfileRow[]; skipped: string[] }, BaseError>>
```
with `SignalStackDecryptedProfileRow = { item_id, item_network, item_domain, item_type, item_state, created_at, updated_at }`.
- `http.ts`: `POST {baseUrl}/api/v1/admin/participant/decrypt` with `x-api-key` (`SIGNALSTACK_ADMIN_KEY`) + `x-acting-org-id: input.actingOrgId`, body `{ item_ids }`, via `requestWithRetry`; non-2xx → `UpstreamError`.
- `memory.ts`: resolve `itemIds` from seeded profiles, return their `item_state`; unknown ids → `skipped`.
- `testing.ts`: inherits the in-memory impl (no change unless a pinned-response seed is needed).

### B2. Aggregator API route: `POST /v1/dashboard/export/profiles`

In `apps/api/src/routes/dashboard.ts` (`registerDashboardRoutes`):
- Body schema: `{ item_ids: string[] (1..N), domain: string }`.
- `requireApprovedAuth(req)` + the existing `resolveActingOrgId(auth, log)` (JWT `signalstackOrgId` → `aggregatorStore` fallback).
- `ss.fetchDecryptedProfiles({ actingOrgId, itemIds })`.
- Build CSV: columns = `item_id` + the **union of decrypted `item_state` keys** across the returned profiles, stable order (`name`, `phone` first, then the rest sorted), reusing the `csvField()` / CRLF pattern from `apps/web/src/services/participant-csv.ts` (or a small server-side equivalent in `apps/api/src/services/csv-template/`).
- Respond `text/csv` with `Content-Disposition: attachment; filename="profiles-<domain>-<date>.csv"`.

### B3. Web BFF + service + UI

- BFF: new `apps/web/src/app/api/dashboard/export/profiles/route.ts` — relays the CSV (mirrors `apps/web/src/app/api/dashboard/export/route.ts`, `POST` with `{ item_ids, domain }`).
- Service: add `dashboardExportProfiles({ domain, itemIds })` to `DashboardService` + `HttpDashboardService` (`apps/web/src/services/dashboard.service.ts`).
- UI: new **bulk action `export_profile_data`** ("Export profile data") in `apps/web/src/services/bulk-actions.ts` (`kind: 'server'`) — collects selected rows' `item_id`s, filtering synthetic `row-*` ids (`!id.startsWith('row-')`), calls `dashboardExportProfiles`, triggers download. Sits next to `export_selected_csv`. New i18n key `bulk.exportProfileData`.

### B4. Aggregator files

- Modify: `packages/signalstack-writer/src/{interface,http,memory}.ts` (+ testing if needed)
- Modify: `apps/api/src/routes/dashboard.ts` (new route)
- New: `apps/web/src/app/api/dashboard/export/profiles/route.ts`
- Modify: `apps/web/src/services/dashboard.service.ts`, `apps/web/src/services/bulk-actions.ts`, i18n messages
- Reuse: `resolveActingOrgId`, the CSV escaper, `getSignalStackWriter()`. Env already wired: `SIGNALSTACK_BASE_URL` + `SIGNALSTACK_ADMIN_KEY` + per-aggregator `signalstackOrgId`.

---

## Data flow

```
Dashboard (tick rows) → collect item_ids (drop row-* synthetic ids)
  → web BFF POST /api/dashboard/export/profiles { item_ids, domain }
    → aggregator API POST /v1/dashboard/export/profiles  (requireApprovedAuth → resolveActingOrgId)
      → signalstack-writer.fetchDecryptedProfiles({ actingOrgId, itemIds })
        → signals POST /api/v1/admin/participant/decrypt  (x-api-key + x-acting-org-id)
          → load items (served networks + item_ids) → scope to acting org → decryptItemPrivate → { profiles, skipped }
      ← decrypted profiles → aggregator builds CSV (text/csv)
  ← CSV relayed → browser download
```

## Security / PII

- Decrypted PII is returned only for the **acting aggregator's onboarded participants**; cross-aggregator/unknown ids land in `skipped` (no existence leak). `network_service` may read all.
- The signals admin key (`SIGNALSTACK_ADMIN_KEY`) never reaches the browser — the decrypt call is aggregator-API → signals only; the CSV transits server-side until the operator's download.
- Signals emits an **audit event** per decrypt call (acting org + count).
- `item_private_state` is never serialized in any response.

## Testing

**Signals:**
- Endpoint unit tests: aggregator gets only its onboarded items; `network_service` gets all; not-owned/unknown ids → `skipped`; decryption correctness (private fields cleartext, public unchanged); `user_id` path; exactly-one-of validation (400).
- Use the existing PII test key + `item_decrypt` test patterns.

**Aggregator:**
- `signalstack-writer` fake + http unit tests for `fetchDecryptedProfiles` (success, skipped, upstream error → `UpstreamError`).
- API route test: CSV columns/escaping from decrypted profiles; acting-org resolution; empty `item_ids` → 400.
- Web: bulk-action collects only real item_ids (drops `row-*`); BFF relay.

## Verification

- Signals: `POST /api/v1/admin/participant/decrypt { item_ids: [<owned>] }` with the aggregator key → decrypted `item_state` (e.g. real `name`/`phone`, not masked); a not-owned id → in `skipped`.
- Aggregator: select rows on the dashboard → "Export profile data" → CSV downloads with full decrypted profile columns for the selected participants.
