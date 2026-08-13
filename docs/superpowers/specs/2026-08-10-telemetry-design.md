# Telemetry design — Signals Stack (multi-instance)

**Status:** design / not yet implemented
**Date:** 2026-08-10 · **Revised:** 2026-08-13 (format changed to OpenTelemetry)
**Brief:** `2026-08-10-telemetry-design-brief.md` — the readable overview
**Review:** `telemetry-design-reconciliation-2026-08-13.md`
**Companion plan:** `docs/superpowers/plans/2026-08-10-telemetry-implementation.md`

This is the detailed spec: the reasoning behind each decision, the code-level
emit contract, failure modes, configuration, and privacy rules. The brief covers
the same design in a fifth of the length; read that first.

---

## 1. Context and scope

Signals has no product telemetry. What it has is five unrelated, partial
substitutes:

| Existing mechanism | What it captures | Why it isn't telemetry |
|---|---|---|
| `action_events` table (`utils/action_event_runtime.ts`) | Domain-validated action results, partitioned by `(item_network, action_type)` | Only actions. Schema is per-network (`interaction.event_schema`), so it can't carry signup, consent, profile, or notification events. It is the *system of record*, not an event stream. |
| `item_metrics` (`services/metrics/`) | Per-item directional counts + derived status | A lazily-recomputed **cache** (`staleness.ts`, TTL `DASHBOARD_CACHE_TTL_SECONDS`, default 3600s, no background job). Recompute is a synchronous `UNION ALL` scan triggered by whichever request finds it stale. Explicitly "not a source of truth". |
| `publishItemEvent` (`utils/publish_item_event.ts`) | Item upsert/delete, to a Redis Stream | Exists solely to feed signals-search ingestion. Five fields, no actor, no cause, best-effort. |
| GA4 via `apps/ui/public/analytics.js` | Page views, client-side | Browser-only, spoofable, off unless `VITE_ANALYTICS_GA_ID` is set (`apps/ui/src/lib/api-config.ts:14`). Blind to everything server-side and to cross-instance flows. |
| `pino` request logs | Everything, unstructured-ish | Not addressable, not dedupable, not a consumable contract. |
| `pii_reveal_audit` table | PII reveals only | The one genuinely append-only audit surface. A good precedent — and the shape this design generalises. |

Verified: there is no `opentelemetry` dependency in any `package.json` in this
repo today. This is greenfield instrumentation.

This spec defines a single telemetry contract covering:

1. Major domain actions — apply, accept/approve, reject, cancel, profile
   created/updated, user onboarded, retired.
2. User-facing UI interactions, for funnel analysis.
3. Operational observability — latency, error rates, saturation — in the *same*
   format, not a second one.
4. Correctness under a multi-instance topology where seeker and provider live on
   different instances, and there may be many of each, **without duplicate event
   generation**.
5. An explicit answer to *what generates telemetry* (§6).

Out of scope: the analytics datastore (deliberately — §7.4), dashboard design,
and the notification service's internals.

---

## 2. Format decision

### 2.1 The two candidates, and how the requirement settles it

**OpenTelemetry** models both *what happened in the product* (Events — log
records carrying an `event.name`) and *how the system behaved* (traces with W3C
context propagation; metrics with typed instruments).

**Sunbird Telemetry v3** models product events only: a fixed envelope (`eid`,
`ets`, `ver`, `mid`, `actor`, `context`, `object`, `edata`, `tags`) over 17 event
types.

The governing requirement is **one format covering domain *and* operational use
cases.** That eliminates Sunbird v3 by construction: it has no span model and no
metric instrument model. Covering operations in it means hand-rolling latency and
saturation data into `LOG`/`METRICS` events and losing the trace waterfall —
which is precisely the cross-instance blind spot this design exists to close.

**Decision: OpenTelemetry, OTLP wire format, one SDK, three signals.**

### 2.2 Record of a reversal

An earlier revision of this spec chose the Sunbird v3 envelope for the domain
plane, with OTEL alongside for operations. That was wrong, and the reasoning is
recorded here so it isn't re-litigated:

- The argument rested on Sunbird's `mid` being a required dedup key with "no OTEL
  equivalent." **That is false.** OTEL semantic conventions define
  `log.record.uid` — "A unique identifier for the Log Record." More importantly,
  determinism of the id is a *design discipline*, not a format feature: nothing
  prevented a deterministic id in either envelope.
- The secondary argument — that OTEL pipelines are sampling-lossy — conflated
  **format** with **pipeline**. Drop-under-pressure is a property of a
  Collector's configuration, not of the OTLP data model. Durability is solved in
  §7 independently of format.
- A further consideration made the earlier choice actively worse: using 6 of 17
  `eid`s, where the unused ones are education-domain artifacts, is borrowing a
  JSON shape rather than adopting a standard — while paying the cost of a
  taxonomy that fit poorly.

An ecosystem argument (aggregator-dpg had committed to Sunbird v3, and its design
doc called it "mandated by the platform") briefly kept the earlier decision
alive. That mandate was confirmed not to apply. What remains is a real
harmonisation problem, not a format constraint — see §14.2.

### 2.3 What OTEL gives that the alternative did not

- **Producer identity stamped by the SDK** via `Resource`, not hand-filled per
  event, so it cannot be forgotten.
- **Correlation is structural.** Trace and span ids are native log-record fields
  populated from ambient context — not a self-managed correlation array.
- **Named attributes instead of positional rollups.** `source.domain` and
  `target.domain` are self-describing; `rollup.l2` is not.
- **One taxonomy.** A single `event.name` namespace replaces a fixed event-type
  enum *plus* a subsystem field *plus* a verb field.
- **Operational signals for free** — auto-instrumentation for Fastify, `pg`,
  `ioredis`, and `undici` (which covers the peer `fetch` calls).

### 2.4 Superseded — do not build

- The Sunbird v3 envelope (`eid`/`ets`/`mid`/`actor`/`context.{channel,pdata,env,sid,did,cdata,rollup}`/`object`/`edata`/`tags`).
- The `eid` enum taxonomy and per-`eid` `edata` schemas.
- `mid` as a random dedup key.
- `context.env` as a subsystem discriminator — replaced by `event.category`.
- Publishing derived rollups back onto the event stream as `METRICS` events —
  replaced by real OTEL metric instruments.

---

## 3. The event contract

### 3.1 Resource — per producer process

Attached by the SDK to every signal.

| Resource attribute | Value | Notes |
|---|---|---|
| `service.name` | `signals-api` · `signals-ui` · `aggregator-api` | **Also the trust tier discriminator** (§6.1) |
| `service.version` | build version | |
| `deployment.environment.name` | `production` · `staging` · `development` | From `INSTANCE_ENV` |
| `service.instance.id` | pod/replica id | **Process identity.** Per semconv this identifies a process; it cycles on restart and differs per replica. Operational debugging only. |
| `dpg.instance` | normalised instance base URL | **Deployment identity.** The stable DPG instance. |

**`service.instance.id` and `dpg.instance` are different things and must not be
conflated.** Grouping domain events by "which instance emitted this" on
`service.instance.id` drifts silently as pods cycle, and it will never join to
`source.instance` / `target.instance`. `dpg.instance` is the attribute to group
and join on.

`dpg.instance` is valued as the **normalised instance base URL** — the same value
`item_instance_url` and `action_events.origin_instance_domain` already carry,
normalised through `normalizeInstanceUrl` (`utils/action_event_runtime.ts:29`).
That choice means cross-instance joins need no mapping table. A short slug is
acceptable instead only if the mapping is 1:1 and stable; the URL is preferred
because the data already holds it.

### 3.2 Attribute schema — fixed, not per-scenario

**Every event uses the same defined attribute set.** A new feature reuses this
vocabulary or, rarely, uses the bounded extension slot (§3.3).

The reason is not tidiness. Attributes become columns in whatever sink consumes
the stream, so a fixed schema means one stable wide table for all events, uniform
queries across unrelated flows, no schema migration per shipped feature, and — as
§12 notes — a finite set of named slots that a privacy review can actually check.

Names are unprefixed, and align with OTEL semantic conventions where one already
exists (`session.id`, `error.type`, `http.*`).

**Core — on every event**

| Attribute | Meaning |
|---|---|
| `event.name` | Static identifier, `<area>.<verb>` (unprefixed — §3.4). Never contains ids or dynamic values. |
| `event.uid` | Deterministic dedup key from the domain natural key (§5). |
| `event.category` | `state_change` · `interaction` · `view` · `query` · `delivery` · `error` |
| `event.parent_uid` | The `event.uid` that caused this one. |
| `network` | Network id (`yellow_dot`). |
| `channel` | Origination: `in_app` · `external` · `admin` · `system` · `otp_email` · `otp_sms` |

**Actor — the principal**

| Attribute | Meaning |
|---|---|
| `actor.id` | Pseudonymised principal id (§12). |
| `actor.type` | `user` · `system` · `org` · `guardian` · `peer` |
| `actor.on_behalf_of` | Org id when acting for someone else (admin, aggregator). |
| `actor.is_minor` | Flag only, never DOB. |

**Object — the subject**

| Attribute | Meaning |
|---|---|
| `object.id` | Item id, action id, user id, route, element id. |
| `object.type` | `item` · `action` · `user` · `consent` · `notification` · `page` · `element` · `query` |
| `object.subtype` | Domain refinement: `profile_1.0`, `apply`, `terms`, `email`. |
| `object.version` | Monotonic version — action `update_count`, item `revision` (§4.4). |
| `object.owner` | Pseudonymised owner. |
| `object.org` | **Attributing organisation** of the subject. |

One `object.subtype` replaces what would otherwise be four separate fields —
`item.type`, `action.type`, `consent.category`, `notification.channel`.

**State — any transition**

| Attribute | Meaning |
|---|---|
| `state.from` / `state.to` | Either may be absent on creation. |
| `state.bucket` | `create` · `accept` · `reject` · `cancel` |
| `state.trigger` | `user_action` · `profile_consent_accepted` · `system` · `admin_upsert` |
| `state.duration_ms` | Time spent in the previous state. |

One group covers action status changes, item lifecycle, consent, and user
provisioning. `state.bucket` is the network's `metric_categories` mapping
(`services/metrics/buckets.ts` — `create|accept|reject|cancel`), which is what
lets aggregation work across networks that use different status words.

**Placement — the directional edge**

| Attribute | Meaning |
|---|---|
| `source.domain` / `target.domain` | Role in the network. |
| `source.item_type` / `target.item_type` | Schema id. |
| `source.item_id` / `target.item_id` | Item ids. |
| `source.instance` / `target.instance` | Hosting DPG instance — same value space as `dpg.instance`. |

For a single-sided event only `source.*` is set. `actor.*` describes the
principal; these describe the *items*, and the two are independent: a provider
accepting a seeker's application has `actor` = the provider user while
`source` remains the seeker side, because `source`/`target` describe the action's
original direction. That separation is what lets you ask both "who decided" and
"which way did the request flow."

**Measures, flow, fields, outcome**

| Attribute | Meaning |
|---|---|
| `metric.count` | Any cardinal count. |
| `metric.duration_ms` | Any duration. |
| `metric.score` | Any normalised score. |
| `metric.delta` | Change since the previous event. |
| `flow.name` / `flow.step` | Position in a multi-step flow. |
| `flow.outcome` | `success` · `validation_error` · `abandoned` · `blocked` |
| `fields.changed` / `fields.error` / `fields.missing` | Field **names** only. |
| `outcome` | `success` · `failure` · `skipped` · `blocked` |
| `outcome.reason` | `no_email` · `cap_exceeded` · `minor_channel_blocked` |
| `session.id` | OTEL semconv. |
| `ui.route` / `ui.element` / `ui.action` | UI surface only. |
| `error.type` / `error.message` | OTEL semconv. Machine code plus a PII-free message. |

**`metric.*` slots are intentionally overloaded** and are only meaningful when
filtered by `event.name`: on `item.created`, `metric.score` is completion
percentage and `metric.count` is populated-field count; on
`search.executed`, `metric.count` is result count. This is the accepted
cost of a fixed schema. An event needing two independent counts cannot express
both — use `attr.*` or reconsider the event.

### 3.3 Extension slot

`attr.*` is the escape hatch. **Rule: any `attr.*` key used in more than two
places is promoted into the core schema.** Without the promotion rule the hatch
becomes the sprawl it exists to prevent.

`state.trigger` is the field most likely to sprawl per feature. Treat its value
list as closed-by-default: a new trigger either justifies extending the
enumeration in this spec, or rides in `attr.*` until it earns promotion.

### 3.4 On `event.name` values

`event.name` is an unprefixed dotted `<area>.<verb>` — `action.created`,
`item.lifecycle_changed`. No product namespace, on any field.

OTEL guidance is that event names be namespaced against collision when several
producers publish into one stream, and an earlier revision carried a `signals.`
prefix for that reason. It was dropped as redundant: **`service.name` in the
`Resource` already identifies the producer on every event** (§3.1), so
`item.created` from `signals-api` is already distinguishable from any other
system's. The prefix bought nothing and appeared ~45 times in this catalogue.

If a future sink genuinely needs a namespaced key, derive it at the sink from
`service.name` + `event.name` rather than reintroducing a prefix at every emit
site.

OTLP also has a native `eventName` field on log records, but tooling support is
uneven and downstream flattening acts on *attributes*. Emit `event.name` as an
attribute so it reliably lands as a column; set the native field too where the
SDK supports it.

---

## 4. Event catalogue

### 4.1 Mapping rule

Signals already has a precise verb vocabulary; telemetry does not invent a second
one.

- **A state change of a persisted domain object** → `event.category:
  state_change`, with the verb in `event.name` and the transition in
  `state.from`/`state.to`.
- **Network-specific status strings** (`applied`, `shortlisted`) go verbatim in
  `state.to` **and** are mapped to a canonical `state.bucket`. Consumers
  aggregate on `bucket`; humans read `state.to`.
- **Never put a network's status enum in `event.name`.** `event.name` is a closed
  set changed only by this spec.

### 4.2 Catalogue

`N` marks events the notification consumer acts on (§8).

**Actions** — `object.type: action`

| `event.name` | `state.to` | `bucket` | Notify |
|---|---|---|---|
| `action.created` | network status, e.g. `applied` | `create` | **N** — `INBOUND_REQUEST` + `OUTBOUND_REQUEST` |
| `action.status_changed` | `accepted`, `shortlisted` | `accept` | **N** — `INBOUND_STATUS` + `OUTBOUND_STATUS` |
| `action.status_changed` | `rejected` | `reject` | **N** |
| `action.status_changed` | `withdrawn`, `cancelled` | `cancel` | **N** — closes today's gap: cancellations are deliberately un-emailed (`update_action_status.ts:606-608`, "Cancellation e-mails are deferred"). Telemetry records them; copy is a later consumer-side decision. |
| `action.blocked` | — | — | — (`event.category: error`, `outcome.reason: cap_exceeded` from `services/action_pair_cap.ts`, or `minor_channel_blocked` from `services/guardian_action_gate.ts`) |
| `action.contact_revealed` | — | — | Mirrors the `pii_reveal_audit` insert |

**Items** — `object.type: item`. Profiles are items (`object.subtype:
profile_1.0`), so "profile created" is not a distinct event name.

| `event.name` | Covers |
|---|---|
| `item.created` | Item and **profile** creation |
| `item.updated` | Item and **profile** update |
| `item.lifecycle_changed` | `draft → live → paused → retired`. **N** on `retired`. |
| `item.deleted` | Deletion |
| `item.geotagged` | Geotagging |

`item.lifecycle_changed` with `state.from: draft`, `state.to: live` is the
**onboarded** signal for a participant profile — the promotion that consent
acceptance triggers (#464). It is deliberately not a separate event name: a second
definition would drift from the transition the code enforces.

Account provisioning and profile-goes-live are, however, **separate events**
(`user.provisioned` vs this one). Most onboarding drop-off happens between
them, and a single "onboarded" event would hide exactly that.

**Consent** — `object.type: consent`. `object.subtype` carries
`consent_category` (`terms|privacy|profile_creation|action`); `channel` carries
`consent_record.source` (`signup|login|profile|action`).

| `event.name` | Notes |
|---|---|
| `consent.accepted` | Same transaction as the `consent_record` insert |
| `consent.action_recorded` | The consent rows written inside both perform-action paths; `state.trigger` distinguishes `initiate` / `accept` stage |
| `consent.guardian_otp_sent` / `_verified` / `_failed` | **N** on `sent` |
| `consent.guardian_batch_verified` | `attr.otp_scope` = sha256 of the sorted action tuples |

**Auth / onboarding** — `object.type: user`

| `event.name` | Notes |
|---|---|
| `user.provisioned` | **Onboarded (account).** `actor.type: system`, subject in `object.*` |
| `user.first_login` | |
| `user.dob_captured` / `user.minor_detected` | `actor.is_minor` flag only |
| `user.signup_blocked` | Self-signup gate rejection; `event.category: error` |

**Search** — `event.category: query`, `object.type: query`

Emitted from `network/item/discover.ts` and `markers.ts`. `metric.count` =
results, `metric.duration_ms` = latency, `outcome` = success/failure. The
signals-search-vs-fallback distinction rides in `attr.search_mode` until it earns
promotion — that makes the documented fallback ("falls back to a native
distance/recency path when signals-search is down") a measurable rate rather than
a log grep.

**UI** — `service.name: signals-ui`, trust tier 2

| `event.name` | `event.category` | Notes |
|---|---|---|
| `ui.page_viewed` | `view` | `object.type: page`, `object.id` = route |
| `ui.interaction` | `interaction` | `object.type: element`, `object.id` = stable element id |
| `ui.error` | `error` | Client-side failures |

`flow.name` + `flow.step` appear on both UI and server events. That shared pair is
what turns a funnel into something diagnosable: the UI shows where people
stalled, the server shows what actually committed.

**Notifications** — `object.type: notification`, `event.category: delivery`

`notification.requested` · `.sent` · `.skipped` · `.failed`, with
`outcome.reason` carrying the existing `onSkip('no_user_id' | 'no_email')` values
(`notifications/dispatcher.ts:38,54,64`). `event.parent_uid` carries the
triggering event's uid, so every email traces to the domain change that caused it,
and the skip reasons become a measurable dark-user rate.

### 4.3 Operational signals

Same SDK, other signal types. Not a second format.

**Spans.** Auto-instrumentation covers Fastify, `pg`, `ioredis`, and `undici`.
Hand-added spans where a known failure mode lives:

| Span | Why |
|---|---|
| Peer fetch in `inter_instance_fetch.ts`, attributed with peer instance and whether the aggregate was complete | `PEER_FETCH_TIMEOUT_MS` exists because one slow peer must not stall the fan-out, and only a *complete* aggregate is cached. Partial-rate is invisible today. |
| `action.forward_to_target_instance` around `perform_action.ts:306` | The cross-instance hop |
| `item_metrics` recompute | The synchronous stale-cache recompute is a latency cliff for whoever triggers it |

**Metrics.** Real instruments, reusing schema attribute names as dimensions so a
metric and an event join on `network`, `source.domain`, or `state.bucket` without
a translation table: peer-fetch duration (histogram), search requests by mode
(counter), notifications by outcome (counter), outbox depth and relay lag
(gauges), partition DDL calls (counter), Keycloak token renewal outcomes
(counter — recent incident source, #489).

**Trace propagation.** Inject and accept W3C `traceparent` on the three
peer-facing call sites (`perform_action.ts:306`,
`action_event_runtime.ts:295`, `inter_instance_fetch.ts`). One distributed apply
then becomes one trace across both instances, and because domain events carry the
ambient trace id, a business event links straight to the request waterfall.

### 4.4 Prerequisite — `items.revision`

**`items` has no monotonic column.** Verified against
`packages/database/src/drizzle_ref_tables/items.ts`: the table has
`item_network`, `item_domain`, `item_type`, `item_id`, `item_instance_url`,
`item_schema_url`, `item_state`, `item_private_state`, `item_locations`,
`created_by`, `created_at`, `updated_at`, `lifecycle_status` — and nothing
monotonic.

Consequently `object.version` has no source for items, and the item `event.uid`
(§5.1) is not derivable. `updated_at` cannot substitute: it would violate the rule
that a uid never derives from a timestamp (§5.1), and two mutations within the
same clock tick would collide.

**Required:** add `revision integer not null default 1` to `items`, incremented in
the same transaction as every mutation. That makes all six item write sites (§6.3)
load-bearing — every writer must bump it, including the backfill script — so the
migration and the instrumentation should land together.

Actions need nothing: `action_events.update_count` already exists and is already
part of a unique index (§5.2).

---

## 5. Identity, dedup, and ordering

This is the load-bearing section for multi-instance correctness. Everything else
is arrangement; this is the part that is wrong by default.

### 5.1 `event.uid` is deterministic

```
event.uid = `<prefix>:<domain natural key>`
```

Never a timestamp, never a random id, never anything derived from *which*
instance produced it:

| Event family | `event.uid` |
|---|---|
| `action.created` | `act:{action_id}:0` |
| `action.status_changed` | `act:{action_id}:{update_count}` |
| `item.*` | `itm:{item_id}:{revision}` — requires §4.4 |
| `consent.*` | `csn:{consent_record_id}` |
| `user.provisioned` | `usr:{user_id}:provisioned` |
| `notification.*` | `ntf:{parent_uid}:{shape}` — see the caveat below |
| `ui.*` | `ui:{session_id}:{sequence}` |

Also set `log.record.uid` to the same value: it is semconv's standard slot for a
log-record identifier (stability: Development). Keep `event.uid` as the field of
record so a convention change upstream costs nothing.

**Notification uid caveat.** `ntf:{parent_uid}:{shape}` collapses two cases that
are not duplicates: a genuine retry after a provider failure, and a fan-out to
several recipients of the same shape. Either extend it with an attempt counter and
a pseudonymised recipient key, or accept that notification events are
*per-shape-per-parent aggregates* rather than per-send records. This spec takes
the first option for `.sent`/`.failed` (where retries matter) and the second for
`.requested`.

### 5.2 The action uid is already validated by the schema

`action_events` carries a unique index on
`(partition_network, action_type, origin_instance_domain, action_id, update_count)`
(`packages/database/src/drizzle_ref_tables/action_events.ts:65`).

The action `event.uid` is precisely that key **minus `origin_instance_domain`** —
i.e. the key under which the authoritative row and the mirrored row collapse into
one. The dedup discipline is not a new invariant being introduced by telemetry; it
is the one the table already encodes, read one column shorter.

That index deliberately *includes* `origin_instance_domain`, which is why the
authoritative and mirrored rows coexist rather than conflicting — and it is what
makes §6.3's single-emitter rule expressible as a column comparison.

### 5.3 What determinism buys

The forward/mirror topology means two instances legitimately observe one change:

1. Seeker's UI calls the seeker instance `POST /api/v1/action/perform`.
2. The seeker instance forwards to the **target item's instance**
   (`perform_action.ts:306`). That instance is the **write authority**: it inserts
   `item_actions` + `action_events`.
3. It then calls `mirrorActionEventToSourceInstance`, POSTing to the seeker
   instance's `POST /api/v1/event/store` (`action_event_runtime.ts:283-296`),
   which inserts the seeker instance's own row.

Without a shared identity that is two telemetry events per application — so
cross-instance pairs inflate ~2× while same-instance pairs don't. **A skew that
varies with topology is worse than a constant one**, because it changes silently
as instances are added and cannot be corrected after the fact.

With a deterministic uid:

- The outbox declares `UNIQUE (event_uid)`, so a second emit is
  `ON CONFLICT DO NOTHING` — idempotent at the database level, not by convention.
- Sinks dedupe on `event.uid` regardless of arrival order or replay.
- **Retries are free.** The relay can crash mid-batch and re-publish without
  producing duplicates, giving at-least-once transport with effectively-once
  semantics at the sink.

### 5.4 Three layers, in order of importance

1. **Prevent** — the single-emitter rule (§6.3). Only the write authority emits.
2. **Identify** — deterministic `event.uid`, so any duplicate that does occur is
   provably the same event.
3. **Collapse** — idempotent sink keyed on `event.uid`.

Prevention is first because it is the only layer that costs nothing downstream.

Two properties OTEL adds for free: `dpg.instance` makes every event attributable
to its emitting deployment, and because trace context propagates across the
cross-instance hop, one apply is a single trace — so a duplicate shows up as two
events sharing a uid within one trace, which is trivially alertable.

### 5.5 Ordering

Ordering is by **monotonic version, never timestamps.** Instance clocks are
independent, and the mirrored copy is stamped separately from the authoritative
one, so `ets`-style ordering is meaningless across instances.
`object.version` — `update_count` for actions, `revision` for items — is the
ordering key and tiebreak.

Where a transport preserves per-key ordering, key it on `object.id` so an
action's `created` is always seen before its `accepted`. The notification
consumer depends on that (§8.4).

### 5.6 Validation gate

A fixed schema is only fixed if something rejects violations. Because
`object.subtype` absorbed four former fields, nothing type-checks by accident.

Required-attribute rules **per `event.name`**, enforced in two places:

- **In the emitter** — a Zod schema in `packages/schemas/src/telemetry.ts`, so a
  malformed event fails in tests and CI rather than in the warehouse.
- **At the collector/bridge** — reject or route-to-DLQ, so a producer that skips
  the SDK cannot poison the stream.

Emitter-only validation is insufficient (a future producer may not use our SDK);
bridge-only is insufficient (failures surface far from the cause). Both.

---

## 6. Source of telemetry generation

### 6.1 Trust tiers

| Tier | `service.name` | Emits | Trusted for |
|---|---|---|---|
| 1 — record | `signals-api` | Domain events, spans, metrics | Notifications, metrics of record, audit, compliance |
| 2 — behavioural | `signals-ui` | UI events, client errors | Funnel and UX analysis **only** |
| 3 — federated | `aggregator-api` | Its own surface, plus `state_change` for its own bulk-create writes | Its own reporting |

**Why the API and not the UI** — three independent reasons, each sufficient:

1. Client events are lossy and spoofable, so they cannot drive email or
   compliance.
2. The UI talks only to its home instance and is structurally blind to the
   forward/mirror hop where cross-instance state actually changes.
3. The same domain change arrives through paths with no UI at all — aggregator
   bulk create, `admin/participant.ts` upsert, and the peer-to-peer
   `/api/v1/event/store` endpoint. A UI-sourced funnel would silently omit all of
   them.

Because tiers are distinguished by `service.name`, keeping them apart downstream
is a filter rather than a convention — a spoofable count cannot be mixed into a
metric of record by accident.

### 6.2 The rule

> **The instance that owns the write is the sole producer of record-grade
> telemetry, and it emits inside the same database transaction as the write.**

Record-grade means anything feeding notifications, metrics of record, or audit.
UI events, spans, and metrics are not record-grade and emit directly (§7.3).

### 6.3 Emit sites

The earlier revision of this spec claimed "one function already handles every
action write *and* its mirror, and one already handles every item mutation." Half
of that was wrong, and the wrong half is the half that breaks the single-emitter
rule. The sites are therefore named here rather than left as "choke points."

**Actions — one function, three callers, one of them the mirror receiver.**

`insertActionEvent` (`utils/action_event_runtime.ts:121`) is genuinely the single
write path, called from exactly three places:

| Caller | Role |
|---|---|
| `routes/v1/network/action/perform_action.ts:352` | write authority |
| `routes/v1/action/update_action_status.ts:607` | write authority |
| `routes/v1/event/store_event.ts:109` | **mirror receiver** |

Instrument the function naively and the source instance emits on mirror-receive —
producing exactly the double emission §5.3 describes.

Two mechanisms already in the code make this safe without inventing anything:

- **Emit inside the existing `if (createdEvent)` guard.** `insertActionEvent` uses
  `onConflictDoNothing({ target: [...] }).returning(...)` and returns `created ??
  null`, so `createdEvent` is null on a duplicate. Emitting inside that guard
  makes retry-duplication the database's problem, for free. Note the action route
  already guards its notification dispatch this way.
- **The single-emitter rule is a column comparison, not a convention.**
  `origin_instance_domain` is set to `getCurrentApiBaseUrl()` at both authority
  sites (`perform_action.ts:338`, `update_action_status.ts:578`), and carries the
  *originating* (remote) instance on the mirror-receive path. So the rule is:

  ```
  emit only when normalizeInstanceUrl(origin_instance_domain)
              === normalizeInstanceUrl(getCurrentApiBaseUrl())
  ```

  That is one expression at one site, rather than a standing agreement about
  which routes not to instrument — which is the kind of agreement that survives
  exactly until the next contributor.

**Items — six write sites, and lifecycle bypasses the service layer.**

| Site | Note |
|---|---|
| `services/item_service.ts:345` | create |
| `services/item_service.ts:518` | update |
| `services/item_service.ts:748` | update |
| `routes/v1/item/lifecycle.ts:161` | writes `items` directly, bypassing `item_service` |
| `routes/v1/item/lifecycle.ts:215` | same — and this is the path behind `item.lifecycle_changed`, the marquee onboarding event |
| `scripts/backfill_lifecycle.ts:144` | backfill script |

All runtime paths already run inside a transaction, so "emit in the same
transaction as the write" needs no restructuring. But item instrumentation is six
sites, not one — and each is also where the §4.4 `revision` bump must happen, so
the two changes land together or neither works.

Other emit sites, each single: `services/auth/provisioning.ts:467` (onboarding),
the `consent_record` insert sites, `discover.ts` / `markers.ts` (search),
`guardian_action_gate.ts` and `action_pair_cap.ts` (blocked actions),
`get_action_contact_details.ts` (PII reveal).

### 6.4 Resolving `object.org`

`object.org` is the **attributing** organisation of the subject — not
`actor.on_behalf_of`, which is the org *acting*. Conflating them silently breaks
every per-aggregator number.

In Signals it is the item owner's `user.onboarded_by_org_id`. This is not
hypothetical: `services/metrics/recompute.ts:131,254` scopes every dashboard tile
in production by `(onboarded_by_org_id, domain)`, joining `items` → `user`.

The distinction, concretely: a seeker onboarded by aggregator A who performs their
own apply has an empty `actor.on_behalf_of`, because nobody is acting for them —
but the metric still belongs to A.

Without `object.org` no per-aggregator metric can be derived from the stream, so
the parity gate guarding stream-maintained `item_metrics` (§9.2) could never be
passed. Resolution needs the owner→org lookup available at emit time on the item
and action paths; on the action path both sides' owners are already loaded for the
notification payload, so the additional cost is one join, not one query per event.

### 6.5 What must not be a source

- **`item_metrics`.** A cache with a 1-hour TTL and no background job. Reading it
  to emit telemetry would publish stale derived numbers as if they were events.
  Telemetry flows *toward* metrics, never back (§9).
- **`pino` logs.** No log-scraping producer.
- **The UI**, for anything notifiable or countable-of-record (§6.1).

---

## 7. Transport

### 7.1 The boundary is OTLP

Producers speak **OTLP and nothing else**. What happens after that is deployment
configuration, not producer code.

```
signals-api  ─┐                            ┌─▶ raw topic          (replay, audit)
signals-ui   ─┼─ OTLP ──▶ OTLP→Kafka ──────┤
aggregator   ─┘           bridge           └─▶ transformed topic  (analytics)
```

The bridge — the OTEL Collector's Kafka exporter, or an equivalent service —
publishes two topics:

- **Raw topic:** OTLP payloads verbatim. Kept for replay and audit, so a
  downstream schema mistake is always recoverable.
- **Transformed topic:** attribute arrays flattened to flat maps, resource and
  scope fields promoted to top level. This is what analytics consumes.

Where the transport preserves per-key ordering, key on `object.id` (§5.5).

### 7.2 Datastore independence

Nothing above the topics is part of this design. Any warehouse or OLAP store can
consume the transformed topic; swapping one for another changes no producer code
and no event schema. The fixed attribute schema is what makes that portability
real — flat, stable names map onto whatever table shape a sink prefers.

### 7.3 The durable lane

Emitting OTLP over the network is best-effort: if the bridge is unavailable, those
events are gone. That is acceptable for UI events, spans, and metrics. It is not
acceptable for record-grade events, because §8 makes them the notification
trigger — a lost event is a lost email.

So record-grade events are written to a local outbox **in the same transaction as
the domain write**, and relayed from there:

```
BEGIN
  -- existing domain write (item_actions, action_events, consent_record, items…)
  INSERT INTO telemetry_outbox (event_uid, event_name, envelope, …)
    ON CONFLICT (event_uid) DO NOTHING
COMMIT
        ↓  (relay, out of band)
      OTLP ──▶ bridge ──▶ topics
```

`telemetry_outbox` — **not** partitioned; it is a transient queue, unlike the item
tables:

| Column | Notes |
|---|---|
| `event_uid` text PK | Deterministic (§5.1). Idempotency for free. |
| `event_name`, `event_category` | Cheap relay-side filtering without parsing JSON |
| `envelope` jsonb | The OTLP log record |
| `object_id` text | Ordering key |
| `created_at`, `published_at` (null), `attempts`, `last_error` | Relay bookkeeping |

Index: partial on `(published_at, created_at) WHERE published_at IS NULL`, so the
relay scan stays bounded regardless of table history.

**The relay** is a loop inside `apps/api`, not a new deployable: claim a batch with
`FOR UPDATE SKIP LOCKED`, emit, stamp `published_at`. `SKIP LOCKED` lets multiple
API replicas relay concurrently without coordination. Published rows are deleted
after `TELEMETRY_OUTBOX_RETENTION_HOURS`.

Guarantees, stated plainly:

- **Domain write commits ⇒ the event will be published.** No crash window.
- **At-least-once publish, effectively-once consume**, via `UNIQUE (event_uid)` at
  the outbox and `event.uid` dedup at every sink.
- **Bridge or Kafka down ⇒ writes still succeed**; events queue in Postgres and
  drain on recovery. Strictly stronger than today, where a notification-service
  outage silently loses the email (`dispatcher.ts:105-112` logs and swallows).

### 7.4 Rejected: Redis Streams

`publishItemEvent` uses `redis.xadd` with `MAXLEN ~` trimming and a reconciliation
sweep as backstop (`publish_item_event.ts:21-39`), and it is right for its job:
signals-search ingestion is idempotent, loss-tolerant, and single-consumer.
Telemetry is none of those. Per-instance Redis gives no cross-instance fan-in,
`MAXLEN ~` means silent bounded loss, and consumer groups don't provide the
independent replayable offsets that adding a sink later requires.

---

## 8. Notifications as a telemetry consumer

### 8.1 What changes

Today the request path does the work: `void dispatchActionNotifications(...)` from
`network/action/perform_action.ts:358` and `update_action_status.ts:614`, plus
`dispatchRetireCancelNotifications` at `item/lifecycle.ts:287` and
`sendWelcomeNotifications` at `provisioning.ts:467` and
`routes/auth/create_auth.ts:60`.

The existing code is already shaped for this move, which is why the cutover is
cheap:

- `buildNotifications` is **pure** — `NotificationEvent → NotificationPlan[]` —
  and stays byte-identical. Its own header says the locality check exists "so that
  the Phase-2 cross-instance trigger site can reuse this unchanged"
  (`build_notifications.ts:66-68`).
- `createDirectDispatcher` takes **injected deps** (`notify`, `resolveEmail`,
  `resolveCounterpartyName`, `brand`, `log`, `onSkip`) precisely so it is
  transport-agnostic (`dispatcher.ts:20-39`). Its header: *"The Phase-2 transport
  (Kafka/registry) swaps in behind this same interface."*

The consumer is: message → validate → filter to notifiable
`(event.name, state.bucket)` per network config → map to `NotificationEvent` →
`buildNotifications` → existing dispatcher → NS `/notify`. All rendering
(`render_action_email.ts`, `action_copy.ts`, `brand.ts`) is untouched.

Deleted: the five in-route dispatch call sites. Nothing else.

### 8.2 One event, many notifiers

Notifications are the deliberate exception to "only the write authority emits."
`buildNotifications` returns one plan per owner side **hosted on the current
instance**, so each instance emails only its own users. That design stays — it just
moves to the consumer.

So: the event is produced **once** and consumed by **every** instance's
notification consumer, each filtering to the owners it hosts. No telemetry
mirroring between instances is required; the shared stream is what
`mirrorActionEventToSourceInstance` was hand-rolling.

### 8.3 What this fixes

| Bug today | Why | After |
|---|---|---|
| **`POST /api/v1/action/perform` never notifies.** It forwards to the target instance and dispatches nothing locally; only the *network* route and `update_action_status` dispatch. | The notify seam was added to the network route only. | The trigger no longer depends on which HTTP entry point was used. |
| A crash between commit and dispatch loses the email silently. | `void`-ed fire-and-forget after the txn. | Outbox row commits with the write. |
| NS outage loses the email. | `dispatcher.ts:105-112` catches and logs. | Offset not advanced; retry, then DLQ. |
| Cancellations are silently un-notified. | Deferred deliberately (`update_action_status.ts:606`). | Event exists; enabling copy is consumer-side config. |
| No record of what was sent. | Only pino logs. | `notification.*` events close the loop. |

### 8.4 Idempotency and ordering

Three layers, all cheap, all kept: the plan-level `dedupe_id` the dispatcher
already sends (`${actionId}:${updateCount}:${shape}`, `dispatcher.ts:88`) which
the notification service dedupes on; a `notification_sent (event_uid, shape,
recipient)` primary key at the consumer so a duplicate never reaches NS; and
`event.uid` dedup at the sink.

Ordering by `object.id` key (§5.5) is what makes "never send an acceptance email
for an action whose creation the consumer hasn't seen" structurally true rather
than probabilistic.

### 8.5 The one real risk

**Both dispatchers live at once ⇒ doubled email.** Prevented only by cutover
discipline: the five in-route call sites are deleted in the **same commit** that
flips `NOTIFICATION_CONSUMER_ENABLED=true`. There is never a state where both
paths are live. This is the riskiest step in the rollout and the plan gates it
accordingly.

---

## 9. Metrics

Telemetry flows one way: events → derived metrics. Never the reverse (§6.5).

### 9.1 What becomes answerable

Because every event carries both placement blocks and a canonical `state.bucket`,
most of these are a group-by rather than a join:

- **Funnel per network and domain:** `user.provisioned` →
  `item.created` → `item.lifecycle_changed{to:live}` →
  `action.created` → `action.status_changed{bucket:accept}`.
  `flow.name`/`flow.step` join the UI and server sides, so you see where people
  stalled *and* what committed.
- **Per-aggregator, matching today's dashboard:** group by
  `(object.org, source.domain)` — the stream equivalent of
  `recompute.ts`'s `(onboarded_by_org_id, domain)`.
- **Directional per item:** initiated when the item is `source.item_id`, received
  when it is `target.item_id` — the same directionality rule `recompute.ts`
  implements. The self-domain case it handles specially (source domain == target
  domain, emitting both an initiated and a received row) is visible as
  `source.domain === target.domain`, and the consumer applies the same doubling
  rule.
- **Cross-instance edges:** events where `source.instance ≠ target.instance`,
  grouped by emitting `dpg.instance`. Currently unanswerable from any single
  database.
- **Time-to-decision and time-in-state**, from `state.duration_ms` and from `ets`
  deltas within one `object.id`.
- **Profile completion behaviour** — `metric.score` over time, and which fields
  are most often blank, from `fields.changed` / `fields.missing`.
- **Consent conversion** — `consent.accepted{profile_creation}` through to
  the resulting `lifecycle_changed{to:live}`, joined on `event.parent_uid`.
- **Notification health** — `outcome` / `outcome.reason` give sent, skipped, and
  failed, turning the `no_user_id` / `no_email` skips into a dark-user rate.
- **Search health** — fallback rate and latency.
- **U18 gate** — `action.blocked` rate by `channel`, confirming the API
  gate rather than the UI is doing the blocking.
- **OTP delivery success and latency** — login-critical, and currently invisible.

### 9.2 Relationship to `item_metrics`

`item_metrics` **stays** as the aggregator dashboard's read model. This design does
not rewrite it, and v1 does not touch it.

A metrics projector consuming the stream *could* maintain it incrementally, which
would remove the current pathology — a synchronous, blocking, whole-domain
`UNION ALL` recompute triggered by whichever request finds the 1-hour cache stale.
That is a follow-on, and it is **gated twice**:

1. **Blocked until `object.org` lands** (§6.4). Without subject attribution the
   projector cannot reproduce a single dashboard tile, so parity cannot even be
   measured.
2. **Gated on a parity test** — projector output must equal a full
   `recompute_aggregator_domain_metrics` run for every domain in a staging
   dataset, including the self-domain doubling rule.

Betting a live dashboard on an unbuilt pipeline is how this subsystem would break;
the gates exist to make that impossible rather than unlikely.

### 9.3 Derived metrics as configuration, later

`metric_categories` and `status_rules` in `network.json` are already a
config-driven derivation DSL over action events. Generalising that DSL into stream
derivations is what eventually makes metrics cross-instance rather than
per-instance. It stays on the roadmap; it is not v1, and it should not be
mistaken for a prerequisite.

---

## 10. Multi-instance topology

### 10.1 The shape being designed for

One network (`yellow_dot`), N instances, each serving one or more domains via
`SERVED_DOMAINS` — e.g. a seeker instance and two provider instances. An item
lives on exactly one instance (`item_instance_url`). An action spans two items and
therefore up to two instances. A single apply is a **distributed** event, and no
instance sees the whole picture from its own database.

### 10.2 Trust boundary

Instances of the same network are already cooperatively deployed with shared
secret material: `INSTANCE_SHARED_SECRET` is documented as *"MUST be identical
across every instance of a network (shared HMAC material). Distributed via
SOPS."* A shared telemetry substrate per network therefore sits inside an existing
trust boundary and introduces no new one.

Out of scope: telemetry across *different* networks. Cross-network aggregation
stays at the API layer, consistent with the existing inter-instance read model.
Producer ACLs are per-network — a consumer of `yellow_dot` telemetry must not read
`blue_dot`'s.

### 10.3 Per-instance responsibilities

| Concern | Owner |
|---|---|
| Emitting a domain event | The write-authority instance, once (§6.3) |
| Notifying a user | Every instance, filtered to owners it hosts (§8.2) |
| Consumer offsets | Per instance |
| Network-wide aggregation | A single collector per network |

An instance that joins later replays from retained history and back-fills —
impossible with the current mirror.

### 10.4 The mirror this supersedes

`mirrorActionEventToSourceInstance` is an ad-hoc, single-hop, best-effort,
at-most-once event bus in ~45 lines (`action_event_runtime.ts:283-327`). Once
telemetry carries action events, the source instance learns about them by
consuming the stream — with retained offsets, replay, and no dependence on the
target instance reaching it at that instant.

> **Verified defect this exposes.** The mirror is very likely failing in every
> production deployment today. `mirrorActionEventToSourceInstance` POSTs to the
> peer's `/api/v1/event/store` sending **only** `content-type`
> (`action_event_runtime.ts:295-304`) — no session, no `x-api-key`, no peer HMAC
> (`INSTANCE_TOKEN_HEADER`). But `store_event` is guarded by
> `auth_middleware_if_enabled` (`store_event.ts:36`), and `middleware_enabled` is
> **forced `true`** whenever `INSTANCE_ENV === 'production'`
> (`apps/api/src/config.ts:54-59`; `AUTH_MIDDLEWARE_ENABLED` defaults to `true`
> anyway). So the mirror gets a 401, caught and logged as best-effort, never
> surfacing (`:306-316`). Net effect: **the source instance never receives
> mirrored action events in production**, so a seeker instance's `action_events`
> — and every metric derived from it — is missing all cross-instance actions.
>
> `store_event` also uses user/apikey auth rather than `peer_instance_guard`,
> unlike the other peer routes; it is a peer endpoint wearing user-auth clothing.
> This needs its own issue independent of telemetry: either send peer HMAC headers
> and switch the route to `peer_instance_guard`, or retire the endpoint once the
> stream carries the events.
>
> **Telemetry must not depend on the outcome, and must not be the excuse for
> leaving it broken.** Retiring the mirror is a late phase, gated on parity — and
> parity cannot be measured against a mirror that delivers nothing, which is why
> fixing it comes first in the plan.

---

## 11. Two data models inside one format

One format does not mean one model. The three signals have genuinely different
shapes, and retention, sampling, and access rules should differ accordingly —
without needing a second format to express that.

| | Domain events | Operational signals |
|---|---|---|
| Cardinality | High — per entity, per user | Low — pre-aggregated |
| Access pattern | Replay, point lookup by `object.id`, funnel scans | Time-window aggregate, alerting |
| Sampling | **Never.** Every event is a record. | Expected and fine |
| Retention | Long, subject to §12 erasure | Short |
| Consumers | Notifications, metrics of record, audit | Dashboards, on-call |
| Contains pseudonymous subject data | Yes | No |

Two consequences worth stating explicitly, because they are easy to lose once
everything is "just OTLP":

- **Sampling must never be applied to domain events.** A globally-tuned sampler
  that quietly covers the record-grade stream would silently corrupt metrics of
  record and drop notifications. Keep the domain-event path out of any sampling
  policy, and out of any Collector processor that drops under pressure.
- **Access control differs.** Operational signals can be broadly readable;
  domain events carry pseudonymous subject data and should not be.

---

## 12. Privacy and PII

The repo's posture is strict — retire scrubs PII, private locations are jittered
before storage, private item fields are dropped from search server-side.
Telemetry must not become the leak.

| Rule | Detail |
|---|---|
| **No PII in attributes, ever** | No email, phone, name, DOB, address, or free-text remarks. `action_events.event_payload` may carry a `remark`; it is **excluded**, not copied. |
| **`actor.id` / `object.owner` are pseudonymised** | HMAC-SHA256 of the user id keyed with the existing `SIGNALS_PII_KEY`, truncated. Stable (joinable across events), non-reversible. Reusing that key follows the precedent set by location jitter (`services/geocoding/jitter.ts`), which reuses it rather than adding one. |
| **Field names yes, values no** | `fields.changed` / `fields.error` / `fields.missing` are what make form analytics possible without PII. |
| **No coordinates** | Never lat/long, jittered or not. Coarse geohash (≤5 chars) only where geography is genuinely needed. |
| **No search text** | Free-text `q` can contain a person's name. Emit length, token count, and a salted hash; raw `q` only under `TELEMETRY_CAPTURE_SEARCH_QUERY`, which stays off. |
| **Facets are allow-listed** | Only declared, non-private `item_state` fields — reuse the same server-side allow-list `discover`/`markers` already apply, so telemetry cannot enumerate a field the API refuses to expose. |
| **Minors** | `actor.is_minor` flag only. Guardian OTP events carry the OTP *scope hash*, never the OTP or the contact. |
| **Spans are not a loophole** | The same rules apply to span attributes and to `error.message`. |
| **Erasure** | A `user.erasure_requested` event triggers deletion of that `actor.id`'s telemetry at the sink. Because `actor.id` is a keyed pseudonym, erasure is a single-key delete. Topic retention bounds the in-flight window. |

The fixed schema is itself a privacy control: with no free-form per-feature fields,
a leak has to pass through a named slot that review can check, rather than
arriving in an attribute nobody was watching.

Telemetry is **not** a substitute for `consent_record` or `pii_reveal_audit`.
Those remain the legal/compliance records of truth; telemetry mirrors them for
analysis.

---

## 13. Configuration

Per `.claude/rules/env-vars.md`, every new var goes in **both**
`packages/config/src/secrets.ts` and `turbo.json`'s `globalPassThroughEnv`.

New `TelemetrySecretsSchema`:

| Var | Default | Notes |
|---|---|---|
| `TELEMETRY_ENABLED` | `false` | Master switch. Off ⇒ emitters are no-ops, zero overhead. |
| `TELEMETRY_OUTBOX_RELAY_INTERVAL_MS` | `1000` | |
| `TELEMETRY_OUTBOX_BATCH_SIZE` | `500` | |
| `TELEMETRY_OUTBOX_RETENTION_HOURS` | `72` | Published rows deleted after this |
| `TELEMETRY_CAPTURE_SEARCH_QUERY` | `false` | §12. Must stay off by default. |
| `NOTIFICATION_CONSUMER_ENABLED` | `false` | The §8.5 cutover gate. **Never true while the in-route dispatchers exist.** |

Standard OTEL vars, read by the SDK itself rather than by our config layer:
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`,
`OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`. Note §11: no sampler setting may
be allowed to affect the domain-event path.

UI: `VITE_TELEMETRY_ENABLED`, `VITE_TELEMETRY_ENDPOINT`, following the existing
runtime-`config.js` pattern (`apps/ui/src/lib/api-config.ts`) rather than
build-time env.

**Deliberately not new env vars:**

- `dpg.instance` is **derived**, not configured — `normalizeInstanceUrl(getCurrentApiBaseUrl())`.
  Adding a separate identity var would create a second source of truth that could
  disagree with `item_instance_url`, which is exactly the drift §3.1 exists to
  prevent.
- `service.name` comes from the app, not config.
- Pseudonymisation reuses the existing `SIGNALS_PII_KEY`.

Network-level config (`network.json`, validated in `packages/schemas`): which
statuses are notifiable per interaction. That is what keeps the notification
consumer generic instead of hardcoding `accepted`/`rejected`.

---

## 14. Failure modes and open questions

### 14.1 Failure modes

| Failure | Behaviour |
|---|---|
| Bridge/Kafka unreachable | Domain writes unaffected; outbox grows; relay retries; drains on recovery. Alert on outbox depth. |
| Relay stalled | Alert on **age of the oldest unpublished row**, not depth alone — a slow trickle keeps depth low while lag grows. |
| Outbox growth | Bounded by the retention sweep and the partial index. Monitor. |
| Consumer lag | Emails delayed, not lost. Alert per consumer group. |
| Poison event | 3 attempts → DLQ with the original `event.uid` and error. Never blocks a partition. |
| Duplicate delivery | `event.uid` at the sink, `notification_sent` PK at the consumer, `dedupe_id` at NS. Three layers. |
| Both notification paths live | **Doubled email.** Prevented only by §8.5 cutover discipline. |
| Clock skew across instances | `ets` is not used for ordering (§5.5). |
| Schema violation | Rejected in the emitter by Zod, and again at the bridge (§5.6). |
| Telemetry emit fails inside the txn | It is an `INSERT` in the same txn, so it fails the domain write. Deliberate for record-grade events: a committed application with no possibility of notification is worse than a failed, retryable request. Non-record-grade events bypass the outbox and never affect a write. |
| Item `revision` not bumped at some write site | That item's events collide on `event.uid` and get silently deduped as duplicates. This is why §4.4 and §6.3 must land together, and why the migration needs a test per write site. |

### 14.2 Open questions

1. **Browser OTEL immaturity.** Client instrumentation is experimental and the JS
   logs SDK is still an experimental package. Wrap it behind a thin internal
   emitter so the SDK can be swapped without touching call sites. Does GA4 stay
   during the transition?
2. **`items.revision` mechanism** — what increments it, and does
   `backfill_lifecycle.ts` bump it too? A migration decision that gates every item
   event (§4.4).
3. **`object.org` resolution cost** on paths where the owner isn't already loaded.
4. **`store_event` auth** — fix by sending peer HMAC and switching to
   `peer_instance_guard`, or retire the endpoint once the stream carries events?
   Independent of telemetry; needs its own issue (§10.4).
5. **Stream-maintained vs pre-warmed `item_metrics`** — parity test first, and
   blocked until `object.org` lands (§9.2).
6. **Do aggregator bulk-create writes set `actor.on_behalf_of`?** Cross-repo
   contract. Resolve together with `object.org`, since the two org fields are the
   easiest thing here to conflate.
7. **Cross-DPG harmonisation.** `aggregator-dpg` has a merged telemetry design
   with its own envelope and SDK, and an **open, unmerged implementation PR**.
   `ai-diffusion-dpg` has a mature Python OTel layer with its own conventions.
   Either those are re-pointed at this contract, or the platform runs two or three
   OTel dialects. **This decision expires** — it gets more expensive the longer the
   aggregator PR sits.
8. **Trust-tier separation downstream** — filter on `service.name`, or separate
   topics? A filter works; separate topics make it structural.
9. **Where validation runs** — emitter, bridge, or both. This spec says both
   (§5.6); confirm the bridge can enforce it in the chosen deployment.
10. **Do `signals-search` and `notification-service` become producers?** Some
    outcomes this spec catalogues are only observable inside them: delivery,
    bounce, and provider latency are known to notification-service, and
    `signals-search` owns its own query path. Until they emit, those events
    describe what the emitter cannot fully observe.

---

## 15. Summary of the recommendation

1. **OpenTelemetry as the single format** — OTLP, one SDK, three signals. The
   requirement for one format across domain *and* operational use cases rules out
   Sunbird v3, which has no span or metric model. §2.2 records why the earlier
   Sunbird decision was reversed.
2. **One fixed attribute schema** for every event, with `attr.*` as the only
   extension point and a promotion-after-two-uses rule. Validated in the emitter
   and at the bridge.
3. **Deterministic `event.uid`** from the domain natural key — the discipline that
   makes multi-instance correct. Prevent duplication at the emitter, identify it by
   uid, collapse it at the sink. For actions this is already the shape of an
   existing unique index (§5.2).
4. **Only the write authority emits**, expressed as an `origin_instance_domain`
   comparison rather than a convention about which routes to avoid instrumenting.
5. **The API is the only record-grade source.** Never the UI, never `item_metrics`.
   Deployment identity is `dpg.instance`, not `service.instance.id`.
6. **Record-grade events commit with the domain write** via a local outbox, so a
   notification can never be lost; everything else emits best-effort.
7. **Notifications become a consumer**, reusing the already-pure
   `buildNotifications` and already-injectable `createDirectDispatcher`
   unchanged — fixing five live gaps (§8.3).
8. **OTLP is the boundary; the analytics datastore is not part of this design.**
9. **Two prerequisites before item events ship:** the `items.revision` migration
   (§4.4) and `object.org` resolution (§6.4).
