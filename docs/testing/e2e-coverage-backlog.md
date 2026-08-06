# E2E Coverage Backlog — what the gate is missing and how we close it

**Status:** plan, not yet implemented · **Dated:** 2026-08-06 · **Branch:** `functional-testing-automation`

Companion to [`e2e-functional-test-strategy.md`](e2e-functional-test-strategy.md). The strategy
doc says *what the gate should be*; this doc is the honest, measured account of *what it
currently is*, and the ordered work to close the difference.

Treat this as a **point-in-time backlog**. When a journey here lands, delete its section and
drop its routes from `e2e/coverage-baseline.json`. When this file is empty, it should be
deleted rather than kept as a trophy.

---

## 1. Where the gate stands

Measured on the current tree, not estimated:

| Metric | Now | Notes |
|---|---:|---|
| API journeys implemented | **A–K** (11 specs) | `e2e/tests/api/` |
| UI journeys implemented | **A, H, L** + auth enabler + smoke (6 specs) | `e2e/tests/ui/` |
| **Route operations exercised** | **24 / 52 (46%)** | `cd e2e && npm run coverage` |
| **Error codes asserted** | **9 / 89 (10%)** | see §2.2 |

The 9 error codes the suite asserts today: `ACTION_NOT_FOUND`, `BULK_EMPTY_ARRAY`,
`CONSENT_REQUIRED`, `MISSING_ACTING_AS_USER_ID`, `NOT_ACTION_PARTICIPANT`,
`NOT_SOURCE_ITEM_OWNER`, `NOT_TARGET_ITEM_OWNER`, `USER_ALREADY_EXISTS`, `USER_NOT_FOUND`.

### 1.1 Two different kinds of gap

These need separating, because only one of them is machine-detectable:

**Route gaps** — a route exists and nothing calls it. 28 of them, listed in
`e2e/coverage-baseline.json`, enforced by `e2e/scripts/check-coverage.mjs`. This is a floor:
it catches *absence*, and it will now fail the moment a new route ships without a journey.

**Behaviour drift** — the route *is* called, so the check is green, but a guard added to it
since the journey was written is untested. This is the more dangerous class and no script
detects it. Every item in §2 is behaviour drift on an already-"covered" route. The defence is
`.claude/rules/e2e-coverage.md` plus the error-code discipline in §2.2.

> **Why 46% is worse than it looks.** `POST /api/v1/action/perform` counts as covered, yet
> none of the three guards added to it in the last cycle — the per-pair action cap, the U18
> external-channel block, the batch guardian OTP — has a single assertion. A green gate over
> an untested fail-closed guard is the exact failure mode the strategy doc's flake/rot section
> warns about.

---

## 2. Behaviour drift — shipped features with no assertions

Every route below is already exercised by some journey, so the traceability check is green on
all of them. The **behaviour** is untested.

### 2.1 The feature list

| # | Feature | Where the behaviour lives | Guard that is untested | Pri |
|---|---|---|---|---|
| 1 | **Action pair cap** (#370/#422) | `services/action_pair_cap.ts` | `ACTION_LIMIT_REACHED` at the cap; cap **releases** once the open action is accepted/cancelled/rejected/completed; cap is per `(pair, metric_category)` and configurable via `max_actions_per_pair` | P0 |
| 2 | **U18 external-channel block** (#395) | `services/guardian_action_gate.ts` | `MINOR_ACTION_CHANNEL_BLOCKED` on `channel: 'external'`; **the API is the control, not the UI** — an aggregator/on-behalf call must be refused even though the UI never offers it | P0 |
| 3 | **Batch guardian OTP** (#393) | `guardian_action_gate.ts` (`bulkScope`) | one OTP for a whole bulk selection, scoped to sha256 of the sorted action tuples; a different selection must **not** reuse the OTP; the batch pre-pass is skipped on external channels so #2 still applies | P0 |
| 4 | **Existing-minor post-login guardian gate** (#453) | u18 consent routes + auth flow | an already-registered minor is gated *after* OTP login, before home; adult consent is not recorded for them | P0 |
| 5 | **Profile-consent cache invalidation** (#464) | `services/item_service.ts` | accepting profile consent promotes draft→live **and sweeps the item-fetch caches** — the item is discoverable immediately, not after TTL | P1 |
| 6 | **Discover native fallback** (#394/#454) | `services/signals_search_client.ts`, `discover.ts` | with signals-search **down**: `q` + facets + radius still apply, `meta.source = native_fallback`, `degraded = true`, only ranking is lost. Needs the `faultInjection` capability — asserting `meta.source` on a healthy target proves nothing | P1 |
| 7 | **Anchor relevance** (#394) | `discover.ts` | `anchor_item_id` re-ranks; `ANCHOR_NOT_FOUND` for a bad anchor; switching profiles changes order | P1 |
| 8 | **Retire counterparty notification** (#418) | `notifications/notify_retire.ts` | retire *notifies* the cancelled counterparties. Journey O (§3.1) asserts cancellation; the notification needs the Mailpit oracle | P1 |
| 9 | **Keycloak identity lifecycle** (#456) | `packages/auth`, `plugins/auth` | the harness is dual-mode, but nothing asserts Keycloak-specific behaviour: logout/session revocation, expired-token rejection, claims→`/auth/me` mapping, realm role → participant tier | P0 |
| 10 | **Retire PII scrub depth** (#347) | `services/items/retire_pii.ts` | `item_state` PII scrubbed, encrypted private blob cleared, `item_locations` wiped. Row-level assertions need the `db` capability | P1 |

### 2.2 Error codes as the coverage proxy

89 machine-readable error codes exist; 9 are asserted. Most of the rest are fail-closed
guards — the branches with the highest cost of being silently wrong.

This is a better rot signal than route coverage, because it tracks *guards* rather than
*endpoints*. Proposed working rule, encoded in `.claude/rules/e2e-coverage.md`: **a new
`error:` code arrives with a negative test asserting it.** That holds the ratio from
degrading further without a big-bang backfill.

Highest-value codes to assert first, grouped by the journey that should own them:

- **Pair cap / actions:** `ACTION_LIMIT_REACHED`, `DUPLICATE_ACTION`, `ACTION_CANCELLED`, `RECEIVER_ALREADY_ACTED`, `BULK_LIMIT_EXCEEDED`
- **U18 fail-closed:** `MINOR_ACTION_CHANNEL_BLOCKED`, `GUARDIAN_OTP_REQUIRED`, `GUARDIAN_REQUIRED`, `GUARDIAN_PRECREATE_REQUIRED`, `GUARDIAN_WARD_LIMIT`, `NOT_A_MINOR`, `DOB_REQUIRED`, `DOB_ALREADY_SET`, `AGE_REQUIRED`, `U18_NOT_ALLOWED`
- **Ownership / auth boundaries:** `NOT_ITEM_OWNER`, `ITEM_NOT_OWNED_BY_USER`, `ITEM_NOT_FOUND_OR_FORBIDDEN`, `NOT_AUTHORIZED_FOR_TARGET`, `CANNOT_OVERRIDE_SELF`, `FORBIDDEN_CREATED_BY`, `NOT_NETWORK_SERVICE`, `NOT_AGGREGATOR`, `ACTING_ORG_TYPE_NOT_ALLOWED`
- **PII non-leakage:** `PII_NOT_REVEALED`, `CROSS_INSTANCE_REVEAL_NOT_SUPPORTED`, `USER_LEVEL_INCOMPLETE`
- **Consent ledger:** `CONSENT_DECLINED`, `CONSENT_PREREQUISITE_MISSING`, `CONSENT_VERSION_UNCONFIGURED`
- **Domain / schema integrity:** `DOMAIN_LOCKED`, `UNSERVED_DOMAIN`, `UNKNOWN_NETWORK`, `INVALID_ITEM_TYPE`, `PROFILE_NOT_LIVE`

---

## 3. Proposed journeys

Journey letters continue the strategy-doc §4 catalog. **Every one of the 28 parked routes is
assigned below**, so completing this section burns `coverage-baseline.json` to zero.

Notation: each journey lists the baseline routes it retires, and the behaviour drift items
from §2 it closes.

### 3.1 Journey O — profile lifecycle (pause / unpause / retire) · **P0**

*Retires:* `POST /api/v1/item/lifecycle` · *Closes:* §2.1 #8, #10

Retire is terminal and destructive, and it fans out to five subsystems. It is the
highest-consequence untested path in the product.

- Pause hides a live profile from network fetch and discover; unpause re-derives status
  through the classifier (not a naive flip back to `live`).
- Transition guards: illegal transitions are refused (`draft → pause`, anything out of
  `retired`), each with its own code.
- A non-owner cannot change another user's lifecycle → `NOT_ITEM_OWNER`.
- Retire, asserted as a fan-out — cancels open connections **on either side**, de-indexes from
  search, scrubs `item_state` PII, clears the encrypted private blob, wipes `item_locations`
  (row assertions need `db`), and **notifies the cancelled counterparties** (needs `mailpit`).
- Pause/unpause/retire sweep the item-fetch cache — the change is visible immediately.

### 3.2 Journey P — item update & delete · **P0**

*Retires:* `PATCH /api/v1/item/{itemId}`, `DELETE /api/v1/item/{itemId}`

- Server-owned fields (`item_instance_url`, `item_schema_url`) cannot be overwritten by a
  client update — the CLAUDE.md invariant, currently unproven end-to-end.
- A required field cannot be blanked while the profile is live; pausing first allows it.
- A stranger can neither update nor delete another user's item.
- A retired item cannot be edited — no re-introducing scrubbed PII.
- Owner delete removes the item from own-fetch **and** from discovery.
- `DOMAIN_LOCKED` on create (`create_item.ts`) — a user can't create a second item in a
  domain they're already locked into.

### 3.3 Journey Q — discover BFF · **P0**

*Retires:* `POST /api/v1/network/item/discover` · *Closes:* §2.1 #6, #7

- Live items come back with a source-tagged envelope; `meta.degraded === (source === 'native_fallback')`.
- Paging: `offset` does not repeat page 1.
- **Security:** filtering on a *private* or *undeclared* `item_state` field must be **dropped,
  not honoured** — otherwise found/not-found is an oracle for guessing a private value one
  request at a time. Assert the result count is unchanged, not merely that the call succeeds.
- Geo-bounded discover echoes the radius it applied.
- An unscoped discover (no `item_domain`/`item_type`) is refused — partition pruning depends on them.
- **With signals-search stopped** (`faultInjection`): `q`, facets and radius still filter;
  `source = native_fallback`. This is the assertion that actually proves #454.
- `anchor_item_id` re-ranks; a bad anchor → `ANCHOR_NOT_FOUND`.

### 3.4 Journey R — action limits & the action list · **P0**

*Retires:* `GET /api/v1/action/fetch` · *Closes:* §2.1 #1

- At `max_actions_per_pair`, a further action between the same pair → `ACTION_LIMIT_REACHED`.
- **The cap releases:** accept/cancel/reject/complete the open action, and a fresh one is
  allowed again. (Testing only the block direction would pass against a permanently-stuck cap.)
- The cap is scoped per metric category — a different category is unaffected.
- `DUPLICATE_ACTION`, `ACTION_CANCELLED`, `RECEIVER_ALREADY_ACTED` on status transitions.
- `GET /action/fetch` is participant-scoped and paginates; it never lists a third party's actions.

### 3.5 Journey S — U18 gating, full surface · **P0**

*Retires:* `POST /api/v1/auth/u18-precheck`, `GET /api/v1/consent/u18/status`,
`POST /api/v1/consent/u18/signup/guardian`, `POST /api/v1/consent/u18/signup/guardian/verify`,
`POST /api/v1/consent/u18/profile-consent/precreate/issue`,
`POST /api/v1/consent/u18/profile-consent/precreate/verify`,
`POST /api/v1/consent/u18/profile-consent/finalize` · *Closes:* §2.1 #2, #3, #4

The largest single gap. Journey C covers only "minor stays draft" and "verified guardian
promotes"; the whole gating surface around it is untested.

- **External-channel block (#395):** an on-behalf/aggregator `perform` for a minor →
  `MINOR_ACTION_CHANNEL_BLOCKED`, fail-closed on unknown age too. Assert via the **service
  caller**, since the API is the control and the UI never offers the path.
- **Batch guardian OTP (#393):** a bulk of a minor's actions issues **one** OTP and one email
  for the whole selection; the OTP is scoped to that selection, so a *different* selection is
  refused with `GUARDIAN_OTP_REQUIRED` rather than accepted.
- The batch pre-pass is **skipped on external channels**, so the block above still wins for a
  bulk request — the fail-open risk if the two features are composed wrongly.
- Signup-time guardian: `signup/guardian` → `verify` records the guardian; `GUARDIAN_WARD_LIMIT`
  at the cap; `SAME_CONTACT_NOT_ALLOWED` when guardian and minor share a contact.
- Pre-create guardian consent (`precreate/issue` → `verify` → `finalize`) — the second
  promotion path, distinct from post-create.
- `u18-precheck` and `u18/status` fail **closed** on a null/unknown DOB.
- Existing-minor post-login gate (#453): gated after OTP, before home; no adult consent recorded.

### 3.6 Journey T — map markers · **P1**

*Retires:* `GET /api/v1/network/item/markers`, `POST /api/v1/network/item/markers_local`

- Viewport-bounded markers return only live, non-retired items inside the bbox.
- Marker payloads carry **no PII** and no private fields — the map is anonymous surface.
- Location jitter is applied and is deterministic for a given item (`deterministicKey`).
- Paused/retired items disappear from markers (pairs with Journey O).
- Runtime marker caps (#458) are honoured rather than returning an unbounded set.

### 3.7 Journey U — platform surface · **P1**

*Retires:* `GET /api/v1/user/domains`, `POST /api/v1/user/domains`,
`GET /api/v1/network/schema/{network}/{domain}/{itemType}`,
`POST /api/v1/network/refetch_schemas`, `POST /api/v1/match-score/calculate`,
`POST /api/v1/event/store`, `GET /api/v1/event/fetch`

Small endpoints, all completely untested, several load-bearing for the UI.

- **User domains:** `GET` requires auth (`UNAUTHORIZED`); `POST` rejects a domain this instance
  doesn't serve → `UNSERVED_DOMAIN`.
- **Schema fetch:** a served `(network, domain, item_type)` resolves; an unknown one is refused
  (`UNKNOWN_NETWORK` / `INVALID_ITEM_TYPE`). The `x-reference-source` marker (#433) is present
  in the served schema and does not break validation.
- **Refetch schemas:** requires auth; an unreachable remote schema surfaces
  `REMOTE_SCHEMA_FETCH_FAILED` rather than a 500.
- **Match score:** `MATCH_SCORE_NOT_CONFIGURED` when no provider is set, and
  `MATCH_SCORE_SERVICE_UNAVAILABLE` when the provider is unreachable (`faultInjection`) — the
  two branches that decide whether the UI degrades or breaks.
- **Events:** `store` validates the envelope (`INVALID_EVENT_REQUEST`); `fetch` is scoped to
  the caller and does not leak another item's events.

### 3.8 Journey V — admin participant tiers · **P0**

*Retires:* `GET /api/v1/admin/participant`, `POST /api/v1/admin/participant/decrypt`

Journey I covers participant *create* and the two-header model. The read and decrypt tiers —
the ones that return real PII — are untested.

- `GET /admin/participant` is **ownership-scoped**: an aggregator sees only participants it
  onboarded, never another org's. This is the highest-value assertion in the journey.
- `MISSING_IDENTIFIER` with no lookup key.
- `INVALID_ACTING_ORG` and `ACTING_ORG_TYPE_NOT_ALLOWED` on both routes — only `aggregator`
  and `network_service` may decrypt.
- Decrypt returns plaintext PII **only** for an owned participant at a sufficient level;
  `USER_LEVEL_INCOMPLETE` otherwise.
- A session (non-service) caller cannot reach either route — no session fallback.

### 3.9 Journey W → fold into K — consent status reads · **P1**

*Retires:* `GET /api/v1/consent/status`, `GET /api/v1/consent/profile-status` · *Closes:* §2.1 #5

Not worth its own letter; extend Journey K.

- `status` reflects the latest ledger entry per `(subject, type)` by `seq`, not timestamp.
- `profile-status` gates discoverability; accepting promotes draft→live **and sweeps the
  item-fetch cache**, so the item is discoverable on the next read, not after the TTL (#464).
- `CONSENT_PREREQUISITE_MISSING` when accepting out of order.

### 3.10 Journey X — Keycloak identity lifecycle · **P0**

*Retires:* nothing (no new routes) · *Closes:* §2.1 #9

The auth provider changed wholesale in #456 and the suite proves only that login works.

- Logout / session revocation: a revoked token is rejected on the next protected call.
- An expired or tampered token → 401, with no session fallback to a service path.
- `/auth/me` maps Keycloak claims to the app's user shape correctly.
- Realm role → participant tier mapping is what the admin routes actually enforce.
- Runs under both providers via the existing `provider` fixture, so it stays honest if
  better-auth is still reachable on some target.

### 3.11 Journey N — multi-instance / peer (G3) · **P0 (Phase 2)**

*Retires:* `POST /api/v1/network/action/perform`, `POST /api/v1/network/item/count_local`,
`POST /api/v1/network/item/fetch_local`

Already specified in strategy §6; blocked on a two-peer topology (`peer.apiBaseUrl`). Listed
here only so the three routes aren't double-counted as unplanned.

- Peer HMAC auth matrix; `INVALID_TARGET_INSTANCE`, `TARGET_INSTANCE_UNAVAILABLE`.
- Count-first discovery: only relevant peers are queried; only *complete* aggregates are cached.
- **Cross-instance PII refusal:** `CROSS_INSTANCE_REVEAL_NOT_SUPPORTED`.

### 3.12 UI backlog · **P1/P2**

No routes attached — these are UI-risk surfaces per strategy §2.3.

- **Deferred from Phase 1:** D/F action modal → accept → contact reveal (two browser contexts),
  C guardian UI (needs `SELF_SIGNUP_MODE=allowed`), the schema-driven profile form.
- **New since:** `x-reference-source` autocomplete (#433) — resolves the external dataset,
  stores a plain string, free-text values still work; map dark/light basemap (#465); "You are
  here" self-marker (#438); one-click cluster zoom + co-located pin (#470); the degraded
  "basic results" note when discover falls back (#454).

---

## 4. Harness prerequisites

Several of the highest-value assertions can't run on any target we point at today. These are
**blockers, not nice-to-haves** — without them the corresponding tests would be written to
skip, which is coverage theatre.

| Capability | Needed by | Status | Work required |
|---|---|---|---|
| `faultInjection` | Q (search-down fallback), U (match-score unavailable) | `false` on local | Ability to stop signals-search / the match provider mid-run |
| `db` | O (retire scrub rows), G extensions | `db.url` is `null` on local | Set `E2E_DB_URL`; restore a read-only introspection helper + `db` fixture |
| `mailpit` | O (retire notification), S (guardian OTP emails) | ✅ configured locally | — |
| `keycloakPhoneOtp` | S (phone-channel guardian OTP) | ✅ configured locally | — |
| `serviceAuth` | S (external-channel block), V (admin tiers) | `null` in `config/local.json` | Mint a `network_service` key: `pnpm db:seed:services:api`, then fill `e2e/.env.local` |
| `peer` | N | not configured | Two-peer topology — Phase 2 |
| `deterministicKey` | T (jitter determinism), G | `false` on local | Pin `SIGNALS_PII_KEY` on the target |

> Note: `capabilities.ts` defines a `db` flag, but there is currently **no `db` fixture** on
> `test` — the introspection helper was lost with the uncommitted work on 2026-08-06. Any
> journey needing row-level assertions has to restore it first.

---

## 5. Sequencing

Ordered by risk retired per unit of effort, not by journey letter.

**Wave 1 — untested fail-closed guards (P0).** The guards that are silently trusted today.
`S` (U18 full surface), `R` (pair cap), `V` (admin read/decrypt tiers), `X` (Keycloak
lifecycle). Prerequisite: `serviceAuth` credentials — `S` and `V` are blocked without them.

**Wave 2 — destructive & mutating paths (P0).** `O` (lifecycle/retire), `P` (update/delete),
`Q` (discover, healthy-path assertions). Prerequisite for the full `O`: the `db` fixture.

**Wave 3 — degradation & breadth (P1).** `Q` fallback under `faultInjection`, `T` (markers),
`U` (platform surface), `K` extensions (consent status reads).

**Wave 4 — UI and network tier.** The §3.12 UI backlog, then `N` once a two-peer topology
exists.

Do **not** treat waves as sprints to be run in parallel by different people — Wave 1 will
surface harness gaps (fixtures, capability wiring) that later waves depend on.

---

## 6. Keeping this from happening again

The backlog above exists because the suite had no forcing function. Three now exist:

1. **`e2e/scripts/check-coverage.mjs`** — route traceability against the generated
   `openapi.json`. Fails on any new unmapped route. `cd e2e && npm run coverage`.
2. **`e2e/coverage-baseline.json`** — the 28 known gaps, as a shrink-only debt register. The
   check also warns when a baseline entry becomes covered, or points at a deleted route.
3. **`.claude/rules/e2e-coverage.md`** — auto-loads whenever API routes/services/middleware,
   UI pages/components, `packages/schemas`, or `e2e/**` are edited. Gives the required move
   per kind of change, including **deletions**.

**Still open — the CI half.** Per the strategy doc's scope note, per-PR CI wiring was
deliberately held. `npm run coverage` needs no running target and takes under a second, so it
is a cheap first CI job whenever that hold lifts. Until then the check runs locally only, and
the rule is what carries it.

---

### In plain terms

We have a set of automated tests that act like a real person using the app, and they're meant
to stop a bad release. The tests were built a while ago and the app has moved on since —
so today they only touch about half the app's endpoints, and they check only 9 of the 89
specific error conditions the code can produce. Several safety features that shipped
recently — the limit on how many times you can contact the same person, the rule that under-18s
can only act inside the app, the single parental approval covering a batch of requests — have
no test at all, even though the tests look green.

This document lists exactly what's missing and the order to fix it, hardest-risk first. It
also adds a small program that compares the app's real list of endpoints against what the
tests actually call, so from now on adding a new endpoint without a test makes the check fail
instead of passing quietly.
