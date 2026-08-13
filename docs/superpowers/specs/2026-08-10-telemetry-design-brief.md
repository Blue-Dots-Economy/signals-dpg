# Telemetry design — brief

**Date:** 2026-08-10 (revised 2026-08-12 — format changed to OpenTelemetry)
**Full spec:** `2026-08-10-telemetry-design.md` *(still describes the superseded
Sunbird v3 approach; being updated)*

What telemetry we generate, what each event carries, and how it stays correct
when seeker and provider live on different instances.

---

## Why

Signals has no product telemetry. It has four partial substitutes, none of which
can answer "how many people applied, and were they told?":

- **`action_events`** — the system of record for actions, but actions only, with
  a per-network schema. Can't carry signup, consent, or profile events.
- **`item_metrics`** — a derived cache with a 1-hour TTL, recomputed
  synchronously by whichever request finds it stale. Explicitly not a source of
  truth.
- **GA4 in the browser** — page views only, off by default, blind to everything
  server-side.
- **Request logs** — not addressable, not dedupable, not a contract.

## Format: OpenTelemetry, one format for both planes

Two candidates were evaluated: **OpenTelemetry** and **Sunbird Telemetry v3**.

The requirement for a *single* format covering domain **and** operational use
cases decides it. Sunbird v3 has no span model and no metric instrument model —
covering operations in it means hand-rolling latency and saturation data into
`LOG`/`METRICS` events and losing the trace waterfall, which is precisely the
cross-instance blind spot we're trying to close. OTEL covers domain events
natively through **Events** (a log record carrying an `event.name`).

So: **OpenTelemetry, OTLP wire format, one SDK.** Sunbird v3 was a reasonable
candidate for the domain plane alone — it is not a candidate for both.

What we gain over the alternative, concretely:

- **Producer identity is stamped by the SDK,** not hand-filled per event
  (`service.name`, `service.instance.id`, `service.version`).
- **Correlation is structural.** Trace and span ids are native log-record fields
  populated from context — not a self-managed correlation array.
- **Named attributes instead of positional rollups.** `signals.actor.domain` and
  `signals.object.domain` say what they are; `rollup.l2` does not.
- **One taxonomy, not two.** A single `event.name` namespace replaces a fixed
  event-type enum plus a subsystem field plus a verb field.

### The three signals

| Signal | Carries | Trusted for |
|---|---|---|
| **Events** (log records with `event.name`) | Domain state changes and UI actions | Notifications, metrics of record, audit |
| **Traces** (spans) | Request flow, propagated across instances | Latency, cross-instance correlation |
| **Metrics** (counters/histograms) | Operational and derived business counters | Dashboards, alerting |

All three share one `Resource`, so instance identity and environment are
attached uniformly and can't be forgotten per-event.

---

## Naming conventions

**`event.name` is a static, dotted namespace we own** — `signals.<area>.<verb>`.
It must never contain dynamic values (no ids, no element names, no network
status strings). Those go in attributes.

**Attributes are flat and prefixed `signals.*`.** This matters practically: the
ingestion service flattens OTLP attribute arrays into flat maps, so each
attribute becomes a column downstream. Flat, stable names are what make the
dataset queryable.

**Directionality uses two attribute sets**, not a positional hierarchy:

- `signals.actor.{network,domain,item_type,item_id}` — where the actor stood
- `signals.object.{network,domain,item_type,item_id}` — the subject

For a seeker applying to a provider's job these differ, and that difference *is*
the seeker→provider edge. Every directional metric is derivable from the event
alone.

**One practical note:** OTLP has a native `eventName` field on log records, but
tooling support is uneven, and our ingestion path flattens *attributes*. Emit
`event.name` as an attribute so it reliably lands as a column; set the native
field too where the SDK supports it.

---

## Example events

One event shown in full OTLP JSON for accuracy; the rest in the flattened form
the ingestion service produces, which is both easier to read and what you'll
actually query.

### 1. Full OTLP shape — cross-instance action status change

A provider shortlists a seeker's application. The provider's instance owns the
write, so it is the only emitter.

```jsonc
{
  "resourceLogs": [{
    "resource": { "attributes": [
      { "key": "service.name",        "value": { "stringValue": "signals-api" } },
      { "key": "service.instance.id", "value": { "stringValue": "in-blr-provider-1" } },
      { "key": "service.version",     "value": { "stringValue": "1.14.0" } },
      { "key": "deployment.environment.name", "value": { "stringValue": "production" } }
    ]},
    "scopeLogs": [{
      "scope": { "name": "signals.domain", "version": "1.0.0" },
      "logRecords": [{
        "timeUnixNano":         "1786665600123000000",
        "observedTimeUnixNano": "1786665600123000000",
        "severityNumber": 9, "severityText": "INFO",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",   // spans the cross-instance hop
        "spanId":  "00f067aa0ba902b7",
        "attributes": [
          { "key": "event.name",        "value": { "stringValue": "signals.action.status_changed" } },
          { "key": "signals.event.uid", "value": { "stringValue": "act:9f2c…:3" } },  // deterministic
          { "key": "signals.actor.id",  "value": { "stringValue": "px_7d41a9…" } },   // pseudonym
          { "key": "signals.actor.type","value": { "stringValue": "user" } },

          { "key": "signals.action.id",         "value": { "stringValue": "9f2c…" } },
          { "key": "signals.action.type",       "value": { "stringValue": "apply" } },
          { "key": "signals.action.from_state", "value": { "stringValue": "applied" } },
          { "key": "signals.action.to_state",   "value": { "stringValue": "shortlisted" } },
          { "key": "signals.action.bucket",     "value": { "stringValue": "accept" } },
          { "key": "signals.action.update_count","value": { "intValue": "3" } },
          { "key": "signals.action.channel",    "value": { "stringValue": "in_app" } },

          { "key": "signals.actor.network",   "value": { "stringValue": "yellow_dot" } },
          { "key": "signals.actor.domain",    "value": { "stringValue": "provider" } },
          { "key": "signals.actor.item_type", "value": { "stringValue": "job_1.0" } },
          { "key": "signals.actor.item_id",   "value": { "stringValue": "c88a…" } },
          { "key": "signals.object.network",  "value": { "stringValue": "yellow_dot" } },
          { "key": "signals.object.domain",   "value": { "stringValue": "seeker" } },
          { "key": "signals.object.item_type","value": { "stringValue": "profile_1.0" } },
          { "key": "signals.object.item_id",  "value": { "stringValue": "b71e…" } },
          { "key": "signals.object.instance", "value": { "stringValue": "in-blr-seeker-1" } }
        ]
      }]
    }]
  }]
}
```

`signals.object.instance` differing from `service.instance.id` is what makes this
event visibly cross-instance — the single most useful thing no current query can
tell you.

### 2. User creation

```jsonc
// event.name: signals.user.provisioned
{
  "service.name": "signals-api", "service.instance.id": "in-blr-seeker-1",
  "signals.event.uid":   "usr:8d3f…:provisioned",
  "signals.actor.id":    "px_7d41a9…", "signals.actor.type": "system",
  "signals.user.id":     "px_7d41a9…",
  "signals.user.channel":"otp_email",       // how they arrived
  "signals.user.self_signup": true,
  "signals.user.is_minor":    false,        // flag only — never DOB
  "signals.actor.network":    "yellow_dot",
  "signals.actor.domain":     "seeker"
}
```

`actor.type: system` because provisioning is performed *by* the platform, with
`signals.user.id` naming the subject. When an admin onboards a participant,
`actor.type` is `user` and `signals.on_behalf_of.org_id` is set.

### 3. Profile creation

Profiles are items here (`item_type: profile_1.0`), so this is an item event with
an attribute — not a separate event type.

```jsonc
// event.name: signals.item.created
{
  "service.instance.id": "in-blr-seeker-1",
  "signals.event.uid":   "itm:b71e…:1",
  "signals.actor.id":    "px_7d41a9…", "signals.actor.type": "user",
  "signals.item.id":     "b71e…",
  "signals.item.type":   "profile_1.0",
  "signals.item.network":"yellow_dot",
  "signals.item.domain": "seeker",
  "signals.item.lifecycle_state": "draft",
  "signals.item.revision":        1,
  "signals.item.completion_pct":  40,       // derived, non-PII
  "signals.item.field_count":     7
}
```

### 4. Profile update

```jsonc
// event.name: signals.item.updated
{
  "signals.event.uid":  "itm:b71e…:2",
  "signals.item.id":    "b71e…", "signals.item.type": "profile_1.0",
  "signals.item.revision": 2,
  "signals.item.changed_fields": ["skills", "location"],  // names only, never values
  "signals.item.completion_pct": 75,
  "signals.item.completion_delta": 35
}
```

**`changed_fields` carries field names, never values** — that's what makes
"which fields do people leave blank" answerable without touching PII.

### 5. Onboarding — the profile goes live

"Onboarded" is not its own event. It's the lifecycle promotion that consent
acceptance triggers. Keeping it as a lifecycle change means telemetry can't drift
from the transition the code actually enforces.

```jsonc
// event.name: signals.item.lifecycle_changed
{
  "signals.event.uid":  "itm:b71e…:3",
  "signals.item.id":    "b71e…", "signals.item.type": "profile_1.0",
  "signals.item.from_state": "draft",
  "signals.item.to_state":   "live",
  "signals.item.revision":   3,
  "signals.item.trigger":    "profile_consent_accepted",
  "signals.item.time_in_previous_state_ms": 864000000
}
```

Account creation (#2) and going live (#5) are deliberately separate events. Most
onboarding drop-off happens *between* them, and a single "onboarded" event would
hide exactly that.

### 6. UI interactions

Two events cover the surface. `event.name` stays static; what was clicked is an
attribute.

```jsonc
// event.name: signals.ui.page_viewed
{
  "service.name": "signals-ui",              // separate service — separate trust tier
  "signals.ui.route":     "/profile/edit",
  "signals.ui.flow":      "profile_creation",
  "signals.ui.step":      2,
  "signals.session.id":   "s_4a91…",
  "signals.ui.referrer_route": "/profile",
  "signals.ui.locale":    "en",
  "signals.ui.viewport":  "mobile"
}
```

```jsonc
// event.name: signals.ui.interaction
{
  "service.name": "signals-ui",
  "signals.ui.element": "save_profile",      // stable id, not a label
  "signals.ui.action":  "click",
  "signals.ui.route":   "/profile/edit",
  "signals.ui.flow":    "profile_creation",
  "signals.ui.step":    2,
  "signals.session.id": "s_4a91…",
  "signals.ui.outcome": "validation_error",
  "signals.ui.error_fields": ["date_of_birth"]   // names only
}
```

Pairing `signals.ui.flow` + `step` with the server-side events above is what
turns a funnel into something diagnosable: the UI says where people stalled, the
server says what actually committed.

### 7. Operational — same SDK, other signals

A span for the cross-instance hop, sharing the trace id with example 1:

```jsonc
// span: signals.action.forward_to_target_instance
{
  "name": "signals.action.forward_to_target_instance",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "status": "Ok",
  "attributes": {
    "signals.peer.instance": "in-blr-provider-1",
    "signals.action.type":   "apply",
    "http.response.status_code": 201,
    "signals.peer.duration_ms":  312
  }
}
```

Metrics are ordinary instruments — `signals.peer.fetch.duration` (histogram),
`signals.search.requests` (counter, with a `mode` attribute distinguishing
signals-search from the native fallback), `signals.notification.sent` (counter).
These replace the "publish derived rollups back as events" approach entirely.

---

## Multi-instance without duplicate generation

An item lives on exactly one instance; an action spans two items and therefore up
to two instances. Today an apply is a *distributed* event: the seeker's instance
forwards it to the **provider's instance**, which is the write authority, and the
provider's instance then mirrors the result back. Both instances end up holding
the same event.

Instrumented naively, that's two telemetry events per application — so
cross-instance pairs inflate ~2× while same-instance pairs don't. A skew that
*varies with topology* is worse than a constant one, because it changes silently
as instances are added.

Three layers, in order of importance:

**1. Prevent — single-emitter rule.** Only the instance that owns the write
emits. The forwarding instance and the mirror-back path emit nothing. Duplication
is prevented, not corrected.

**2. Identify — deterministic `signals.event.uid`.** Derived from the domain
natural key, never from a timestamp or the producer:

| Event | `signals.event.uid` |
|---|---|
| Action created / status changed | `act:{action_id}:{update_count}` |
| Item created / updated / lifecycle | `itm:{item_id}:{revision}` |
| Consent accepted | `csn:{consent_record_id}` |
| User provisioned | `usr:{user_id}:provisioned` |

The same change yields the same uid on every instance that observes it, so any
duplicate is provably the same event and collapsible. This is a design
discipline, not a format feature — which is why it survived the format change
intact.

**3. Collapse — idempotent sink** keyed on `signals.event.uid`.

Two properties OTEL adds for free: `service.instance.id` makes every event
attributable to its emitter, and because trace context propagates across the
cross-instance hop, one apply is a single trace — so a duplicate appears as two
events sharing a uid within one trace, which is trivially alertable.

**Ordering.** Timestamps are explicitly not used for ordering; instance clocks
are independent. `signals.action.update_count` and `signals.item.revision` are
the monotonic tiebreaks.

---

## Where telemetry comes from

> The instance that owns the write emits, as part of the same database
> transaction as the write.

Three producers, distinguished by `service.name`, in ranked trust tiers:

| Tier | `service.name` | Emits | Trusted for |
|---|---|---|---|
| 1 — record | `signals-api` | Domain events, spans, metrics | Notifications, metrics of record, audit, compliance |
| 2 — behavioural | `signals-ui` | UI events, client errors | Funnel and UX analysis only |
| 3 — federated | `aggregator-api` | Its own surface and bulk-create writes | Its own reporting |

**Why the API and not the UI** — three independent reasons, each sufficient:
client events are lossy and spoofable, so they can't drive email or compliance;
the UI only talks to its home instance and is structurally blind to the
cross-instance hop; and the same domain change arrives through paths with no UI
at all (aggregator bulk create, admin upsert, instance-to-instance calls). A
UI-sourced funnel would silently omit all of them.

Because tiers are separated by `service.name`, keeping them apart downstream is a
filter rather than a convention — a spoofable count can't be mixed into a metric
of record by accident.

**Not sources:** `item_metrics` (a stale cache — telemetry flows *toward*
metrics, never back) and request logs.

Emission attaches to a handful of existing choke points rather than being
sprinkled across routes, which is why this is a small change: one function
already handles every action write *and* its mirror, and one already handles
every item mutation.

---

## Pipeline

Ingestion uses Obsrv's **`otel-service`** as the asynchronous Kafka bridge, so
nothing in the request path talks to Kafka directly:

```
signals-api  ─┐
signals-ui   ─┼─ OTLP ──▶ otel-service ──▶ Kafka ──▶ Obsrv dataset
aggregator   ─┘                              │
                                             └─▶ raw topic (replay / audit)
```

`otel-service` accepts raw OTLP payloads over HTTP, auto-detects the signal type
(`resourceLogs` / `resourceSpans` / `resourceMetrics`), flattens the nested
attribute arrays into flat maps, promotes resource and scope fields to the top
level, and publishes to two Kafka topics — the flattened stream
(`{env}.{ingest_topic}`) that Obsrv datasets are built on, and the raw stream
(`{env}.{otelingest_topic}`) kept for replay.

Two consequences worth designing around:

- **Flattening is why attribute names matter.** Each `signals.*` attribute
  becomes a column in the Obsrv dataset. Flat, stable, prefixed names keep the
  schema queryable; nested or dynamic names don't survive the trip.
- **Obsrv's own samples carry `eid` and `producer` as resource attributes.** If
  the datasets are shared with other Sunbird-ecosystem producers, adding an
  `eid`-style resource attribute is a cheap compatibility affordance. `event.name`
  stays the real discriminator.

**The durability gap to close.** An HTTP POST to `otel-service` is best-effort:
if it is unavailable, those events are gone. That is fine for UI events, spans,
and metrics. It is **not** fine for events that trigger notifications — a lost
event means a lost email, which is the problem this design exists to fix. So
record-grade events commit to a local durable store in the same transaction as
the domain write and are relayed from there; everything else emits directly.
Mechanics are in the full spec.

---

## Metrics this unlocks

- **Funnel per network and domain:** account created → profile created → profile
  live → first action → accepted. The UI events fill in where people stalled
  between those steps.
- **Profile completion behaviour** — completion percentage over time, and which
  fields are most often left blank, from `changed_fields` and `completion_delta`.
- **Directional per item:** initiated vs received, the same split the dashboard
  computes today, but from a stream instead of a full recompute scan.
- **Cross-instance activity** — events where actor and object networks/domains
  differ, grouped by emitting instance. Currently unanswerable.
- **Time-to-decision** per action, and time-in-state per profile.
- **Consent conversion** — acceptance through to the profile going live.
- **Notification health** — sent / skipped / failed, and the dark-user rate.
- **Search health** — the signals-search fallback rate.
- **U18 gate** — blocked-action rate by channel, confirming the API gate rather
  than the UI is doing the blocking.

`item_metrics` stays as the dashboard's read model; maintaining it incrementally
from the stream is a later, parity-gated step, not an assumption here.

---

## Privacy

The repo's posture is already strict — retire scrubs PII, private coordinates are
jittered before storage, private fields are dropped from search server-side.
Telemetry must not become the leak.

| Rule |
|---|
| No PII in attributes, ever — no email, phone, name, DOB, address, or free-text remarks. Action remarks are excluded, not copied. |
| `signals.actor.id` is a keyed pseudonym: stable enough to join events, not reversible. Erasure is then a single-key delete. |
| Field **names** yes, field **values** no. `changed_fields` and `error_fields` are what make form analytics possible without PII. |
| No coordinates, jittered or not. Coarse geohash only, and only where geography is genuinely needed. |
| Search text is hashed by default; capturing raw queries is opt-in and off, because a query can contain a person's name. |
| Facets restricted to the same declared, non-private fields the API already allows, so telemetry can't enumerate what the API refuses to expose. |
| Minors: a flag, never DOB or guardian contact. Guardian OTP events carry a scope hash, never the OTP or the contact. |
| Never put PII in span attributes either — the operational plane is not a loophole. |

Telemetry does not replace the consent ledger or the PII-reveal audit. Those
remain the compliance records of truth; telemetry mirrors them for analysis.

---

## Key decisions

1. **OpenTelemetry as the single format** for domain and operational telemetry.
   The single-format requirement rules out Sunbird v3, which has no span or
   metric model.
2. **`event.name` is a static `signals.*` namespace**; everything dynamic is an
   attribute.
3. **Deterministic `signals.event.uid`** — the discipline that makes
   multi-instance correct. Prevent duplication at the emitter, identify it by
   uid, collapse it at the sink.
4. **Only the write authority emits**; every instance notifies its own users.
5. **API is the only record-grade source.** Never the UI, never `item_metrics`.
6. **Record-grade events commit with the domain write**, so a notification can't
   be lost; everything else emits best-effort.
7. **`otel-service` is the async Kafka bridge**, keeping Kafka out of the
   request path.

## Open questions

1. **Browser OTEL is immature** — client instrumentation is experimental and the
   JS logs SDK is still an experimental package. Wrap it behind a thin internal
   emitter so it can be swapped without touching call sites. Decide whether GA4
   stays during the transition.
2. **Durable lane mechanics** for record-grade events — local outbox plus relay
   is the proposal; confirm against how `otel-service` is deployed and whether it
   can be reached reliably from every instance.
3. The instance-to-instance mirror needs a decision — fix its authentication or
   retire it once telemetry carries the events. A live defect independent of
   telemetry; needs its own issue.
4. Should the stream maintain `item_metrics` incrementally, or only pre-warm it?
   Parity test before deciding.
5. Do aggregator bulk-create writes record the acting org as an on-behalf-of
   marker on the actor? Cross-repo contract; confirm on the consumer side.
6. One Obsrv dataset per signal type, or per trust tier? Tier separation matters
   more than signal separation for query safety.

## References

- [Obsrv — OpenTelemetry (OTEL) integration](https://obsrv.sunbird.org/guides/example-datasets/opentelemetry-otel-integration)
  and [`Sanketika-Obsrv/otel-service`](https://github.com/Sanketika-Obsrv/otel-service)
- [OTEL semantic conventions for events](https://opentelemetry.io/docs/specs/semconv/general/events/)
- [OTEL logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
