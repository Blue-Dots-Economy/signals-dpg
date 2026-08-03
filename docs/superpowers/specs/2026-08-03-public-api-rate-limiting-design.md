# Public API Rate Limiting — Throttle the unauthenticated public read surface (per-IP, Redis-backed)

Issue: [#432](https://github.com/Blue-Dots-Economy/signals-dpg/issues/432) — follow-up from the review of [#419](https://github.com/Blue-Dots-Economy/signals-dpg/pull/419) (List discover BFF).

## Goal

Add a throttling layer to the public API so the unauthenticated read surface can't be hammered for free. Today there is **no rate limiting anywhere**: `@fastify/rate-limit` is not a dependency and is not registered in `app.ts`, so the `config.rateLimit` already declared on the auth route (`apps/api/src/routes/auth/index.ts`) is **inert**.

The gap is materially amplified by `POST /api/v1/network/item/discover` (#419): it is unauthenticated (holds the signals-search key server-side) and every request with a `q` triggers an **embedding + vector search** on signals-search — a comparatively expensive, cost-bearing compute path with no per-IP bound.

We register `@fastify/rate-limit`, back it with the existing Redis (ioredis) client for multi-instance correctness, and apply **per-IP** budgets to the three named public read endpoints, returning a documented `429` the **UI** can back off on.

## Non-goals

- **No global/catch-all limit** across the whole public surface. Scope is exactly the three named read endpoints (+ the auth route activating as a side effect, below). A broad default was considered and deliberately dropped to keep blast radius small.
- **No per-API-key budgets.** The target endpoints are unauthenticated public reads — there is no API key to key on. Authenticated-surface / per-key throttling is out of scope.
- **No aggregator/voice backoff contract.** This surface is UI-facing; the `429` shape is designed for the browser client, not for aggregator/voice callers.
- **No cost/complexity weighting** of `q` (embedding) vs non-`q` requests. A per-request count is sufficient for v1; a cost/window bound is a possible follow-up.

## Design decisions (confirmed)

| # | Question | Decision |
|---|----------|----------|
| 1 | Which endpoints? | **Only the three named public reads** — `/network/item/discover`, `/network/item/fetch`, `/network/item/markers` (+ `/item/markers_local`). No global default. |
| 2 | How is a "caller" keyed? | **Per-IP** (`request.ip`). `trustProxy: true` is already set in `app.ts`, so `request.ip` is the real client IP behind the k8s ingress. |
| 3 | Limits + configurable? | **Yes, env-driven.** Defaults: `/discover` **30/min**, `/fetch` + `/markers` **60/min**, per IP. Overridable via env; a master `RATE_LIMIT_ENABLED` toggles the whole layer. |
| 4 | Store + reset? | **Redis** (existing `ioredis` client) — correct across replicas. Fixed window: one counter per `(ip, route)` with TTL = window; auto-resets when the TTL lapses. |
| 5 | Response | **`429`** with the app's `{ error, message }` envelope + `retry_after_seconds`, plus standard `Retry-After` / `RateLimit-*` headers. Framed for the UI. |
| 6 | Auth route (side effect) | **Let it take effect.** Registering the plugin activates the auth route's existing (currently inert) `10 req / 10s` limit — this was clearly intended (login/OTP brute-force throttling). |

## Model: how `@fastify/rate-limit` maps to these decisions

`@fastify/rate-limit` (v10, Fastify 5 compatible) is registered **once** in `buildApp()` with **`global: false`**. With `global: false`, no route is limited unless it opts in via its own `config.rateLimit`. This is what makes "only the three endpoints" clean:

- The three read routes opt in explicitly (below).
- The auth route already carries `config: { rateLimit: { max: 10, timeWindow: '10 seconds' } }` — with the plugin now present, that limit becomes live (decision 6).
- Every other route stays unlimited, exactly as today.

**Key:** the plugin's default key generator is `request.ip`; with `trustProxy: true` already set that is the real client IP. We set it explicitly (`keyGenerator: (req) => req.ip`) so the intent is documented in code and doesn't silently change if a future default shifts.

**Store:** the plugin accepts an `ioredis` instance via its `redis` option. We pass the shared client (`redis` from `apps/api/db/secondary/redis.ts`) so counters are shared across API replicas. A dedicated `nameSpace` (`sdpg-rl:`) keeps rate-limit keys from colliding with the existing item-fetch cache keys in the same Redis.

**Fail-open:** `skipOnError: true`. If Redis is unavailable the limiter lets requests through rather than 5xx-ing the whole public API. Availability is preferred over strict enforcement for a throttle whose job is abuse-dampening, not correctness. This trade-off is called out here on purpose.

## Components & changes

### 1. Dependency — `apps/api/package.json`
Add `@fastify/rate-limit` (`^10`, matching Fastify `^5.8.5`).

### 2. Config — `apps/api/src/config.ts`
New env-driven `rateLimitConfig` group, following the existing `Number(env) || default` / `?? default` pattern used by `apiConfig`, `signalsSearchConfig`, etc.:

| Env var | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | Master switch. `false` ⇒ plugin not registered (see §6). |
| `RATE_LIMIT_DISCOVER_MAX` | `30` | Max `/discover` requests per window per IP. |
| `RATE_LIMIT_DISCOVER_WINDOW` | `1 minute` | `/discover` window. |
| `RATE_LIMIT_READ_MAX` | `60` | Max `/fetch` and `/markers` requests per window per IP. |
| `RATE_LIMIT_READ_WINDOW` | `1 minute` | `/fetch` + `/markers` window. |

The auth route keeps its hardcoded `10 / 10s` (not env-driven; out of this ticket's tuning surface, but now active).

### 3. Registration — `apps/api/src/app.ts`
Inside `buildApp()`, after core plugins and **before** `app.register(v1_routes, …)` / `app.register(AuthRoutes)` (registration must precede the routes that reference `config.rateLimit`):

```ts
import rateLimit from '@fastify/rate-limit';
import { redis } from '@api/db/secondary/redis';
import { rateLimitConfig } from '@/config';

if (rateLimitConfig.enabled) {
  await app.register(rateLimit, {
    global: false,                 // opt-in per route only
    redis,                         // shared ioredis client → cross-replica
    nameSpace: 'sdpg-rl:',
    keyGenerator: (req) => req.ip, // trustProxy already yields real client IP
    skipOnError: true,             // fail-open on Redis trouble
    enableDraftSpec: true,         // standardized RateLimit-* headers
    errorResponseBuilder: (_req, ctx) => ({
      error: 'RATE_LIMITED',
      message: 'Too many requests — please slow down.',
      retry_after_seconds: Math.ceil(ctx.ttl / 1000),
    }),
  });
}
```

When `RATE_LIMIT_ENABLED=false`, the plugin is simply **not registered**; the `config.rateLimit` objects on routes are then ignored by Fastify (unknown config keys are inert), so behavior is identical to today. This is the switch the existing integration suites use.

### 4. Per-route opt-in

Add `config: { rateLimit: {...} }` to each target route's `fastify.route({...})` options, reading defaults from `rateLimitConfig`:

| File | Route | Verb | Limit source |
|---|---|---|---|
| `routes/v1/network/item/discover.ts` | `/item/discover` | POST | `discover.max` / `discover.window` |
| `routes/v1/network/item/fetch_item.ts` | `/item/fetch` | GET | `read.max` / `read.window` |
| `routes/v1/network/item/markers.ts` | `/item/markers` | GET | `read.max` / `read.window` |
| `routes/v1/network/item/markers.ts` | `/item/markers_local` | POST | `read.max` / `read.window` |

(Full paths under the `/api/v1` prefix, e.g. `POST /api/v1/network/item/discover`.) The auth route (`/api/auth/*`) needs **no change** — its existing config activates automatically.

### 5. `429` response shape (documented, UI-facing)

Body (matches the app's `{ error, message }` envelope, e.g. `served_domain_guard`'s `UNSERVED_DOMAIN_BINDING`):

```json
{
  "error": "RATE_LIMITED",
  "message": "Too many requests — please slow down.",
  "retry_after_seconds": 42
}
```

Headers (added by the plugin): `retry-after`, and with `enableDraftSpec` the standardized `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`. The UI reads `retry-after` / `retry_after_seconds` to back off and surface a "slow down" toast rather than treating it as a hard error.

The 429 shape is added to the OpenAPI response schema for the three routes so it shows in the generated docs.

## Reset / window semantics

Fixed window. For each `(ip, route)` the plugin holds an integer counter in Redis under `sdpg-rl:<ip>:<routeId>` with a TTL equal to the window. The counter increments per request; when it exceeds `max` within the window, requests get `429` until the TTL lapses, at which point the key expires and the budget resets. No background sweep needed — TTL does the cleanup.

## Back-compat & side effects

- **Auth route becomes throttled.** Previously unlimited (config was inert). After this change, `/api/auth/*` enforces `10 req / 10s` per IP. Intended, but flagged so it isn't a surprise. NAT'd / shared-IP clients (e.g. an office behind one egress IP) share this budget — the window is small and the limit is per-10s, so normal login flows are unaffected; a stricter or per-account scheme is a separate concern.
- **Shared Redis.** Rate-limit keys live in the same Redis as the item-fetch cache; the `sdpg-rl:` namespace prevents collisions.
- **No change when disabled.** With `RATE_LIMIT_ENABLED=false`, nothing about today's behavior changes (plugin absent, all `config.rateLimit` inert).

## Testing

- **New dedicated test** (`discover.integration.test.ts` or a sibling `rate_limit.integration.test.ts`): build the app with `RATE_LIMIT_ENABLED=true`, fire `discover.max + 1` `/discover` injects from the same IP within the window, assert:
  - first `max` responses are non-429,
  - the next is `429` with body `{ error: 'RATE_LIMITED', message, retry_after_seconds }`,
  - `retry-after` and `RateLimit-*` headers present.
- **Read endpoints:** a lighter test asserting `/item/fetch` (or `/markers`) 429s past `read.max`.
- **Existing suites:** set `RATE_LIMIT_ENABLED=false` in the shared test environment so high-volume `app.inject` loops in the current integration tests don't trip the limiter. (`app.inject` requests originate from `127.0.0.1`, so without this they'd share one IP budget.)
- **Fail-open:** a test that points the limiter at an unreachable Redis and asserts requests still succeed (`skipOnError`).

## File-by-file change list

| File | Change |
|---|---|
| `apps/api/package.json` | add `@fastify/rate-limit` `^10` |
| `apps/api/src/config.ts` | add `rateLimitConfig` (env-driven) |
| `apps/api/src/app.ts` | conditional `app.register(rateLimit, …)` with Redis store, per-IP key, fail-open, `errorResponseBuilder` |
| `apps/api/src/routes/v1/network/item/discover.ts` | add `config.rateLimit` (discover budget) |
| `apps/api/src/routes/v1/network/item/fetch_item.ts` | add `config.rateLimit` to `/item/fetch` (read budget) |
| `apps/api/src/routes/v1/network/item/markers.ts` | add `config.rateLimit` to `/item/markers` + `/item/markers_local` (read budget) |
| `apps/api/src/routes/v1/network/item/__tests__/…` | new rate-limit tests; disable limiter in existing suites |
| `.env` example / deployment values | document the 5 `RATE_LIMIT_*` env vars |
| OpenAPI response schema (per route) | document the `429 RATE_LIMITED` shape |

## Follow-ups (out of scope)

- Cost/window weighting for `q` (embedding) vs plain requests on `/discover`.
- Per-account or per-API-key throttling on the authenticated surface.
- A global catch-all default across the whole public surface, if abuse shifts to other endpoints.
