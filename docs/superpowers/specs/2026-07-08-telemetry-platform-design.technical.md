# Cross-DPG Telemetry & Insight Platform Design

**Audience:** System architect and engineers building telemetry across the Blue Dots network — the common contract, the shared TS SDK, the ingest/pipeline, and the insight service — spanning Signals, aggregator, signals-search, and notification-service (TypeScript), with ai-diffusion-dpg (Python) conforming to the wire contract. This is the **umbrella**: it fixes the whole-platform vision and invariants; each sub-project (SP1–SP4) gets its own detailed spec.

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
5. [Data Model](#5-data-model)
6. [API Spec](#6-api-spec)
7. [Summary](#7-summary)

---

## 1. Introduction

This document describes a **common telemetry contract across every Blue Dots DPG**, so the services interface and extend each other and feed **one shared insight/intelligence service**.

The single organising idea is this: **there are two telemetry planes, and they must not be conflated.**

- The **observability plane** answers *"is the system healthy?"* — latency, errors, throughput, SLOs. It is emitted as OpenTelemetry (OTLP), and its backend is deliberately swappable.
- The **analytics/insight plane** answers *"what is happening in the business, and why?"* — onboarding funnels, engagement, matching outcomes, and UI interactions. It is emitted as **durable events on the network's Kafka backbone** and consumed by the insight service.

Two definitions carry the design. A **telemetry event** is one immutable envelope whose `eid` selects its payload schema — the event model is adopted from **Sunbird Telemetry v3**, a proven DPG-grade specification, re-mapped for our service mesh. The **insight service** is the consumer of the analytics event log that materialises the queryable analytical store, derives KPIs, and serves dashboards and data exhaust.

The design covers:

- Why the two planes stay separate, and how they are bridged (§4.1)
- The harmonised event envelope and the three dimensions we currently lack — producer, correlation, hierarchy (§4.2)
- The event taxonomy, and why ~5 event types carry the whole business story (§4.3)
- Two stream families on the shared backbone (§4.4)
- The common TS SDK, and how ai-diffusion conforms without sharing code (§4.5)
- Ingest, pipeline, and the insight service that retires Signals' `item_metrics` (§4.6–4.7)
- The unified ClickStack backend (§4.8), tenancy/PII/BOM (§4.9), repos and phasing (§4.10)
- A first-cut functional-metrics catalogue (§4.11)

> **Note on dependency:** the analytics plane is a **consumer of the Event Platform** (notification-service `feat/event-platform`). This umbrella assumes that Kafka backbone, its envelope, and its outbox+Debezium producer path exist. See §4.4.

> **Note on the language boundary:** the cross-DPG artifact is a **language-neutral contract plus a TS SDK**. ai-diffusion is Python and keeps its own `dpg_telemetry`; it conforms to the wire contract, not the code. A single library spanning both runtimes is explicitly out of scope.

---

## 2. Background & Problem Statement

### Background

Four services have telemetry today at four different maturities, and none of it composes.

**ai-diffusion-dpg (Python)** is the most advanced: a shared `dpg_telemetry` bootstrap installed by all blocks, OpenTelemetry → Collector → Jaeger/Prometheus/Loki/Grafana, per-turn `TurnEvent` and discrete `Signal` envelopes emitted async post-response, a config-driven `OutcomeTracker` that turns outcome events into metric counters, resource attributes `service.name`/`dpg.block`/`dpg.domain`, cross-DPG MCP (agent-to-agent) trace propagation, and a deliberate PII split (raw transcripts in a SQLite audit store; no PII in telemetry).

**aggregator-dpg (PR #354, unmerged)** independently built a **near-identical** OpenTelemetry design in TypeScript: an `@aggregator-dpg/telemetry` package, the same Collector→Jaeger/Prometheus/Loki/Grafana stack, `TurnPayload`/`SignalPayload` envelopes, a standalone `observability-svc` that registers OTel instruments from a declarative `OUTCOME_METRICS_JSON` catalogue, an explicit histogram-bucket catalogue, Collector redaction + tail-sampling, and Prometheus SLO burn-rate rules. Separately — as shipped product — it has a durable `onboarding` funnel: `link_submissions` → a BullMQ rollup job → an `onboarding` table read by the dashboard.

**Signals-DPG** has **no OpenTelemetry at all**. It has a mature **business-metrics** engine instead: a config-driven `item_metrics` precompute table feeding the aggregator dashboard, with a canonical four-bucket (`create/accept/reject/cancel`) / four-status (`new/active/at_risk/inactive`) vocabulary driven by `network.json` (`metric_categories`, a `status_rules` DSL, `dashboard_tiles`, `dashboard_buckets`). Recompute is on-demand under a per-(org,domain) advisory lock with a TTL; there is **no cross-instance federation** — each instance computes only over its own rows.

**signals-search** and **notification-service** are effectively un-instrumented: search records nothing at its `/v1/search` handler (not even its own p95 SLO), and notifications expose only an instantaneous Redis queue-depth endpoint and have no database.

That the two OTel layers converged independently — same emit endpoints, same "outcome-event → config-driven KPI" pattern, same PII split, same `dpg.block` dimension — is the opening this design exploits.

### Problem Statement

**Problem 1 — No common contract.** *Core challenge:* two independent OTel SDKs (Python, TS), one bespoke metrics engine, and two un-instrumented services share no envelope, taxonomy, or resource model — nothing composes across DPGs.

**Problem 2 — No UI telemetry.** *Core challenge:* impressions, views, clicks, and search interactions — the raw material of product insight — are captured nowhere.

**Problem 3 — No cross-instance / cross-network aggregation.** *Core challenge:* Signals computes metrics per instance with no hierarchy dimension; a metric cannot be rolled up across the instances of a network, or across networks.

**Problem 4 — Outcome events dead-end into counters.** *Core challenge:* both OTel layers turn business outcome events into Prometheus counters — pre-aggregated, no per-entity record, no replay — on which no intelligence service can be built.

**Problem 5 — `item_metrics` is an interim silo.** *Core challenge:* it holds genuinely good vocabulary in the wrong home (a precompute table, not events + pipeline) and was always a stopgap until telemetry landed.

**Problem 6 — Tenancy trust.** *Core challenge:* Sunbird-style ingest trusts client-asserted `pdata`/`channel`; combined with our unauthenticated inter-instance posture, the producer and tenant fields must be server-stamped.

**Problem 7 — DPG license compliance.** *Core challenge:* every component must be OSI-open and free to self-host, with no enterprise-gated features.

> **Note on prior effort (provisional):** aggregator PR #354 and ai-diffusion's observability layer are not discarded — they are the two implementations this contract *harmonises*. Where they disagree (envelope shape, namespace), §4 picks one; where they agree, that agreement becomes the contract.

---

## 3. Key Design Problems

The design in §4 resolves the seven problems through deliberate choices, each with its trade-off:

- **Two planes, bridged by correlation id** (§4.1) — keeps operational and business telemetry in the right data models (addresses P1, P4), at the cost of two pipelines instead of one.
- **A harmonised Sunbird-v3 envelope** (§4.2) — one contract with producer/correlation/hierarchy dimensions (solves P1, P2, P3), at the cost of every service adopting a richer envelope.
- **Business events expressed as `AUDIT`** (§4.3) — the whole business story rides ~5 event types (simplifies P4), rather than a per-service event sprawl.
- **Analytics events on the shared backbone** (§4.4) — durable, replayable, per-entity records (solves P4), reusing the Event Platform rather than a new bus.
- **A TS-only common SDK** (§4.5) — one library the TS DPGs extend (solves P1), with ai-diffusion conforming to the wire contract only.
- **Insight service consumes the log; `item_metrics` retired into it** (§4.6–4.7) — config-driven derivations that finally work cross-instance (solves P3, P5).
- **Unified ClickStack backend** (§4.8) — one columnar store for both planes (solves P7's cardinality/retention needs), keeping Prometheus only for alerting on a retirement path.
- **Server-stamped tenancy + OSI-open BOM** (§4.9) — safe multi-tenancy (solves P6) on a fully open stack (solves P7).

---

## 4. Design

### 4.1 Two planes, bridged by correlation id

The observability plane is OpenTelemetry (spans/metrics/logs), emitted OTLP; the analytics plane is the Sunbird-style event log on Kafka. They are different data models on purpose — operational health is low-cardinality, aggregate, and alert-driven; business analytics is high-cardinality, per-entity, and replay-driven. **They are bridged by carrying the OTel `trace_id` in the analytics envelope's `context.cdata[]`**, so a business event and the operational trace that produced it are joinable.

```
 service handler
   ├── OTel span/metric  ──OTLP──▶  observability plane   (§4.8)
   └── telemetry event   ──Kafka──▶ analytics plane       (§4.4, §4.7)
                              │
        cdata:[{type:request,id:<trace_id>}]  ← the bridge
```

*Why not one model:* forcing business events through the metrics store (Prometheus) is exactly what dead-ended the two existing designs (P4); forcing operational spans through the analytics pipeline loses OTel's tracing semantics. Two models, one correlation key.

### 4.2 The harmonised envelope (Sunbird v3, re-mapped)

One envelope; only `edata` changes per `eid`. It is the single contract for both the `domain.*` and `telemetry.*` streams (§4.4), reconciling the Event Platform's domain envelope with the telemetry envelope.

| Field | Meaning | Blue Dots mapping |
|---|---|---|
| `eid` | event type | taxonomy in §4.3 |
| `ets` / `ver` / `mid` | timestamp / envelope version / message id | **`mid` is the dedup + replay key (mandatory)** |
| `actor {id,type}` | who acted | Keycloak `sub` / `User`\|`System`\|`Service` |
| `context.channel` | tenant | **`network`** — server-stamped from the verified claim (§4.9) |
| `context.pdata {id,pid,ver}` | producer | `id`=service (`signals-dpg`), `pid`=`api`\|`worker`\|`web`, `ver`=git sha |
| `context.env` | module | subsystem / route family |
| `context.sid` / `did` | session / device | UI session / device |
| `context.cdata[] {type,id}` | correlation | `{action,<id>}`, `{request,<trace_id>}` — journey stitch + OTel bridge (§4.1) |
| `context.rollup.l1..l4` | hierarchy | **`network → domain → instance → org`** (fixed-width OLAP dimensions) |
| `object {id,type,ver,rollup}` | entity | `type ∈ {participant,item,action,notification}`; `object.rollup` = item→version→parent |
| `edata` | payload | per-`eid` schema |
| `tags[]` | segmentation | optional |

*Why this envelope:* our current specs lack three dimensions that Sunbird makes first-class. **`pdata`** identifies the emitting service/instance (our service-mesh identity). **`cdata`** threads many events into one journey and carries the trace id. **`rollup`** is a fixed 4-level hierarchy — and mapping it to `network → domain → instance → org` is precisely what makes cross-instance and cross-network aggregation possible (solves P3), while staying OLAP-friendly (fixed-width group-by columns). `mid` is mandatory because the pipeline dedups on it (§4.7).

### 4.3 Event taxonomy

- **Adopt (domain-neutral):** `IMPRESSION`, `INTERACT`, `SEARCH`, `START`, `END`, `ERROR`, `LOG`, `AUDIT`, `METRICS`, `SUMMARY`, `HEARTBEAT`, `FEEDBACK`, `SHARE`, `INTERRUPT`.
- **Drop education-specific:** `ASSESS`; re-map `RESPONSE` → generic form-submit only if needed.
- **Express business/outcome events as `AUDIT`.** A participant onboarded, an action accepted/rejected, a T&C published — these are all *object X → state Y* changes, i.e. `AUDIT` with `{props[], state, prevstate}`. Search is `SEARCH`; UI is `IMPRESSION`/`INTERACT`; notification delivery/bounce is `AUDIT`/`METRICS`.

*Why express business events as `AUDIT`:* it collapses aggregator's `participant.onboarded`/`aggregator.created`, Signals' action-status transitions, and `tnc.published` into one well-understood event type, so the cross-DPG business story rides ~5 event types rather than a per-service vocabulary that never composes (P1).

`edata` for the priority events:

```
IMPRESSION  { type:list|detail|view|edit|search, subtype?, pageid, uri,
              visits[]:{objid,objtype,section,index} }
INTERACT    { type:TOUCH|SCROLL|CHOOSE|ACTIVATE|…, subtype?, id, pageid?,
              target?, plugin?, extra? }
SEARCH      { type, query, filters?, sort?, size, topn[] }
AUDIT       { props[], state, prevstate, duration? }
METRICS     { <declarative business metric emission — see §4.7> }
```

### 4.4 Two stream families on the shared backbone

```
 domain.*    business events that drive behaviour   ──▶ notification-service, reactors
             (choreography; stronger guarantees)
 telemetry.* high-volume analytics events           ──▶ insight service (§4.7)
             (best-effort; long retention → cold)
```

Same Kafka backbone (the Event Platform), same envelope (§4.2), separated by purpose, volume, and retention — as Sunbird isolates its telemetry pipeline from its transactional events. An `AUDIT` event may legitimately appear on both a `domain.*` and a `telemetry.*` topic (it both drives a notification and is analytically interesting); `mid`-dedup (§4.7) makes that safe.

### 4.5 Common TS SDK

One package in the platform (event-fabric) repo, inherited and extended by all TS DPGs; ai-diffusion's Python SDK conforms to the same wire contract (§1 note). It provides:

1. `bootTelemetry()` — OTel init for the observability plane, harmonising ai-diffusion's and aggregator's two bootstraps into one config contract.
2. A **telemetry emitter** — builds the canonical envelope, **server-stamps `pdata`/`network`/`actor` from the verified request context** (§4.9), assigns `mid`, and produces to `telemetry.*`/`domain.*` (backend: SDK → outbox → Kafka; browser: → ingest gateway, §4.6).
3. **UI helpers** — `impression()`, `interact()`, `search()` for the portals.
4. **Guards** — PII/cardinality checks and JSON-schema-per-`eid` validation before emit.

*Why one SDK and not conventions alone:* the two existing implementations proved the pattern converges but diverges in the details (envelope shape, namespace, bucket catalogue); a shared library makes the contract executable rather than aspirational.

### 4.6 Ingest — two doors

```
 backend service ──SDK→outbox→ Kafka          (atomic with the producer's DB write, via Debezium)
 browser / UI    ──▶ POST /v3/telemetry ──▶ Kafka   (browsers cannot produce to Kafka)
 external caller ──▶ POST /v3/telemetry ──▶ Kafka
```

*Why two doors:* backend producers get exactly-once-ish emission through the Event Platform's outbox; browsers and external callers cannot speak Kafka, so a thin batch gateway fronts it. This mirrors the Event Platform's own two-door design.

### 4.7 Pipeline and insight service

The pipeline is borrowed from Sunbird/Obsrv:

```
 Kafka telemetry.* ─▶ validate(JSON-schema per eid) ─▶ mid-dedup ─▶ enrich(expand rollup,
                        │ (bad → dead-letter)             │           join identity)
                        ▼                                 ▼                 ▼
                                                              ClickHouse (analytics)  ─┐
                                                                                       ├─▶ INSIGHT service
                        cold object-store archive (replay) ───────────────────────────┘
```

The **insight service** is the consumer: it materialises the queryable analytical store, computes **`SUMMARY`** events *written back to the log* (summaries are just events, replayable like any other), serves dashboards and per-tenant data exhaust, and derives config-driven KPIs.

**Signals' `item_metrics` is retired into this** (§P5): its `metric_categories`/`status_rules` DSL and canonical buckets/statuses become **config-driven derivations over the event stream**. Because events carry `rollup = network→domain→instance→org`, the same derivations now aggregate *across* instances and networks — the capability `item_metrics` never had.

*Why derived summaries as events, not a side table:* it keeps one append-only source of truth, so adding a new metric definition means replaying history through a new derivation rather than backfilling a bespoke table.

### 4.8 Backend: target ClickStack (ClickHouse + HyperDX)

Since the analytics plane already needs ClickHouse, adopt **ClickStack** — OTel-native observability on ClickHouse — so **one columnar store serves both planes**: operational traces/logs/metrics (HyperDX UI) and business telemetry, correlatable by `trace_id`/`cdata` (§4.1). The app-side instrumentation stays OTel, so this is a backend swap, not a rewrite — and ClickHouse absorbs the high cardinality Prometheus punishes (the reason both prior designs needed strict label caps).

```
 all services ──OTLP──▶ OTel Collector ──▶ ClickHouse (obs schema) ──▶ HyperDX
                                 └──(transitional)──▶ Prometheus ──▶ Alertmanager
 telemetry.* (Kafka) ─────────────────────▶ ClickHouse (analytics schema) ──▶ insight service
```

- **Retire** Jaeger + Loki (subsumed by ClickHouse).
- **Keep** a thin Prometheus + Alertmanager for SLO/burn-rate alerts (aggregator already has these) **until ClickStack alerting parity is confirmed**, then drop it; the Collector fans out to both during the transition.

> **Note (provisional):** this is deployment configuration in `bluedots-automation`, and the migration detail — ClickHouse topology, alerting parity — is owned by the SP2/SP3 specs, not this umbrella.

### 4.9 Tenancy, PII, and DPG bill of materials

**Server-stamped tenancy.** `network`/`pdata`/`actor` are derived from the verified request context at ingest, never client-asserted — the Sunbird ingest-trust caution meeting our network-claim invariant (P6). This is what makes a shared, multi-tenant analytics store safe.

**PII / DPDP.** Two exclusion lists — strict `audit.pii_fields_excluded` vs looser `telemetry.pii_fields_excluded` — enforced at the ingest redaction gate (both prior designs declared this but left enforcement unbuilt). No PII in metric labels; retention tiered per stream/event class.

**OSI-open BOM (P7):** OpenTelemetry Collector (Apache-2.0), Kafka + Apicurio (from the Event Platform), **ClickHouse (Apache-2.0)**, **HyperDX OSS (MIT)**; Prometheus/Alertmanager (Apache-2.0) transitional.

### 4.10 Repos and phasing

- **Common TS SDK** — in the platform (event-fabric) repo, alongside the consumer SDK it builds on. Signals/aggregator/search/notifications depend on it; ai-diffusion conforms via its Python SDK.
- **Ingest gateway + pipeline + insight service** — new service(s) (candidate: a broader data-pipeline/insights service); consumes the event backbone.
- **Backend infra** — Collector, ClickHouse/ClickStack, transitional Prometheus — deployment config in `bluedots-automation`.

Phases (each its own branch/plan/spec; depends on the Event Platform umbrella):

- **SP1 — Contract + TS SDK:** envelope, `eid` taxonomy, per-`eid` JSON schemas, resource attributes, PII/cardinality/naming; the shared TS SDK. Harmonises ai-diffusion + aggregator.
- **SP2 — Observability-plane rollout:** OTel + SDK into signals/search/notifications; align aggregator PR #354; ai-diffusion conforms; stand up ClickStack; retire Jaeger/Loki; keep Prometheus for alerting.
- **SP3 — Analytics plane:** ingest gateway + pipeline + insight service on the event log + ClickHouse OLAP; **retire `item_metrics`**.
- **SP4 — UI telemetry:** `IMPRESSION`/`INTERACT`/`SEARCH` in the portals (Signals UI, aggregator web).

### 4.11 First-cut functional metrics

`✅` captured today · `◐` partial · `○` new. Each becomes a config-driven derivation (§4.7) over the event stream.

- **Acquisition & onboarding funnel** — registrations by aggregator/source ◐; link submissions passed/failed/skipped ◐; bulk rows total/succeeded/signalstack-failed ◐; participants onboarded by source (bulk/link/self/voice) ◐; profile completion % and pre-complete drop-off ✅.
- **Engagement & lifecycle** — users by status new/active/at_risk/inactive ✅; items created, complete profiles, avg items/user ✅; actions initiated/received by bucket ✅; time-to-first-action, time-to-accept ○.
- **Matching & outcomes** — connections (accepts), rejection/withdrawal rate ✅; application→shortlist→accept conversion ◐; match-score distribution, zero-match rate ○.
- **Search & discovery** — searches, zero-result rate, filter usage, result CTR, p95 latency, cache-hit rate ○.
- **Notifications & comms** — sends by channel, delivery rate, bounce/fail rate ○; **OTP delivery success & latency (login-critical)** ○; bulk campaign completion/failure ○.
- **UI engagement** (new via `IMPRESSION`/`INTERACT`) — page/section impressions, click-through, funnel-step abandonment, time-on-page (via `SUMMARY`) ○.
- **Conversation & voice** — sessions, turns, drop-off by stage, escalations, task-completed ✅; LLM tokens/latency/cost ✅.
- **Cross-DPG, trust & compliance** — cross-instance discovery, cross-network actions, A2A calls ◐; trust blocks, consent captured/declined, PII reveals, erasure requests ◐.

### 4.12 Open questions / provisional premises

- ClickHouse topology (single-node vs cluster) and ClickStack alerting parity vs retained Prometheus *(provisional; owned by SP2/SP3)*.
- Whether the insight service is standalone or folds into a broader data-pipeline service *(provisional)*.
- Exact generalisation of Signals' `status_rules`/`metric_categories` DSL into the cross-DPG derivation config *(planned, SP3)*.
- Retention tiers per stream/event class (hot ClickHouse vs cold object store) *(provisional)*.
- Telemetry PII enforcement point — ingest redaction gate vs consent-service coupling *(provisional)*.

---

## 5. Data Model

The analytics store is **ClickHouse** — columnar, not normalised. The canonical envelope (§4.2) is the wide event row; the fixed OLAP dimensions are pre-agreed so the insight service can group-by without re-parsing payloads.

### `events` (analytics event row)

| Column | Type | Description |
|---|---|---|
| `eid` | LowCardinality(String) | _event type (§4.3)_ |
| `ets` | DateTime64(3) | _event timestamp_ |
| `mid` | String | _**dedup key**; ReplacingMergeTree on `mid`_ |
| `ver` | LowCardinality(String) | _envelope version_ |
| `actor_id` / `actor_type` | String / LowCardinality | |
| `channel` | LowCardinality(String) | _**`network`** (server-stamped)_ |
| `pdata_id` / `pdata_pid` / `pdata_ver` | LowCardinality / LowCardinality / String | _producer service / instance / build_ |
| `env` | LowCardinality(String) | |
| `sid` / `did` | String | _session / device_ |
| `cdata` | Array(Tuple(type String, id String)) | _correlation; carries `trace_id`_ |
| `rollup_l1..l4` | LowCardinality(String) | _**network → domain → instance → org**; primary OLAP group-by_ |
| `object_id` / `object_type` / `object_ver` | String / LowCardinality / String | |
| `object_rollup_l1..l4` | LowCardinality(String) | _item → version → parent_ |
| `edata` | JSON / String | _per-`eid` payload_ |
| `tags` | Array(String) | |

_Partition by `toYYYYMM(ets)`; order by `(channel, eid, ets)`. Materialised views per business question (§4.11). `SUMMARY` rows stored in the same table (§4.7)._

### `derivation_config` (versioned, in the insight service — not code)

| Column | Type | Description |
|---|---|---|
| `key` | String | _derivation/metric key_ |
| `network` | String | _scope_ |
| `version` | int | _immutable per version_ |
| `spec` | JSON | _the generalised `metric_categories`/`status_rules` DSL_ |
| `active` | bool | |

> **Note:** the observability plane's schema (traces/logs/metrics) is the standard ClickStack/OTLP schema, owned by ClickStack — not modelled here.

---

## 6. API Spec

### Ingest

#### `POST /v3/telemetry`
Request:
```jsonc
{
  "id":  "telemetry.ingest",
  "ver": "3.1",
  "events": [ /* array of canonical envelopes (§4.2) */ ]
}
```
Responses: `200 { "status": "ok", "results": [ { "mid": "…", "status": "ok|duplicate|dropped" } ] }`, `4xx { error, message }`.
Validation:
- Auth: Bearer (Keycloak) or HMAC interim; `network`/`pdata`/`actor` **server-stamped**, overriding any client value (§4.9).
- Each event validated against the JSON schema for its `eid`; invalid → `dropped` (dead-letter), not a batch failure.
- Dedup on `mid`; a repeat returns `duplicate`.

### Insight service

- `GET /insight/metrics` — query derived KPIs by `network`/`rollup`/time; cross-instance and cross-network aggregation.
- `GET /insight/exhaust/:dataset` — per-tenant data exhaust (CSV/parquet).
- `GET /validate-config` — validate the derivation/KPI catalogue (admin).

### Observability

Emitted as **OTLP to the Collector**, not REST; queried via HyperDX (and transitional Prometheus/Alertmanager for alerts).

---

## 7. Summary

Telemetry becomes a common cross-DPG capability with **two planes** — OpenTelemetry for operational health, and a **Sunbird-Telemetry-v3-derived event log on the shared Kafka backbone** for business analytics — bridged by a correlation id. One **harmonised envelope** gives every DPG the three dimensions they lack today (`pdata`, `cdata`, and a `network→domain→instance→org` `rollup`), and expressing business events as `AUDIT` lets ~5 event types carry the whole story. A **TS-only SDK** unifies the TS DPGs while ai-diffusion conforms to the wire contract; a **two-door ingest** feeds a **validate → dedup → enrich** pipeline; and an **insight service** consumes the log, derives KPIs, and **retires Signals' `item_metrics`** into config-driven derivations that finally work across instances. The whole stack unifies on **ClickHouse (ClickStack + HyperDX)**, keeping Prometheus only for alerting on a retirement path, and is fully OSI-open.

Net effect: one contract instead of four incompatible telemetry stories, UI telemetry where there was none, cross-instance/network aggregation that was previously impossible, and a durable event log an intelligence service can be built on — rather than counters that throw the data away. Implementation is phased SP1–SP4 (§4.10) and depends on the Event Platform; open items are tracked in §4.12.
