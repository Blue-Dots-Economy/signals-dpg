# Cross-DPG Telemetry & Insight Platform (umbrella)

> Umbrella design fixing the whole-platform vision, decisions, and phasing. Each sub-project (SP1–SP4) gets its own detailed spec. This depends on the **Event Platform** umbrella (notification-service `feat/event-platform`) — telemetry's analytics plane is a consumer of that event backbone.

## Overview

A single, common telemetry contract across all Blue Dots DPGs so they interface and extend each other, feeding **one shared insight/intelligence service**.

Two things are deliberately kept separate — **two planes**:

- **Observability plane (OpenTelemetry):** operational health — latency, errors, throughput, SLOs. Emitted as OTLP; stored columnar; viewed in a dashboard UI. This is a *backend-swappable* concern; the app contract is OTel.
- **Analytics/insight plane (event log):** business intelligence — funnels, cohorts, per-entity outcomes, UI impressions/clicks, "recompute this KPI over all history." Emitted as **durable telemetry events on the Kafka backbone**, consumed by the insight service.

The event model for the analytics plane is a **Sunbird-Telemetry-v3-derived envelope** (proven DPG-grade spec), re-mapped for our service mesh — which finally gives us the two things our current specs lack: a **UI-interaction taxonomy** (impressions/views/clicks) and **fixed-width hierarchy dimensions** (`rollup`) that make cross-instance / cross-network aggregation possible.

The cross-DPG artifact is a **language-neutral contract + a shared TS SDK** that Signals, aggregator, search, and notifications inherit and extend. **ai-diffusion (Python) conforms to the wire contract** but keeps its own `dpg_telemetry`.

## Goals

- One **common envelope + event taxonomy** across all DPGs, versioned and schema-validated.
- **UI-interaction telemetry** (impressions, views, clicks, search) — currently absent everywhere.
- A shared **insight/intelligence service**: queryable analytics, cross-instance/network rollups, config-driven KPIs, data exhaust.
- **Retire Signals `item_metrics`** (an interim insight hack) into the event-driven pipeline, preserving its good `metric_categories`/`status_rules` vocabulary as config-driven derivations.
- Keep the **operational** (OTel) plane, harmonizing ai-diffusion's and aggregator's two independent implementations into one contract.
- **Server-stamped tenancy**, PII/DPDP-safe, DPG-open BOM.

## Non-goals

- Not one telemetry library across Python + TS — the contract is language-neutral; the shared **code** SDK is TS-only.
- Not merging the two planes into one data model — OTel stays the operational model; the Sunbird-style event log is the analytics model; they are bridged by correlation id.
- Not building bespoke per-service metric engines — business KPIs are config-driven in the insight service.

## Where things stand today

- **ai-diffusion-dpg (Python):** mature OTel (`dpg_telemetry` SDK → Collector → Jaeger/Prometheus/Loki/Grafana), `TurnEvent`/`Signal` envelopes, config-driven `OutcomeTracker`, resource attrs `service.name`/`dpg.block`/`dpg.domain`, cross-DPG MCP trace propagation, PII separation.
- **aggregator-dpg (TS, PR #354, unmerged):** near-identical OTel design independently — `@aggregator-dpg/telemetry` SDK, same stack, `TurnPayload`/`SignalPayload`, `observability-svc` with config-driven `OUTCOME_METRICS_JSON`, histogram bucket catalogue, Collector redaction + tail-sampling, Prometheus SLO burn-rate rules. Plus a durable `onboarding` funnel rollup (Postgres) independent of OTel.
- **Signals-DPG (TS):** no OTel. A mature **business-metrics** engine only: config-driven `item_metrics` precompute + aggregator dashboard, canonical 4-bucket (`create/accept/reject/cancel`) / 4-status (`new/active/at_risk/inactive`) vocabulary driven by network.json (`metric_categories`, `status_rules` DSL, `dashboard_tiles`, `dashboard_buckets`). On-demand TTL recompute; **no cross-instance federation**.
- **signals-search, notification-service (TS):** essentially un-instrumented. Search records nothing at its `/v1/search` handler; notifications expose only an instantaneous Redis queue-depth endpoint, no DB.

The two OTel layers have converged independently — same endpoints (`/emit/turn`, `/emit/signal`, `/validate-config`), same "outcome-event → config-driven KPI" pattern, same PII split, same `dpg.block` resource attr. That convergence is the opening: extract the contract, align both, roll it into the three un-instrumented services.

## Problems we're solving

1. **No common contract** — two independent OTel SDKs, one bespoke metrics engine, three un-instrumented services; nothing composes across DPGs.
2. **No UI telemetry** — impressions/views/clicks/search are captured nowhere.
3. **No cross-instance / cross-network aggregation** — Signals computes `item_metrics` per instance; there is no rollup across instances or networks.
4. **Outcome events dead-end into Prometheus counters** — pre-aggregated, no per-entity records, no replay; you cannot build an intelligence service on them.
5. **`item_metrics` is an interim silo** — good vocabulary, wrong home (precompute table, not events + pipeline).
6. **Tenancy trust** — Sunbird-style ingest trusts client `pdata`/`channel`; combined with our unauthenticated inter-instance posture, producer/tenant must be server-stamped.
7. **DPG license** — every component OSI-open + free.

## Key decisions

### 1. Two planes, bridged by correlation id
Observability = OTel/OTLP (operational). Analytics = Sunbird-style events on Kafka (business). The analytics envelope's `cdata[]` carries the OTel `trace_id`, so a business event and its operational trace are joinable.

### 2. One harmonized envelope (Sunbird v3, re-mapped)
One envelope; only `edata` changes per event. Used for both `domain.*` and `telemetry.*` streams (below), reconciling the event-platform envelope and the telemetry envelope into one contract.

| Field | Meaning | Blue Dots mapping |
|---|---|---|
| `eid` | event type | our taxonomy (§ Event taxonomy) |
| `ets` / `ver` / `mid` | ts / envelope ver / message id | **`mid` = dedup + replay key (mandatory)** |
| `actor {id,type}` | who acted | Keycloak `sub` / `User`\|`System`\|`Service` |
| `context.channel` | tenant | **`network`** — server-stamped from verified claim |
| `context.pdata {id,pid,ver}` | producer | `id`=service (`signals-dpg`), `pid`=`api`\|`worker`\|`web`, `ver`=git sha |
| `context.env` | module | subsystem / route family |
| `context.sid` / `did` | session / device | UI session / device |
| `context.cdata[] {type,id}` | correlation | `{action,<id>}`, `{request,<traceId>}` — journey + OTel bridge |
| `context.rollup.l1..l4` | hierarchy | **`network → domain → instance → org`** (fixed-width OLAP dims) |
| `object {id,type,ver,rollup}` | entity | `type ∈ {participant,item,action,notification}`; `object.rollup` = item→version→parent |
| `edata` | payload | per-`eid` schema |
| `tags[]` | segmentation | optional |

The three dimensions our current specs lack: **`pdata`** (emitting service/instance), **`cdata`** (journey/trace), **`rollup`** (fixed 4-level hierarchy). `rollup = network→domain→instance→org` is what makes cross-instance/cross-network rollups possible.

### 3. Event taxonomy — adopt / drop / express-as
- **Adopt (domain-neutral):** `IMPRESSION`, `INTERACT`, `SEARCH`, `START`, `END`, `ERROR`, `LOG`, `AUDIT`, `METRICS`, `SUMMARY`, `HEARTBEAT`, `FEEDBACK`, `SHARE`, `INTERRUPT`.
- **Drop education-specific:** `ASSESS`; re-map `RESPONSE` → generic form-submit only if needed.
- **Express business/outcome events as `AUDIT`** (object X → state Y, with `props/state/prevstate`): aggregator's `participant.onboarded`/`aggregator.created`, Signals' action status changes, `tnc.published` are all state changes. Search = `SEARCH`; UI = `IMPRESSION`/`INTERACT`; notification delivery/bounce = `AUDIT`/`METRICS`. The cross-DPG business story rides ~5 event types, not a per-service sprawl.

`edata` for the priority events:
- **IMPRESSION** — `{type: list|detail|view|edit|search, subtype?, pageid, uri, visits[]: {objid,objtype,section,index}}`.
- **INTERACT** — `{type: TOUCH|SCROLL|CHOOSE|ACTIVATE|…, subtype?, id, pageid?, target?, plugin?, extra?}`.
- **SEARCH** — `{type, query, filters?, sort?, size, topn[]}` (search telemetry: query, filters used, result count, zero-result, top-N + scores).
- **AUDIT** — `{props[], state, prevstate, duration?}`.
- **METRICS** — declarative business-metric emission (see insight service).

### 4. Two stream families on the shared Kafka backbone
- **`domain.*`** — business events that drive behavior (notification triggers, choreography). Lower volume, stronger guarantees. Consumed by notification-service and other reactors.
- **`telemetry.*`** — high-volume analytics events (IMPRESSION/INTERACT/SEARCH/METRICS). Best-effort, high retention to cold storage. Consumed by the insight service.

Same backbone, same envelope, separated by purpose/volume/retention (as Sunbird isolates its telemetry pipeline). An `AUDIT` event may appear on both; `mid` dedups.

### 5. Common TS SDK
One package (platform repo) all TS DPGs inherit and extend; ai-diffusion's Python SDK conforms to the same wire contract:
1. `bootTelemetry()` — OTel init (operational plane), harmonizing ai-diffusion's + aggregator's bootstraps into one config contract.
2. **Telemetry emitter** — builds the canonical envelope, **server-stamps `pdata`/`network`/`actor` from the verified request context** (never client-asserted), assigns `mid`, produces to `telemetry.*`/`domain.*` (backend: SDK→outbox→Kafka; browser: →ingest gateway).
3. **UI helpers** — `impression()`, `interact()`, `search()` for portals.
4. PII/cardinality guards + JSON-schema-per-`eid` validation.

### 6. Ingest — two doors
- **`POST /v3/telemetry` batch gateway** for browser/UI/external producers → Kafka (browsers can't produce to Kafka).
- **SDK → outbox → Kafka** for backend services (via the event platform's outbox+Debezium).

### 7. Pipeline + insight service
Borrowed from Sunbird/Obsrv: **validate-per-`eid` → `mid`-dedup → server-stamp/enrich (expand `rollup`, join identity) → sinks.** The **insight service** is the consumer: builds the queryable analytical store, computes **`SUMMARY`** events *written back to the log*, serves dashboards + data exhaust. **Signals `item_metrics` is retired into this** — its `metric_categories`/`status_rules` DSL and canonical buckets/statuses become **config-driven derivations over the event stream**, now working across instances via `rollup`.

### 8. Backend: target ClickStack (ClickHouse + HyperDX)
Since ClickHouse is already the analytics store, adopt **ClickStack** (OTel-native observability on ClickHouse) so **one columnar store serves both planes** — operational traces/logs/metrics (HyperDX UI) and business telemetry — correlatable by `trace_id`/`cdata`. The instrumentation stays OTel (backend-swappable; no app change). ClickHouse handles the high cardinality Prometheus punishes.
- **Retire** Jaeger + Loki (subsumed by ClickHouse); dashboards via HyperDX (or Grafana-on-ClickHouse).
- **Keep** a thin **Prometheus + Alertmanager** for SLO/burn-rate alerts (aggregator already has these) until ClickStack alerting parity is confirmed; Collector fans out to both during transition, then Prometheus is dropped.
- This is deployment config in `bluedots-automation`, owned by the SP2/SP3 specs.

### 9. Tenancy, PII, DPG BOM
- **Server-stamped tenancy:** `network`/`pdata`/`actor` derived from the verified request context at ingest — the Sunbird ingest-trust caution meets our network-claim invariant.
- **PII/DPDP:** two exclusion lists (strict `audit.pii_fields_excluded` vs looser `telemetry.pii_fields_excluded`); no PII in metric labels; retention tiers; enforcement at the ingest/redaction gate (the gap both existing designs left unenforced).
- **OSI-open BOM:** OTel Collector (Apache-2.0), Kafka + Apicurio (from the event platform), **ClickHouse (Apache-2.0)**, **HyperDX OSS (MIT)**; Prometheus/Alertmanager (Apache-2.0) transitional.

## Architecture

```
                         ┌────────── OBSERVABILITY plane (OTel) ──────────┐
 all DPG services  ──OTLP──▶ OTel Collector ──▶ ClickHouse (obs schema) ──▶ HyperDX UI
 (SDK bootTelemetry)                     └──(transitional)──▶ Prometheus ──▶ Alertmanager

                         ┌────────── ANALYTICS plane (event log) ─────────┐
 backend  ──SDK→outbox→──┐
 browser ─▶ /v3/telemetry─┼─▶ Kafka  telemetry.*  ──▶ pipeline ──▶ ClickHouse (analytics schema)
                          │        domain.*             validate/eid            │
                          │                             mid-dedup               ▼
                          │                             enrich(rollup)   ┌──────────────────┐
                          └─────────────────────────────────────────────│ INSIGHT service  │
                                                                          │ config KPIs,      │
     bridged by cdata.trace_id ↔ OTel trace                              │ SUMMARY→log,      │
                                                                          │ cross-instance    │
                                                                          │ rollups, exhaust  │
                                                                          └──────────────────┘
```

## Data model (analytics store — ClickHouse; sketch, finalised per SP3)

Columnar, not normalized tables. The canonical **event envelope** (§ decision 2) is the wide row; fixed OLAP dimensions `eid`, `context.pdata.id`, `context.env`, `context.channel(network)`, `context.rollup.l1..l4`, `object.type`, `object.rollup.l1..l4`, `ets`. Materialized views per business question; `SUMMARY` events stored like any event. Config-driven metric/derivation definitions (the `metric_categories`/`status_rules` DSL, generalised) live as versioned config in the insight service, not code.

## First-cut functional metrics for business insight

`✅` captured today · `◐` partial · `○` new. Each becomes a config-driven derivation over the event stream.

**Acquisition & onboarding funnel** — registrations (by aggregator/source) ◐; link submissions passed/failed/skipped ◐; bulk rows total/succeeded/signalstack-failed ◐; participants onboarded by source (bulk/link/self/voice) ◐; profile completion % and pre-complete drop-off ✅(Signals).

**Engagement & lifecycle** — users by status new/active/at_risk/inactive ✅; items created, complete profiles, avg items/user ✅; actions initiated/received by bucket (create/accept/reject/cancel) ✅; time-to-first-action, time-to-accept ○.

**Matching & outcomes** — connections made (accepts), rejection/withdrawal rate ✅; application→shortlist→accept conversion ◐; match-score distribution, zero-match rate ○.

**Search & discovery** — searches, zero-result rate, filter usage, result CTR, p95 latency, cache-hit rate ○ (all at the search `/v1/search` handler + IMPRESSION/INTERACT on results).

**Notifications & comms** — sends by channel, delivery rate, bounce/fail rate ○; **OTP delivery success & latency (login-critical)** ○; bulk campaign completion/failure report ○.

**UI engagement (new via IMPRESSION/INTERACT)** — page/screen views, section impressions, click-through, funnel step abandonment, time-on-page (via `SUMMARY`) ○.

**Conversation & voice** — sessions, turns, drop-off by stage, escalations, task-completed ✅(ai-diffusion); LLM tokens/latency/cost ✅.

**Cross-DPG, trust & compliance** — cross-instance discovery calls, cross-network actions, A2A calls ◐; trust blocks, consent captured/declined, PII reveals, erasure requests ◐ (ai-diffusion trust + consent-service + Signals `pii_reveal_audit`).

## API sketch (finalised per phase)

- `POST /v3/telemetry` — batch ingest `{id, ver, events:[<envelope>...]}` → Kafka. Auth Bearer/HMAC; `network`/`pdata` server-stamped; per-`eid` schema validation; `mid`-dedup; always returns per-event `{status: ok|duplicate|dropped}`.
- **Insight service** — query/rollup endpoints (per-network dashboards, cross-instance aggregation), data-exhaust (per-tenant CSV/parquet), `GET /validate-config` for the KPI/derivation catalogue.
- Observability = OTLP to the Collector (not REST).

## Repos

- **Common TS SDK** — in the platform (event-fabric) repo, alongside the consumer SDK it builds on. Signals/aggregator/search/notifications depend on it; ai-diffusion conforms via its Python SDK.
- **Ingest gateway + pipeline + insight service** — new service(s) (candidate: part of the insight/data-pipeline service). Consumes the event backbone.
- **Backend infra** (Collector, ClickHouse/ClickStack, transitional Prometheus) — deployment config in `bluedots-automation`.

## Phases (each its own branch/plan/spec; depends on the Event Platform umbrella)

- **SP1 — Contract + TS SDK:** the envelope, `eid` taxonomy, per-`eid` JSON schemas, resource attrs, PII/cardinality/naming rules; the shared TS SDK (boot OTel + emitter + UI helpers). Harmonizes ai-diffusion's + aggregator's designs.
- **SP2 — Observability-plane rollout:** OTel + SDK into signals/search/notifications (the per-service telemetry technical specs requested); align aggregator PR #354; ai-diffusion conforms; stand up ClickStack, migrate off Jaeger/Loki, keep Prometheus for alerting.
- **SP3 — Analytics plane:** ingest gateway + pipeline (validate/dedup/enrich) + insight service on the event log + ClickHouse OLAP; **retire `item_metrics`** into config-driven derivations.
- **SP4 — UI telemetry:** IMPRESSION/INTERACT/SEARCH in the portals (Signals UI, aggregator web).

## Open questions

- OLAP/ClickHouse topology (single-node vs cluster) and ClickStack alerting parity vs retained Prometheus — owned by SP2/SP3.
- Whether the insight service is a new standalone service or folds into a broader data-pipeline service.
- Exact generalisation of Signals' `status_rules`/`metric_categories` DSL into the cross-DPG derivation config.
- Retention tiers per stream/event class (hot ClickHouse vs cold object store).
- Consent/PII enforcement point for telemetry (ingest redaction gate) vs consent-service coupling.
