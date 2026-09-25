# Bulk export of engagement counterparties (SS-5)

**Date:** 2026-09-24
**Status:** draft — for review
**Issue:** signals-dpg#639 (SS-5 tracking; Q1–Q8 answered 2026-09-02)
**Branch:** `feat/639-bulk-engagement-export` (from `feature`)

---

## 1. Problem

A provider needs the data of the people they are engaged with, in bulk, to act
on it in their own fulfilment systems. Today the only route is
`GET /api/v1/action/:id/contact-details`, one record at a time.

The v1 ask is narrow — providers, accepted engagements, all fields, CSV — but
every one of those four is expected to widen (seekers, other statuses,
field-level selection, other formats). This design ships the narrow v1 through
**one endpoint whose request shape already carries the wider cases**, so each
widening is a request value or a `network.json` entry, not a new API.

## 2. Decisions carried in from #639

| Q | Answer | How this design honours it |
|---|---|---|
| Q1 | Providers & service providers only; seekers future | Eligibility is config on the interaction (§4), not code |
| Q2 | Both incoming and outgoing | API: `ownership_role: all`, counterparty resolved per row (§5.2). UI: selection kept across Sent/Received tabs → one file (§6A) |
| Q3 | All fields always | `projection.fields: "*"` in v1; field list supported by the contract (§5.1) |
| Q4 | Future scope | Status filter accepts any status; v1 UI sends `accepted` only |
| Q5 | Audit metadata only | One `bulk_export_audit` row per download (§7) |
| Q6 | Accept | Cross-instance rows skipped and **counted**, never silently dropped (§5.4) |
| Q7 | Accept the risk | "As of" stamp + `export_id` on every file (§6) |
| Q8 | CSV only | `format` is an enum with one value `csv` (§5.1) |

**Q3 is settled as all fields.** It supersedes the original AC "downloaded
fields are limited to those needed for fulfilment" — the AC on #639 should be
updated to match. Field-level selection stays in the contract for later.

## 3. Rules

1. **One domain per user — enforced in code.** `assertSingleDomain`
   (`apps/api/src/services/item_service.ts`, shared lock in
   `services/items/single_domain_lock.ts`, also used by
   `POST /api/v1/user/domains`) refuses a second domain with
   `403 DOMAIN_LOCKED`. So the requester's domain is unambiguous.
   *Caveat:* backfilled legacy accounts may still hold both domains (the lock
   lets them create in either). The export therefore keeps a cheap guard:
   a row whose resolved counterparty is owned by the requester is skipped and
   counted as `skipped_self`.
   A user may own **several profiles** in that one domain
   (`MAX_PROFILES_PER_USER`, default 5); the export covers all of them unless
   `filters.item_id` narrows it.
2. **Always the counterparty.** Whether the requester initiated or received
   the action, the exported profile is the side they do **not** own.
3. **The reveal gate is unchanged.** A row's private fields are decrypted only
   when the existing per-row rule allows it (§5.3). Bulk changes the
   transport, not the disclosure rule.

## 4. Configuration — `network.json`

Eligibility lives on the **interaction**, next to `reveals_pii_on_status`, not
on the domain:

```json
"actions": {
  "connect": {
    "interactions": [
      {
        "from_domain": "seeker", "to_domain": "provider",
        "reveals_pii_on_status": ["accepted"],
        "export": { "requester_domains": ["provider"] }
      },
      {
        "from_domain": "provider", "to_domain": "seeker",
        "reveals_pii_on_status": ["accepted"],
        "export": { "requester_domains": ["provider"] }
      },
      {
        "from_domain": "provider", "to_domain": "provider",
        "reveals_pii_on_status": ["accepted"],
        "export": { "requester_domains": ["provider"] }
      }
    ]
  }
}
```

- `export` absent → the interaction is not exportable (fail-closed default).
- `requester_domains` is matched against the requester's single domain.
- **Every direction must declare it.** `seeker→provider`, `provider→seeker`
  and `provider→provider` are separate entries; a missing one makes those rows
  vanish from the export (e.g. initiated exports, received does not).
- Enabling seekers later = add `"seeker"` to `requester_domains`. No code.
- Schema: extend the interaction schema in
  `packages/schemas/src/network_workflow.ts` (beside `reveals_pii_on_status`,
  line ~245) with an optional `export` object.

**Domains differ per network — nothing is hardcoded.** The domain set and the
interaction matrix come from each deployment's `network.json`
(bluedots-schemas):

| Network | Domains | Interactions (all reveal on `accepted`) |
|---|---|---|
| blue_dot `up-gzb`, `ka-dhwd` | `seeker`, `provider`, `service_provider` | `apply` seeker→provider; `connect` provider→seeker, seeker↔service_provider, provider↔service_provider |
| purple_dot `alimco` | `seeker`, `provider` (the provider **is** the service provider) | `connect` seeker↔provider |

So "providers and service providers" (Q1) is just the values each network puts
in `requester_domains`:

- blue_dot brand → `requester_domains: ["provider", "service_provider"]` on the
  interactions they take part in.
- purple_dot/alimco → `requester_domains: ["provider"]`.

Mixed counterparties (§5.2) arise from the matrix, not from a domain name: on
blue_dot a `service_provider` has `seeker` **and** `provider` counterparties,
and a `provider` has `seeker` **and** `service_provider` counterparties. The
export logic never branches on a domain id.

## 5. API

### 5.1 Contract

```
POST /api/v1/action/export
Authorization: Bearer <user token>
Content-Type: application/json
```

```json
{
  "filters": {
    "action_type":    ["connect"],
    "action_status":  ["accepted"],
    "ownership_role": "all",
    "item_id":        "<uuid, optional — one of my items>",
    "counterparty_domain": "seeker",
    "counterparty_item_type": "<optional>",
    "action_ids":     ["<uuid>", "..."],
    "facets":         [{ "field": "...", "values": ["..."] }],
    "updated_from":   "<ISO-8601, optional>",
    "updated_to":     "<ISO-8601, optional>"
  },
  "projection": { "fields": "*" },
  "include": [],
  "format": "csv"
}
```

| Field | v1 value | Wider use later |
|---|---|---|
| `filters.*` | same semantics as `FetchOwnedActionsQuerySchema` (`packages/schemas/src/api/action_schemas.ts:114`) minus `limit`/`offset`/`sort` | any status; date windows |
| `filters.counterparty_domain` | required only when the matched rows span more than one counterparty type (§5.2) | — |
| `filters.action_ids` | optional — "export selected" from the existing My Actions bulk selection | — |
| `projection.fields` | `"*"` | array of field keys (field-level export) |
| `include` | `[]` | `"match_score"`, `"distance_m"` for offline ranking (#639 Q4.2) |
| `format` | `"csv"` | `"xlsx"` added to the enum without breaking clients |

POST rather than GET: `action_ids` and `facets` do not fit a query string.

**Validation**

- `projection.fields` other than `"*"` → every key must exist in the
  counterparty item schema, else `400 UNKNOWN_FIELD`. A typo must not produce
  a silently empty column.
- Requester's domain not in `requester_domains` of a matched interaction →
  that interaction's rows are not exportable; if no interaction qualifies,
  `403 EXPORT_NOT_ENABLED`.
- Matched rows > `EXPORT_MAX_ROWS` → `413 EXPORT_TOO_LARGE` (v1). Reserved for
  a later `202 { job_id }` async path; the request shape does not change.

**Field selection is caller-controlled.** With the projection in the request,
the server does not restrict *which* schema fields may be asked for — the reveal
gate still decides whether private ones come back decrypted. If product later
wants per-network enforcement, add an optional `export.allowed_fields` to the
interaction and check the request against it. Additive, not breaking.

### 5.2 Row set and counterparty

Reuse — do not re-implement — what `fetch_actions.ts` already does:

- the owner/status/type `WHERE` built from the filters;
- the counterparty resolver (`fetch_actions.ts:250`):

  ```ts
  const counterpartyId = (row) =>
    row.target_item_owner === userId ? row.source_item_id : row.target_item_id;
  ```

  | Direction | Requester is | Exported profile |
  |---|---|---|
  | `initiated` | source | target |
  | `received` | target | source |
  | `all` | resolved per row | the side not owned |

Extract both into a shared helper used by `fetch_actions` and the export, so the
list view and the file can never disagree about which rows or which side.

**Mixed counterparty types — one file per counterparty type.** A provider /
service provider can connect with **both seekers and providers** (blue_dot and
purple_dot declare `connect provider → seeker` and `connect provider →
provider`). Seeker and provider profiles are separate schemas with no shared
keys — on alimco, seeker `profile_1.0` has `beneficiary_name, mobile_number,
email, …` and provider `profile_1.0` has `contact_name, contact_phone,
contact_email, …`. A CSV has one header row, so one file cannot carry both.

v1 rule:

- **Each export covers exactly one counterparty `(domain, item_type)`**, and its
  header is exactly that profile's fields.
- `filters.counterparty_domain` selects it. It is **required only when** the
  requester's matched rows span more than one counterparty type; otherwise it
  is inferred. Missing when required → `400 MIXED_COUNTERPARTY_TYPES` with
  `details.counterparty_domains` (e.g. `["provider", "seeker"]`) so the client
  knows which downloads to offer.
- A plain provider who only connects with seekers never sends it.
- UI: a requester with more than one counterparty type sees one download per
  type ("Download seekers" / "Download providers"); everyone else sees one
  "Download". Buttons are derived from config (§6A).
- A single-click bundle later = `format: "zip"` in the enum. No contract change.

**Config consequence:** the `provider → provider` interaction needs its own
`export.requester_domains: ["provider"]` entry too — otherwise provider
counterparties silently fall out of the export.

### 5.3 Per-row reveal

For each row, mirror the gate in `get_action_contact_details.ts`:

- `action_status` ∈ the interaction's `reveals_pii_on_status`
  (`getInteractionPiiRevealStatuses`, `packages/schemas/src/network_workflow.ts:524`), **and**
- requester's item and counterparty item are both `live`

→ decrypt the counterparty's private fields. Otherwise serialise the masked
`item_state` as stored. No export-specific masked-vs-decrypted branch.

In v1 (`accepted` only) the one masked case that can still occur is **pause**:
pausing does not cancel a connection, so an accepted row with a paused
counterparty — or a paused requester — comes out masked. The `pii_revealed`
column (§6.1) makes that visible. Not reachable where `pause_enabled` is false.

Other statuses (cancelled, retired) are out of scope for v1.

### 5.4 Skipped rows

Rows never become blank lines; they are skipped and counted:

| Counter | Cause |
|---|---|
| `skipped_cross_instance` | counterparty on another instance (contact-details returns 501 for these today) |
| `skipped_missing` | counterparty item hard-deleted (`delete_item.ts`) |
| `skipped_self` | counterparty owned by the requester (legacy two-domain accounts, §3) |
| `skipped_not_enabled` | the row's interaction does not list the requester's domain in `export.requester_domains` (all rows ⇒ `403 EXPORT_NOT_ENABLED`) |

Counts go in response headers and the audit row.

## 6. Response

`200`, built in memory rather than streamed: `EXPORT_MAX_ROWS` bounds it, and the
row / skip counts must be sent as headers before the body. Prefixed with a UTF-8
BOM so Excel reads non-Latin names correctly. Columns come from the schema, never a
hardcoded `COLUMNS` const.

**Headers**

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="<filename>"
Cache-Control: no-store
X-Export-Id: <bulk_export_audit.export_id>
X-Export-Generated-At: <ISO-8601 UTC>
X-Export-Row-Count: <n>
X-Export-Skipped-Cross-Instance: <n>
X-Export-Skipped-Missing: <n>
X-Export-Skipped-Self: <n>
X-Export-Skipped-Not-Enabled: <n>
```

**Filename** — no PII:

```
<network>_<counterparty_domain>_<status>_<export_id_short>_<ISO-ts>.csv
purple_dot_seeker_accepted_3f9a1c2e_2026-09-24T10-15-00Z.csv
```

- `counterparty_domain` = the one counterparty domain in the file (§5.2).
- `export_id_short` = first 8 chars of `export_id`. Not the requester's
  `item_id`: a user can own several profiles, so that would not be stable.
  The full id is in `X-Export-Id` and the audit row.
- Timestamp in UTC with `-` for `:` (Windows forbids `:` in filenames).
- Never a name, phone, email or org name: filenames land in download history,
  mail attachments and shared drives, and provider `contact_name` is
  `private: true` on purple_dot.
- `X-Export-Id` ties any found file back to one audit row.

### 6.1 Columns

Fixed columns first, then profile fields:

```
action_id, action_type, action_status, direction, counterparty_item_id,
counterparty_domain, counterparty_item_type, created_at, updated_at,
pii_revealed, <profile fields…>
```

- `direction` = `initiated` | `received`.
- `pii_revealed` = `true` | `false` (§5.3).
- Profile fields = the counterparty schema's properties, in schema order —
  one schema per file (§5.2).
- Header = field **key**, not schema title (stable for importers).
- Array values joined with `|`; nested objects flattened as `parent.child`.
- Every cell neutralised against spreadsheet formula injection
  (leading `= + - @` → prefixed), RFC-4180 quoting.

These are hard to change once providers build imports on them — fix them now.

## 6A. UI — My Actions (`apps/ui`)

### Current page (what the design must fit)

- `pages/my-actions-page.tsx` is **scoped to one live profile** (`scopedId`,
  kept in `?profile=`); a user with several profiles switches between them.
- **Sent / Received are separate tabs** (`initiated` / `received`), each with
  its own query (`useInitiatedActions` / `useReceivedActions`) sharing the
  page filters: `status`, `type`, `facets`, `sort`.
- Multi-select exists: `useCardSelection` + `BulkActionBar` in
  `components/actions/action-list.tsx`, today offering status changes
  (accept / reject / complete / cancel) on the selected cards of the active tab.
- Copy goes through i18n `t('actions.…')`.
- API calls use the axios client in `lib/api-client.ts` (`withCredentials`,
  separate `baseURL`). There is **no file-download precedent** in the UI yet.

### Entry point — selection only

Export is **selection-based**: the user picks the cards to export. There is no
"download everything matching" button in v1.

- A **Download** button is shown whenever the user's domain can export (see
  "Which buttons show"), and is **disabled until at least 1 card is selected**
  (`selection.selected.size === 0` → disabled, tooltip
  `actions.export_select_hint` "Select at least one accepted engagement").
- Request: `filters: { item_id: scopedId, ownership_role: "all",
  action_ids: [...selected], action_status: ["accepted"], counterparty_domain }`
  — `action_status` is sent too, so a card whose status changed since it was
  selected is dropped server-side rather than exported.

### Selection kept across tabs (Q2 in one file)

The user can select accepted cards on **Sent**, switch to **Received**, keep
selecting, and download **one** file covering both directions.

Changes:

1. **Tab switch keeps an accepted selection.** Today `my-actions-page.tsx:382`
   calls `selection.exitSelect()` on every tab change. New rule: keep the
   selection when its lock group is `accepted`; still clear it when the group
   is `pending`, so bulk accept / reject / cancel behave exactly as today
   (those are single-tab operations).
2. **Selected rows come from both tabs.** `selectedActions`
   (`my-actions-page.tsx:431`) is computed from the active tab's list only;
   compute it from the union of `initiatedActions` and `receivedActions`.
3. **Lock group spans tabs.** An accepted card on Sent and one on Received are
   the same `accepted` group, so the existing lock lets them combine and still
   keeps pending out.
4. **Bulk bar shows the split:** "5 selected (3 sent · 2 received)".
   - **Download** covers all selected cards.
   - **Complete** applies only to Received cards — hidden when any Sent card
     is selected, so it never silently acts on part of the selection.
5. **Clear / exit** clears both tabs' selection. Selection also clears when
   the scoped profile (`?profile=`) changes — rows of another profile must
   never ride along.
6. Counterparty split (below) still applies across tabs: seekers and providers
   go to separate files regardless of which tab they came from.

No API change — the endpoint already takes `ownership_role: "all"` with
`action_ids` from either side.

### Required change to selectability

Today `actionClassFor` (`components/actions/action-list.tsx:57`) makes a card
selectable only for status actions: pending on both tabs, **accepted only on
Received**. On the **Sent** tab an accepted card returns `null` and cannot be
selected — so accepted engagements the provider initiated could never be
exported.

Fix: accepted cards are selectable on **both** tabs, in the `accepted` lock
group. The bulk bar offers **Download** for that group, plus **Complete** when every
selected card is on Received (see above). The existing lock (first card picked fixes the group) already
keeps pending and accepted from mixing, so Download never receives pending
cards.

### Mixed counterparty types inside a selection

On blue_dot a service provider's accepted cards can be seekers **and**
providers. Each action row carries the counterparty's domain, so the bulk bar
groups the selection by counterparty domain:

| Selection | Bulk bar |
|---|---|
| one counterparty type | **Download (N)** |
| several types | **Download seekers (3)** · **Download providers (2)** — one file each |

This keeps "one file per counterparty type" (§5.2) without a server
round-trip, and avoids firing several browser downloads from one click.

### Which buttons show — from config

The UI already loads the network config. From it, compute for the
requester's domain the counterparty domains of every interaction whose
`export.requester_domains` includes that domain. Empty (e.g. seeker in v1) →
**no Download control at all**; otherwise the control is shown and follows the
selection rules above. Labels use the domain display names.

### Scale

Selection works on loaded cards only (infinite scroll), and there is no
select-all today. Exporting many records means scrolling and ticking each one.
**Recommended follow-up:** "Select all loaded" in select mode, using the
existing `selection.setSelected(ids)`. Selecting beyond loaded pages would
need the server-side "all matching" mode, which the API already supports via
filters without `action_ids`.

### Download mechanics

- `POST` via the existing axios client with `responseType: 'blob'`.
- Filename from `Content-Disposition`; save via `URL.createObjectURL` +
  temporary `<a download>`, then revoke the URL.
- The API is on a separate origin, so the API's CORS config must add
  `Access-Control-Expose-Headers: Content-Disposition, X-Export-Id,
  X-Export-Row-Count, X-Export-Skipped-Cross-Instance,
  X-Export-Skipped-Missing, X-Export-Skipped-Self` — otherwise the browser
  hides them from JS.
- Button shows a pending state and is disabled while a download runs (also
  matches the server's one-export-at-a-time cap).
- A 0-row response cannot happen from the UI (≥ 1 selected, all accepted);
  if the server returns 0 rows anyway (e.g. selected rows turned
  cross-instance / missing), show the skipped toast and do not save a file.

### Feedback

| Response | UI |
|---|---|
| 200, no skips | toast "Downloaded N records" |
| 200, skips > 0 | toast "Downloaded N records · M could not be included" (cross-instance / missing) |
| 403 `EXPORT_NOT_ENABLED` | toast; should not happen when buttons are config-driven |
| 413 `EXPORT_TOO_LARGE` | "Too many records — narrow the filters" |
| 429 | "An export is already running — try again shortly" |

All strings as new `actions.export_*` i18n keys.

### Out of scope (UI, v1)

- Status picker for export (API supports it; v1 is accepted-only).
- Field picker (API supports `projection.fields`; v1 sends `"*"`).
- ZIP / single-click multi-type download.

## 7. Audit

New table `bulk_export_audit` — one row per download (Q5: metadata only):

| Column | Type |
|---|---|
| `export_id` | uuid PK |
| `requester_user_id` | text |
| `requester_item_id` | uuid |
| `filters` | jsonb — the request `filters` as received |
| `projection` | jsonb |
| `format` | text |
| `row_count` | int |
| `revealed_count` | int |
| `masked_count` | int |
| `skipped_cross_instance` | int |
| `skipped_missing` | int |
| `skipped_self` | int |
| `skipped_not_enabled` | int |
| `created_at` | timestamptz |

`filters`/`projection` as jsonb means new filters or a later per-subject audit
need no migration. **Fail-closed:** if the audit row cannot be written the file is
not served (`500 EXPORT_AUDIT_FAILED`). `pii_reveal_audit` (per-subject) is **not** written on this
path in v1, per Q5.

## 8. Configuration — env

| Var | Default | Where |
|---|---|---|
| `EXPORT_MAX_ROWS` | `10000` | `packages/config/src/secrets.ts` beside `BULK_MAX_ITEMS` (line ~358) → `config.export_max_rows` in `apps/api/src/config.ts` |

Plus a per-requester rate limit / single-concurrent-export cap — bulk decrypt
is expensive and is the obvious scraping route.

## 9. Out of scope (v1)

- Statuses other than `accepted` in the UI (API already accepts them).
- XLSX; async/job exports above `EXPORT_MAX_ROWS`.
- Per-subject `pii_reveal_audit` rows.
- Export on behalf of a provider by an aggregator/service user — `fetch_actions`
  resolves the owner from `request.user.id`, and the export follows it. If
  acting-as is wanted later, resolve via `_resolve_acting_actor.ts`.
- Aggregator-side export (`/api/v1/aggregator/export` already covers it).

## 10. Decided in review (2026-09-24)

1. Fields: **all fields** (Q3 wins over the fulfilment-fields AC).
2. Mixed counterparties: **one file per counterparty type**, each with that
   profile's own header (§5.2).
3. One domain per user: **enforced in code** (§3), guard kept for legacy
   accounts.
4. Domains: **per-network**. blue_dot brands have `seeker` / `provider` /
   `service_provider`; purple_dot has `seeker` / `provider` (provider = service
   provider). Handled entirely by `requester_domains` config (§4).
5. UI export is **selection-only**; Download disabled until ≥ 1 selected;
   **accepted selection is kept across Sent/Received tabs** so one file can
   cover both directions (§6A).

6. Exportable statuses: **accepted and completed**. Driven by config — the
   export statuses are each interaction's `reveals_pii_on_status`
   (`getExportableStatuses`), so networks declare `["accepted", "completed"]`
   and add `completed` to the event status enum (which `update-status` also
   needs to accept a Complete). No status is hardcoded in the UI.

7. Timestamps: **IST by default, set by env only.** `EXPORT_TIMEZONE`
   (IANA zone, default `Asia/Kolkata`) drives the filename stamp
   (`…_2026-09-25T12-09-43+0530.csv`), the CSV date columns and
   `X-Export-Generated-At`, each with its offset. No network.json change.
   `bulk_export_audit` stays in UTC.

8. Mixed counterparties: **one file per domain** (product confirmed
   2026-09-25), on the assumption of one schema per domain. The UI shows a
   separate Download button per counterparty domain in the bulk bar. The
   code groups by (domain, item type) as a guard; with one schema per domain
   that is exactly one file per domain.

## 11. Delivery (child issues, after approval)

1. **schemas/config** — interaction `export` block; `EXPORT_MAX_ROWS`; add
   `export` to the example network.json files, and to the deployment files in
   bluedots-schemas (blue_dot `up-gzb` / `ka-dhwd` with
   `["provider", "service_provider"]`, purple_dot `alimco` with `["provider"]`).
2. **api** — shared row-set/counterparty helper; `POST /action/export`;
   `bulk_export_audit` table + migration; tests (both directions, masked
   paused row, skips, 403/413/400 paths).
3. **ui** (§6A) — selection-based Download (disabled at 0 selected);
   accepted cards selectable on the Sent tab; accepted selection kept across
   tabs; per-counterparty-type buttons in
   `BulkActionBar`; blob download helper; `actions.export_*` i18n
   keys; feedback toasts. Depends on the api ticket's CORS
   `Access-Control-Expose-Headers` change.
