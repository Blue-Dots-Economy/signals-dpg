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

## Notifications & support are separate small pipelines

- `src/notifications/`: `build_notifications.ts` (turns a `NotificationEvent` into a `NotificationPlan`) → `dispatcher.ts` (takes injected `DispatcherDeps` — `notify`, `resolveEmail`, `resolveCounterpartyName`, `brand` — so it's testable without a real notification-service call) → `render_action_email.ts` / `action_copy.ts` renders the actual HTML.
- `src/support/build_support_email.ts`: unrelated, smaller — just an HTML-escaping email builder. `POST /api/v1/support` (authenticated) emails `SUPPORT_EMAIL` via the notification client and returns `503 SUPPORT_NOT_CONFIGURED` when the recipient or client is unset.

Don't assume these share infrastructure — they're two independent, small pipelines that happen to both end up calling the notification-service client.

## `action/perform` is single-object; bulk is a separate route

`perform_action.ts` registers two routes (#296, Raya compat). `POST /perform` takes a **single action object** as the body — not an array. Array/batch submission has its own route, `POST /perform/bulk`, which runs items through `runBulk` (`@/utils/bulk_runner`, capped at `apiConfig.bulk_max_items`) and returns per-item results with `BulkItemFailure` entries rather than failing the whole request. Don't re-add array handling to `/perform` to "support both" — the split is deliberate so single-action callers get a flat success/error shape and bulk callers get partial-failure semantics.

## Test file placement

Colocated `__tests__/` per directory is the norm (17+ such folders) — a test for `foo.ts` lives at `__tests__/foo.test.ts` next to it. `src/__tests__/` (top-level, 3 files) is the exception, reserved for tests that cut across multiple directories (e.g. `consent_config_serving.integration.test.ts`) rather than exercising one module. If your test exercises a single file/module, colocate it; only use the top-level folder when it genuinely doesn't belong to one directory.

`*.integration.test.ts` requires Postgres + Redis running (`docker compose up -d db redis` from repo root) and is excluded from the default `pnpm --filter api test` run — see root `CLAUDE.md`'s "Commands not covered in AGENTS.md" for the exact invocations.

## Metrics subsystem

`src/services/metrics/` is dense enough to have its own doc — see `src/services/metrics/README.md` before changing anything there.
