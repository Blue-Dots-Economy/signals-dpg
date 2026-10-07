# CLAUDE.md — apps/api

Guidance specific to working inside `apps/api`. Read the root `CLAUDE.md` and `AGENTS.md` first — this file only covers what's non-obvious once you're actually editing files here.

## Route auth wiring is inconsistent by design, not centralized

There is no single auth default a new route inherits. Three patterns coexist in `src/routes/v1/`:

1. **Group-level hook** — `action_routes.ts`, `admin_routes.ts`, `aggregator_routes.ts` call `fastify.addHook('preHandler', auth_middleware_if_enabled)` (plus an acting-org hook) once, and every route registered under that group gets it for free. `action_routes.ts:10-20` has the canonical explanation of *why* the ordering matters — read it before touching hook order anywhere:

   > Fastify runs plugin-level `preHandler` hooks (registration order) before the route-level `preHandler` chain, so installing auth at the plugin scope guarantees `request.user` is set before the acting-org check reads it. Each route also declares its own `auth_middleware_if_enabled` for handler-local readability — `auth_middleware` is idempotent, so the second pass costs nothing.

2. **Per-route `preHandler`** — `item_routes.ts` and `consent_routes.ts` have **no group-level hook at all** (verified: both files are pure `fastify.register(...)` calls, nothing else). Every route under them (`create_item.ts`, `accept_consent.ts`, etc.) sets `preHandler: auth_middleware_if_enabled` itself. **If you add a route to one of these groups and forget the per-route `preHandler`, it is unauthenticated — there is no group default catching the omission.**

3. **Peer-only guard** — the network `*_local` routes (`network/item/fetch_item.ts`, `count_local`/`fetch_local`) use `peer_instance_guard` instead of user auth; see `.claude/rules/auth-model.md`'s "Inter-instance peer auth" section for the HMAC model itself.

**Rule of thumb:** before adding a route, check whether its group file has an `addHook`. If not, you own setting `preHandler` on every route you add.

## Two config-cache patterns, don't conflate them

- **In-memory singleton promise** (`network_configs.ts`, `consent_configs.ts`): a module-level `let xPromise: Promise<...> | null = null`, populated on first call, reused after. No TTL, no invalidation path other than process restart.
- **Disk-backed cache with boot-time wipe** (`network_schema_cache.ts`): schemas persist under `tmpdir()/dpg-network-schema-cache` and survive a restart. `app.ts:54-60` wipes and rebuilds it at boot **only when `NETWORK_CONFIG_SOURCE=local`** — in local dev the network is whatever file you point at, so a stale cache from a previously-configured network would otherwise keep being served after you switch. Remote mode keeps the cache (those schemas are expensive to refetch). The rebuild is additionally gated by `SCHEMA_CACHE_WARMUP_ENABLED` (default `true`) — set to `false` to skip the warmup DB query when no Postgres is reachable (used by `spec:dump`). Don't "fix" the local-mode wipe as if it were an accidental cache-bust — it's the thing that makes switching networks locally actually work.

## Item-fetch caching TTLs are two different numbers on purpose

- **Local read** (`utils/item_fetch_cache.ts`): `LOCAL_ITEM_FETCH_CACHE_TTL_SECONDS = 1` — deliberately tiny, just enough to collapse duplicate reads in the same request burst.
- **Inter-instance read** (`utils/inter_instance_fetch.ts`): TTL comes from `getDomainMinimumCacheTtlSeconds`, driven by network config, not a fixed constant — and **only a complete aggregate (all instances responded) is cached**; a partial result from `buildPagePlan` is never written to cache. If you're debugging "why did my update take a while to show up cross-instance," this is where to look — not the 1-second local TTL.

## `plugins/auth/` vs `src/middleware/`

Auth plugins (`auth_middleware.ts`, `validate_api_key.ts`, `validate_session.ts`) live at `apps/api/plugins/auth/`, **outside** `src/` — that's an existing structural quirk, not a typo; imports use `@api/plugins/auth/...`. Acting-org and peer guards live under `src/middleware/`. Two acting-org variants exist and are not interchangeable:

- `acting_org.ts` (`acting_org_preHandler`) — required acting-org, used by `admin_routes.ts` / `aggregator_routes.ts`.
- `acting_org_optional.ts` (`acting_org_preHandler_optional`) — acting-org is optional, used only by `action_routes.ts` (a non-admin actor can perform an action without acting on behalf of an org).

## Notifications are events on notification-service `/v1/notify`

Every notification the API sends is one **event** posted to
notification-service's `POST /v1/notify` through `@dpg/notification`'s
`NotificationClient.send` (`src/utils/notificationClient.ts` builds it once per
process). An event carries `event_type`, the recipient's network `domain` (or
none), the contact point in `to`, plain-text `variables`, a `priority` and
usually an `idempotency_key`. Event names come from `@dpg/notification`'s
`events.ts`, the one module both the senders and the catalogue generator read.

Signals renders no copy. Subjects, HTML, shells, brand colours, sender identity
and channel choice are notification-service config: an NS policy for
(domain, event) names the templates, and copy is edited in notification-service
through its admin API. The starting catalogues are generated by hand with
`tools/ns-catalogue/` (from a frozen snapshot of the pre-cutover copy in
`tools/ns-catalogue/src/legacy/`) and committed to bluedots-schemas as
`ns-catalogue.json`. See `docs/operations/email-copy-overrides.md`.

The client needs `NOTIFICATION_SERVICE_ENDPOINT` plus the Keycloak service
client (`KEYCLOAK_API_CLIENT_ID` / `KEYCLOAK_API_CLIENT_SECRET`, with
`KEYCLOAK_REALM` and the Keycloak base URL): it sends
`Authorization: Bearer <token>` from a `client_credentials` token, cached until
30 s before expiry and refreshed once on a 401. Without the endpoint or the
secret, `getNotificationClient()` returns `undefined` and best-effort senders
skip. The senders:

- **Action, retire and item-lifecycle notices** send `action.<actionType>.<shape>`, `action.cancelled_by_retire`,
  `item.created|created_draft|updated|paused|retired` and
  `item.onboarded_by_aggregator`, each with the recipient's item `domain`,
  `variables` (`name`/`ctaUrl`/`teamName`, or the aggregator fields) and an
  `idempotency_key`. The NS policy for (domain, event) picks the copy, so the
  connect/apply and profile/offer choices live there, generated by
  `tools/ns-catalogue/`. `build_notifications.ts` turns a `NotificationEvent`
  into `NotificationPlan`s → `dispatcher.ts` (injected `DispatcherDeps` —
  `send`, `resolveEmail`, `resolveCounterpartyName`, `teamName`) sends one
  event per plan; `notify_retire.ts` and `notify_item_lifecycle.ts` do the
  same for their events. `send_event.ts`'s `sendBestEffort` logs a refusal as
  `ns_rejected` and a transport failure as `ns_unreachable`, and never throws.
- **Support** (`POST /api/v1/support`, authenticated) sends one
  `support.request` event straight from the route handler
  (`routes/v1/support/submit_support.ts`, no `dispatcher.ts` in between):
  the first `SUPPORT_EMAIL` address is `to`, the rest plus `SUPPORT_CC_EMAIL`
  go in `cc` (de-duplicated, at most 10), `reply_to` is the submitter's email
  (omitted when the submitter gave none),
  attachments ride beside the `variables` (never in them), and the
  `idempotency_key` is the per-submission reference
  (`src/support/build_support_email.ts`'s `generateSupportReference`). It
  returns `503 SUPPORT_NOT_CONFIGURED` when `SUPPORT_EMAIL` or the NS client is
  unset, `502 SUPPORT_SEND_FAILED` on a refusal or transport failure (the
  send is critical), `429 SUPPORT_RATE_LIMITED` past 5 submissions per user
  per hour (the counter **fails open** — a Redis outage must not silence a
  complaint), and one of `ATTACHMENT_COUNT_EXCEEDED` / `ATTACHMENT_TOO_LARGE` /
  `ATTACHMENT_TYPE_NOT_ALLOWED` (400) from `src/support/attachments.ts` (#551).
  Two things there are easy to trip over: the route sets its **own**
  `bodyLimit`, derived from `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` rather than
  hardcoded (base64 inflates by 4/3, so a fixed limit would turn a raised cap
  into a silent 413) — every other route keeps Fastify's 1 MB default; and the
  MIME allowlist is a **code constant**, not env, deliberately.
  `GET /api/v1/support/config` serves `{enabled, maxTotalBytes, maxFiles,
  allowedTypes}` so the UI validates against the server's numbers instead of
  its own copy; its `enabled` mirrors the submit route's 503 condition exactly,
  and the two must be changed together.
- **Guardian OTP** (`services/guardian_otp.ts`) sends `guardian.otp.<kind>`
  (or `guardian.otp.generic`) with the code only in `variables.message`,
  priority `urgent` and no idempotency key; NS's `first_available` policy
  picks email or the SMS `login_otp` template from the contact point. A
  refusal or transport failure raises `NO_OTP_PROVIDER` (503). Generation and
  verification stay in Signals.
- **Welcome** (`notifications/welcome.ts`) sends one `user.welcome` event with
  every contact point the user has; NS's policy fans it out to the welcome
  email and the WhatsApp welcome. Its key is per user.

## `action/perform` is single-object; bulk is a separate route

`perform_action.ts` registers two routes (#296, Raya compat). `POST /perform` takes a **single action object** as the body — not an array. Array/batch submission has its own route, `POST /perform/bulk`, which runs items through `runBulk` (`@/utils/bulk_runner`, capped at `apiConfig.bulk_max_items`) and returns per-item results with `BulkItemFailure` entries rather than failing the whole request. Don't re-add array handling to `/perform` to "support both" — the split is deliberate so single-action callers get a flat success/error shape and bulk callers get partial-failure semantics.

## Test file placement

Colocated `__tests__/` per directory is the norm (17+ such folders) — a test for `foo.ts` lives at `__tests__/foo.test.ts` next to it. `src/__tests__/` (top-level, 3 files) is the exception, reserved for tests that cut across multiple directories (e.g. `consent_config_serving.integration.test.ts`) rather than exercising one module. If your test exercises a single file/module, colocate it; only use the top-level folder when it genuinely doesn't belong to one directory.

`*.integration.test.ts` requires Postgres + Redis running (`docker compose up -d db redis` from repo root) and is excluded from the default `pnpm --filter api test` run — see root `CLAUDE.md`'s "Commands not covered in AGENTS.md" for the exact invocations.

## Metrics subsystem

`src/services/metrics/` is dense enough to have its own doc — see `src/services/metrics/README.md` before changing anything there.
