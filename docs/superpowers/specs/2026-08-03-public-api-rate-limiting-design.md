# Public API Rate Limiting — Kong per-endpoint per-IP throttle for the expensive public reads (+ UI hardening)

Issue: [#432](https://github.com/Blue-Dots-Economy/signals-dpg/issues/432) — follow-up from the review of [#419](https://github.com/Blue-Dots-Economy/signals-dpg/pull/419) (List discover BFF).

> **Revision (2026-08-03):** an earlier draft of this spec proposed in-app `@fastify/rate-limit` (service side) keyed on `request.ip`. Investigating the deployment showed that approach is wrong for this environment — the service never sees a trustworthy client IP — so the throttle **moved to the Kong / bluedots-automation side**, where the real client IP is resolved via PROXY protocol. See **Why not the service side** below. The design is now a Kong-edge change plus two small UI hardenings.

## Goal

Bound the unauthenticated public read surface — the expensive `POST /api/v1/network/item/discover` embedding/vector path first — with a **per-IP** rate limit, so a single client can't cheaply drive up signals-search compute. Reuse the platform's existing Kong rate-limiting mechanism; return `429` the UI can back off on.

## Why not the service side (`request.ip` is not a real client IP here)

The instinct is to add the limiter in the Fastify service and key it on `request.ip`. That fails in this environment because **the service never sees a trustworthy client IP**. The proxy chain is **AWS Classic ELB (L4/TCP, PROXY protocol) → Kong (sole ingress controller) → API pods**. Two consequences, both documented by the platform team in `bluedots-automation/helm/common-services/values.yaml`:

- Behind an L4 LB, **X-Forwarded-For is client-settable and unsanitised**. A service trusting it (`trustProxy: true`, leftmost XFF) is *fully bypassable*: a client rotates `X-Forwarded-For` per request and `limit_by: ip` "never counts past 1". Their words: *"every request looked like a new IP and the rate limiter [was] fully bypassable."*
- The **trustworthy** client IP comes from the **PROXY-protocol header** the ELB prepends at the connection layer (not a client HTTP header), trusted only from the in-VPC LB (`real_ip_header: proxy_protocol`, `trusted_ips: <VPC CIDR>`). That value is resolved **at Kong** and is not forwarded to the pod as a trustworthy field. In the Fastify pod, `request.ip` is therefore either Kong's pod IP (every request collapses into **one** bucket — the "all same IP" failure) or a spoofable XFF value.

Either way a service-side per-IP limit is broken: it throttles everyone as one, or it throttles no one. The IP is only correct at **Kong**, so that is where the throttle belongs. This also matches the platform's stated intent — the signals-api catch-all tier `rl-signals-api: { minute: 10000 }` carries the comment *"loose catch-all; per-API limits do the real throttling."*

## Why also harden the UI (it goes through Kong too)

The UI's requests do pass through Kong and are counted like any other — so isn't the Kong limit enough? No: Kong and the UI changes solve **different** problems and are complementary.

- **Kong is enforcement** — the unbypassable protection for the *server*. It can only count what arrives; it can't change what the client generates or how it reacts to a `429`.
- **The UI hardenings make our own (and essentially only) legitimate client well-behaved**, which Kong cannot do:
  - **Debounce** cuts the requests the UI *generates*. Undebounced, typing "college" fires ~7 `/discover` calls — all counted against that user's **own** 120/min budget, so ordinary use could trip the user's *own* limit. Kong can't fix self-inflicted volume; the client must not create it.
  - **Not retrying `429`** matters *because* the request goes through Kong: on a `429` ("slow down"), React Query's global `retry: 2` would re-fire it twice more — hammering Kong exactly when it asked the client to back off (3× amplification). The client should respect the throttle, not fight it.

In short: Kong stops abuse; the UI changes stop the legitimate client from burning its own budget and retry-storming the `429`s. Neither replaces the other.

## What already exists (and the gap)

The signals-api chart already has a per-endpoint rate-limit mechanism: `helm/signals/charts/api/templates/api-endpoint-groups-ingress.yaml` renders, per path group, a Kong `rate-limiting` plugin (`limit_by: ip`, `policy: redis`, `fault_tolerant: true`, counters in the shared common-services Redis, correct across Kong replicas) plus an Ingress whose path is a Kong route referencing that plugin. signals-search uses the same pattern for `v1/search` at 600/min.

Current `apiRateLimit.groups` in `helm/signals/charts/api/values.yaml`:
```yaml
groups:
  - { path: /api/v1/item }
  - { path: /api/v1/action }
  - { path: /api/v1/event }
  - { path: /api/v1/match-score }
```
Our targets live under **`/api/v1/network/item/…`** (`discover`, `fetch`, `markers`) — a **different prefix**, so they are covered by **no** group and fall through to the loose `10,000/min` `/api` catch-all. That unbounded-expensive-path gap **is #432**.

## Design decisions (confirmed)

| # | Question | Decision |
|---|----------|----------|
| 1 | Which layer? | **Kong edge**, via the existing `apiRateLimit` groups mechanism. No app-level limiter (`request.ip` is unreliable behind Kong). |
| 2 | How is a caller keyed? | **`limit_by: ip`** on the PROXY-protocol client IP — unspoofable, resolved at Kong. |
| 3 | Store + reset? | **Shared common-services Redis** (`policy: redis`) → correct across Kong replicas. Per-minute fixed window; Redis counters expire and reset each window. |
| 4 | Which endpoints + limits? | `/discover` **120/min** per IP (own counter); `/fetch` + `/markers` **600/min** (the chart default). |
| 5 | Configurable? | Enable/default via `global.apiRateLimit.{enabled,defaultMinute}`; `/discover`'s tighter `limit: 120` lives on its group entry (promotable to a global anchor if per-env tuning is needed). |
| 6 | Response | Kong's `429` with `RateLimit-*` + `Retry-After` headers (client headers not hidden). Body is Kong's default `{ "message": "API rate limit exceeded" }`. UI surface, not aggregator/voice. |
| 7 | UI hardening (in scope) | (a) **debounce the list search box (~350 ms)** so typing sends one `/discover`, not one per keystroke; (b) **exclude `429`/4xx from React Query `retry`** so a throttled client backs off instead of tripling requests. |

## Sizing rationale (`/discover` = 120/min)

How the UI hits `/discover` today:
- **Infinite scroll**, page size **50** (`PROFILE_PAGE_SIZE` / `VITE_PROFILE_PAGE_SIZE`); `staleTime` 90 s caches re-views.
- **Search box fires per keystroke, undebounced** (`top-bar.tsx` `onChange → setSearch`; `deriveBrowseParams` memoized directly on `search`). Typing "college" ⇒ up to 7 query keys ⇒ 7 calls. React Query **aborts** in-flight requests on key change (a `signal` is threaded to `fetchDiscover`), cutting *completed* searches, but Kong counts requests on arrival.
- Global **`retry: 2`** retries any error incl. `429` ⇒ a too-tight limit self-amplifies 3×.

**120/min (~2 req/s)** sits well above realistic active use (search + paging, with abort damping), ~83× below today's 10k catch-all on the endpoint that actually costs embedding compute, and comfortably under the 600/min baseline used elsewhere. The UI debounce (decision 7a) sharply lowers legitimate `/discover` volume, so 120 leaves generous headroom.

## Components & changes

### A. `bluedots-automation` — Kong groups (the throttle itself)

**`helm/signals/charts/api/values.yaml`** — extend `apiRateLimit.groups`:
```yaml
groups:
  - { path: /api/v1/item }
  - { path: /api/v1/action }
  - { path: /api/v1/event }
  - { path: /api/v1/match-score }
  # #432 — bound the public network read surface (own prefixes, own counters):
  - { path: /api/v1/network/item/discover, limit: 120 }  # expensive embedding path — tight
  - { path: /api/v1/network/item/fetch }                  # default (600) — cheap DB read
  - { path: /api/v1/network/item/markers }                # default (600) — cheap DB read
```

Rendering (verified against the template):
- Paths are `pathType: Prefix`, `strip-path: false`. `/api/v1/network/item/discover` is its own Kong route/counter; `fetch` and `markers` **append to the existing default-600 KongPlugin + Ingress** (grouped by shared limit).
- `discover` (limit 120) renders a **new** `KongPlugin`/`Ingress` pair suffixed `-120`.
- All three are more specific than the `/api` catch-all Ingress, so Kong matches them first; the distinct prefixes don't overlap each other or the existing `/api/v1/item` groups. **No `regex-priority` needed** (plain prefix routes, not regex).
- `limit_by: ip` + `policy: redis` + `fault_tolerant: true` + `{vault://env/redis-password}` are inherited from the template — no new plumbing.

No `global-values.yaml` change is required (enable/`defaultMinute` anchors already exist). Optionally promote `discover`'s `120` to a `global.apiRateLimit.discoverMinute` anchor if per-environment tuning is wanted; deferred unless asked.

### B. `signals-dpg` — UI hardening

**`apps/ui/src/pages/home-page.tsx`** — debounce the free-text search before it drives the query. Keep `search` immediate for the input's controlled value; feed a **debounced value (~350 ms)** into `deriveBrowseParams` (small `useDebouncedValue` hook or `useDeferredValue` + timer) so `q` (and thus `/discover`) updates once typing settles. The map's text search (`useMapMarkers(..., search)`) should use the same debounced value for consistency.

**`apps/ui/src/lib/query-client.ts`** — replace `retry: 2` with a predicate that does **not** retry 4xx (esp. `429`):
```ts
retry: (failureCount, error) =>
  !(error instanceof HttpError && error.status >= 400 && error.status < 500) && failureCount < 2,
```
(Adapt to the app's actual error type.) A `429` then surfaces immediately for the UI to handle (toast + `Retry-After` backoff) instead of being retried into the limit.

## 429 contract (documented)

Kong returns:
```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 120
RateLimit-Remaining: 0
RateLimit-Reset: <seconds>
Retry-After: <seconds>

{ "message": "API rate limit exceeded" }
```
The body is Kong's default (customising it needs an extra plugin — out of scope; see follow-ups). The UI keys off the status + `Retry-After`, not the body string.

## Testing / verification

**A. Kong chart (`bluedots-automation`):**
- `helm template` the signals-api chart and assert: a `KongPlugin` `…-rl-120` with `minute: 120, limit_by: ip, policy: redis`; an Ingress routing `/api/v1/network/item/discover`; and `/api/v1/network/item/{fetch,markers}` present under the default-600 plugin/Ingress.
- `bash install.sh lint` (or `helm lint`) clean.
- Post-deploy smoke: from one source IP, 121 `/discover` calls in a minute ⇒ the 121st is `429` with `Retry-After`; a parallel `/fetch` stays 200 until its own 600 budget.

**B. UI (`signals-dpg`):**
- Debounce unit test: simulate rapid typing ⇒ exactly one `/discover` fetch after the settle window (assert via mocked `fetchDiscover`).
- `query-client` retry test: a mocked `429` is **not** retried; a `500` still retries up to 2.

## Back-compat & side effects

- `/discover` now `429`s past 120/min per IP; `/fetch` and `/markers` past 600/min. No change to the routes' handlers.
- **NAT/shared-IP**: users behind one egress IP share the per-IP budget. `/discover` at 120/min tolerates modest sharing; if a large shared-NAT tenant appears, bump via the group `limit:`.
- No change to the loose `/api` catch-all (still 10k) — it only catches paths not otherwise grouped.
- Not aggregator/voice-facing; no external-caller backoff contract.

## File-by-file

| Repo | File | Change |
|---|---|---|
| bluedots-automation | `helm/signals/charts/api/values.yaml` | add 3 `apiRateLimit.groups` (discover `limit:120`; fetch, markers at default) |
| signals-dpg | `apps/ui/src/pages/home-page.tsx` | debounce search (~350 ms) before it drives `/discover` (+ map text search) |
| signals-dpg | `apps/ui/src/lib/query-client.ts` | `retry` predicate excluding 4xx/`429` |
| signals-dpg | `apps/ui/src/…/__tests__` | debounce test; retry-policy test |

## Repos & branches

- **signals-dpg:** worktree branch `feat/432-public-api-rate-limiting` (this spec + the UI hardening).
- **bluedots-automation:** a separate branch for the chart change (created at implementation), its own PR.

## Follow-ups (out of scope)

- Custom `429` body via a Kong response-transformer/pre-function plugin, if a machine-readable error code is wanted.
- Promote `discover`'s limit to a `global.apiRateLimit` anchor for per-env tuning.
- Per-account / per-session limits (needs an auth identity; the public reads have none).
- Dashboards/alerts on the `429` rate via the existing cluster-wide kong-prometheus plugin.
