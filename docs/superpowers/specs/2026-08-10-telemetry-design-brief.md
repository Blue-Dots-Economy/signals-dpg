# Telemetry design — brief

**Date:** 2026-08-10 (revised 2026-08-13 — OpenTelemetry, fixed attribute schema;
review fixes §6.1–6.4 applied)
**Full spec:** `2026-08-10-telemetry-design.md` — same design in depth
(code-level emit contract, failure modes, configuration)
**Plan:** `../plans/2026-08-10-telemetry-implementation.md`
**Review:** `telemetry-design-reconciliation-2026-08-13.md`

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

So: **OpenTelemetry, OTLP wire format, one SDK.**

### The three signals

| Signal | Carries | Trusted for |
|---|---|---|
| **Events** (log records with `event.name`) | Domain state changes and UI actions | Notifications, metrics of record, audit |
| **Traces** (spans) | Request flow, propagated across instances | Latency, cross-instance correlation |
| **Metrics** (counters/histograms) | Operational and derived business counters | Dashboards, alerting |

All three share one `Resource`, so producer identity and environment are attached
uniformly and can't be forgotten per event:

| Resource attribute | Meaning |
|---|---|
| `service.name` | Producer and trust tier (`signals-api`, `signals-ui`, `aggregator-api`). |
| `service.version` | Build version. |
| `deployment.environment.name` | `production`, `staging`. |
| `service.instance.id` | **Process identity** — the pod/replica, per OTEL semconv. Changes on restart. Operational debugging only. |
| `dpg.instance` | **Deployment identity** — the stable DPG instance, same value space as `source.instance` / `target.instance`. |

`service.instance.id` and `dpg.instance` are deliberately different things.
Semconv's `service.instance.id` identifies a process, so it cycles with pods and
differs per replica — grouping domain events by "which instance emitted this" on
it would drift silently and would never join to `source.instance`. `dpg.instance`
is the one to group and join on.

Its value is the **normalised instance base URL** — the same value
`item_instance_url` and `origin_instance_domain` already carry, so joins need no
mapping table. A short slug is acceptable instead only if the mapping is 1:1 and
stable.

---

## Attribute schema

**Every event uses the same fixed set of attributes.** No scenario-invented
fields. A new feature reuses this vocabulary or, in the rare case it genuinely
can't, uses the bounded extension slot below.

This matters more than it looks: attributes become columns downstream, so a fixed
schema means one stable table for all events, uniform queries across unrelated
flows, and no schema migration every time a feature ships.

Names are unprefixed and align with OTEL semantic conventions where one already
exists (`session.id`, `error.type`, `http.*`).

### Core — on every event

| Attribute | Meaning |
|---|---|
| `event.name` | Static identifier, `<area>.<verb>` — unprefixed. Never contains ids or dynamic values. |
| `event.uid` | Deterministic dedup key derived from the domain natural key. |
| `event.category` | `state_change` · `interaction` · `view` · `query` · `delivery` · `error` |
| `event.parent_uid` | The `event.uid` that caused this one. Links a notification to the change that triggered it. |
| `network` | Network id (`yellow_dot`). |
| `channel` | How it originated: `in_app` · `external` · `admin` · `system` · `otp_email` · `otp_sms` |

### Actor — who acted

| Attribute | Meaning |
|---|---|
| `actor.id` | Pseudonymised principal id. |
| `actor.type` | `user` · `system` · `org` · `guardian` · `peer` |
| `actor.on_behalf_of` | Org id when acting for someone else (admin, aggregator). |
| `actor.is_minor` | Flag only, never DOB. |

### Object — what was acted on

| Attribute | Meaning |
|---|---|
| `object.id` | Item id, action id, user id, route, element id. |
| `object.type` | `item` · `action` · `user` · `consent` · `notification` · `page` · `element` · `query` |
| `object.subtype` | Domain refinement: `profile_1.0`, `apply`, `terms`, `email`. |
| `object.version` | Monotonic version — action `update_count`, or item `revision` (see the migration note below). |
| `object.owner` | Pseudonymised owner of the object. |
| `object.org` | **Attributing organisation** of the subject — the org a metric belongs to. |

One `object.subtype` replaces what would otherwise be `item.type`,
`action.type`, `consent.category`, and `notification.channel` as four separate
fields.

**`object.org` is not `actor.on_behalf_of`,** and conflating them silently breaks
every per-aggregator number. `actor.on_behalf_of` is the org *acting right now*
(an admin or aggregator operating for someone). `object.org` is the org the
subject is *attributed to* — in Signals, the item owner's
`user.onboarded_by_org_id`. A seeker onboarded by aggregator A who performs their
own apply has an empty `actor.on_behalf_of`, but the metric still belongs to A.

This is not hypothetical: `services/metrics/recompute.ts:131,254` scopes every
dashboard tile in production by `(onboarded_by_org_id, domain)`. Without
`object.org` no per-aggregator metric is derivable from the stream, so the parity
gate that guards stream-maintained `item_metrics` could never be passed.

**Migration note — `object.version` for items.** `items` has no monotonic column
today: only `created_at`, `updated_at`, and `lifecycle_status`. So item
`event.uid`s are not derivable yet, and `updated_at` cannot substitute without
breaking the rule that a uid never derives from a timestamp. This needs a
`revision integer not null default 1` on `items`, bumped in the same transaction
as every mutation — which makes all six item write sites below load-bearing.
Actions need nothing: `action_events.update_count` already exists.

### State — any transition

| Attribute | Meaning |
|---|---|
| `state.from` / `state.to` | Previous and new state. Either may be absent on creation. |
| `state.bucket` | Normalised classification: `create` · `accept` · `reject` · `cancel` |
| `state.trigger` | What caused it: `user_action` · `profile_consent_accepted` · `system` · `admin_upsert` |
| `state.duration_ms` | Time spent in the previous state. |

This one group covers action status changes, item lifecycle, consent, and user
provisioning. `state.bucket` is what lets you aggregate across networks that use
different status words.

### Placement — the directional edge

Both blocks describe the *items*; `actor.*` describes the *principal*. For a
single-sided event only `source.*` is set.

| Attribute | Meaning |
|---|---|
| `source.domain` / `target.domain` | Role in the network (`seeker`, `provider`). |
| `source.item_type` / `target.item_type` | Schema id. |
| `source.item_id` / `target.item_id` | Item ids. |
| `source.instance` / `target.instance` | DPG instance hosting each side — normalised base URL, same value space as `dpg.instance`. |

### Measures, flow, fields, outcome

| Attribute | Meaning |
|---|---|
| `metric.count` | Any cardinal count — results, fields, recipients. |
| `metric.duration_ms` | Any duration. |
| `metric.score` | Any normalised score — completion %, match score. |
| `metric.delta` | Change in count or score since the previous event. |
| `flow.name` / `flow.step` | Position in a multi-step flow (`signup`, `profile_creation`, `bulk_upload`). |
| `flow.outcome` | `success` · `validation_error` · `abandoned` · `blocked` |
| `fields.changed` / `fields.error` / `fields.missing` | Field **names** only, never values. |
| `outcome` | `success` · `failure` · `skipped` · `blocked` |
| `outcome.reason` | `no_email` · `cap_exceeded` · `minor_channel_blocked` |
| `session.id` | OTEL semconv. |
| `ui.route` / `ui.element` / `ui.action` | UI surface only. |
| `error.type` / `error.message` | OTEL semconv. Machine code plus a PII-free message. |

### Extension slot

`attr.*` is the escape hatch for something genuinely new. **Rule: any `attr.*`
key used in more than two places gets promoted into the core schema.** That keeps
the hatch from quietly becoming the sprawl it exists to prevent.

**On `event.name` values:** unprefixed dotted `<area>.<verb>` —
`action.created`, `item.lifecycle_changed`. No product namespace anywhere. OTEL
guidance is to namespace event names against collision when several producers
share a stream, but `service.name` in the `Resource` already identifies the
producer on every event, so a prefix would add nothing.

---

## Example events

One event in full OTLP JSON for accuracy; the rest in flattened form, which is
easier to read and matches what you'll query.

### 1. Full OTLP shape — cross-instance action status change

A provider shortlists a seeker's application. The provider's instance owns the
write, so it is the only emitter.

```jsonc
{
  "resourceLogs": [{
    "resource": { "attributes": [
      { "key": "service.name",        "value": { "stringValue": "signals-api" } },
      { "key": "service.version",     "value": { "stringValue": "1.14.0" } },
      { "key": "deployment.environment.name", "value": { "stringValue": "production" } },
      { "key": "dpg.instance",        "value": { "stringValue": "https://provider.example.org" } },
      { "key": "service.instance.id", "value": { "stringValue": "api-7f9c4b-x2m1" } }  // pod, not deployment
    ]},
    "scopeLogs": [{
      "scope": { "name": "@dpg/telemetry", "version": "1.0.0" },
      "logRecords": [{
        "timeUnixNano":         "1786665600123000000",
        "observedTimeUnixNano": "1786665600123000000",
        "severityNumber": 9, "severityText": "INFO",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",   // spans the cross-instance hop
        "spanId":  "00f067aa0ba902b7",
        "attributes": [
          { "key": "event.name",     "value": { "stringValue": "action.status_changed" } },
          { "key": "event.uid",      "value": { "stringValue": "act:9f2c…:3" } },
          { "key": "event.category", "value": { "stringValue": "state_change" } },
          { "key": "network",        "value": { "stringValue": "yellow_dot" } },
          { "key": "channel",        "value": { "stringValue": "in_app" } },

          { "key": "actor.id",   "value": { "stringValue": "px_7d41a9…" } },
          { "key": "actor.type", "value": { "stringValue": "user" } },

          { "key": "object.id",      "value": { "stringValue": "9f2c…" } },
          { "key": "object.type",    "value": { "stringValue": "action" } },
          { "key": "object.subtype", "value": { "stringValue": "apply" } },
          { "key": "object.version", "value": { "intValue": "3" } },
          { "key": "object.org",     "value": { "stringValue": "org_agg_a" } },  // attribution

          { "key": "state.from",    "value": { "stringValue": "applied" } },
          { "key": "state.to",      "value": { "stringValue": "shortlisted" } },
          { "key": "state.bucket",  "value": { "stringValue": "accept" } },
          { "key": "state.trigger", "value": { "stringValue": "user_action" } },

          { "key": "source.domain",    "value": { "stringValue": "seeker" } },
          { "key": "source.item_type", "value": { "stringValue": "profile_1.0" } },
          { "key": "source.item_id",   "value": { "stringValue": "b71e…" } },
          { "key": "source.instance",  "value": { "stringValue": "https://seeker.example.org" } },
          { "key": "target.domain",    "value": { "stringValue": "provider" } },
          { "key": "target.item_type", "value": { "stringValue": "job_1.0" } },
          { "key": "target.item_id",   "value": { "stringValue": "c88a…" } },
          { "key": "target.instance",  "value": { "stringValue": "https://provider.example.org" } },

          { "key": "outcome", "value": { "stringValue": "success" } }
        ]
      }]
    }]
  }]
}
```

`actor` is the provider user who performed *this* transition; `source`/`target`
describe the action's original direction. Keeping them separate is what lets you
ask both "who decided" and "which way did the request flow."

`source.instance` differing from `target.instance` is what makes this event
visibly cross-instance — the single most useful thing no current query can tell
you.

### 2. User creation

```jsonc
{
  "event.name": "user.provisioned",
  "event.uid":  "usr:8d3f…:provisioned",
  "event.category": "state_change",
  "network": "yellow_dot", "channel": "otp_email",

  "actor.type": "system",
  "actor.is_minor": false,

  "object.id": "px_7d41a9…", "object.type": "user", "object.subtype": "participant",
  "object.version": 1,
  "object.org": "org_agg_a",          // onboarding org — attribution

  "state.to": "active", "state.trigger": "self_signup",

  "source.domain": "seeker", "source.instance": "https://seeker.example.org",
  "flow.name": "signup", "flow.step": 3, "flow.outcome": "success",
  "outcome": "success"
}
```

`actor.type: system` because provisioning is performed by the platform, with the
subject in `object.*`. Admin onboarding instead sets `actor.type: user`,
`actor.on_behalf_of: <org_id>`, `channel: admin`, `state.trigger: admin_upsert` —
same schema, no new fields.

### 3. Profile creation

Profiles are items (`item_type: profile_1.0`), so this is an item event with a
subtype — not a separate event shape.

```jsonc
{
  "event.name": "item.created",
  "event.uid":  "itm:b71e…:1",
  "event.category": "state_change",
  "network": "yellow_dot", "channel": "in_app",

  "actor.id": "px_7d41a9…", "actor.type": "user",

  "object.id": "b71e…", "object.type": "item",
  "object.subtype": "profile_1.0", "object.version": 1,
  "object.owner": "px_7d41a9…", "object.org": "org_agg_a",

  "state.to": "draft", "state.trigger": "user_action",

  "source.domain": "seeker", "source.item_type": "profile_1.0",
  "source.item_id": "b71e…", "source.instance": "https://seeker.example.org",

  "metric.score": 40,   // completion %
  "metric.count": 7,    // populated fields
  "flow.name": "profile_creation", "flow.step": 4,
  "outcome": "success"
}
```

### 4. Profile update

```jsonc
{
  "event.name": "item.updated",
  "event.uid":  "itm:b71e…:2",
  "event.category": "state_change",
  "network": "yellow_dot", "channel": "in_app",

  "actor.id": "px_7d41a9…", "actor.type": "user",
  "object.id": "b71e…", "object.type": "item",
  "object.subtype": "profile_1.0", "object.version": 2,
  "object.owner": "px_7d41a9…", "object.org": "org_agg_a",

  "state.from": "draft", "state.to": "draft", "state.trigger": "user_action",

  "metric.score": 75, "metric.delta": 35,
  "fields.changed": ["skills", "location"],   // names only, never values
  "outcome": "success"
}
```

**`fields.changed` carries names, never values** — that's what makes "which
fields do people leave blank" answerable without touching PII.

### 5. Onboarding — the profile goes live

"Onboarded" is not its own event. It's the lifecycle promotion that consent
acceptance triggers, so telemetry can't drift from the transition the code
actually enforces.

```jsonc
{
  "event.name": "item.lifecycle_changed",
  "event.uid":  "itm:b71e…:3",
  "event.category": "state_change",
  "event.parent_uid": "csn:4f2a…",           // the consent that caused it
  "network": "yellow_dot", "channel": "in_app",

  "actor.id": "px_7d41a9…", "actor.type": "user",
  "object.id": "b71e…", "object.type": "item",
  "object.subtype": "profile_1.0", "object.version": 3,
  "object.owner": "px_7d41a9…", "object.org": "org_agg_a",

  "state.from": "draft", "state.to": "live",
  "state.trigger": "profile_consent_accepted",
  "state.duration_ms": 864000000,

  "source.domain": "seeker", "source.instance": "https://seeker.example.org",
  "outcome": "success"
}
```

Account creation (#2) and going live (#5) stay separate events. Most onboarding
drop-off happens *between* them, and a single "onboarded" event would hide
exactly that.

### 6. UI interactions

`event.name` stays static; what was viewed or clicked is `object.id`.

```jsonc
{
  "event.name": "ui.page_viewed",
  "event.uid":  "ui:s_4a91…:18",
  "event.category": "view",
  "network": "yellow_dot", "channel": "in_app",

  "actor.id": "px_7d41a9…", "actor.type": "user",
  "object.id": "/profile/edit", "object.type": "page",

  "session.id": "s_4a91…",
  "ui.route": "/profile/edit",
  "flow.name": "profile_creation", "flow.step": 2
}
```

```jsonc
{
  "event.name": "ui.interaction",
  "event.uid":  "ui:s_4a91…:19",
  "event.category": "interaction",
  "network": "yellow_dot", "channel": "in_app",

  "actor.id": "px_7d41a9…", "actor.type": "user",
  "object.id": "save_profile", "object.type": "element",   // stable id, not a label

  "session.id": "s_4a91…",
  "ui.route": "/profile/edit", "ui.element": "save_profile", "ui.action": "click",
  "flow.name": "profile_creation", "flow.step": 2,
  "flow.outcome": "validation_error",
  "fields.error": ["date_of_birth"],
  "outcome": "failure"
}
```

Because both UI and server events carry `flow.name` and `flow.step`, a funnel
becomes diagnosable: the UI says where people stalled, the server says what
actually committed.

### 7. Search

```jsonc
{
  "event.name": "search.executed",
  "event.category": "query",
  "network": "yellow_dot", "channel": "in_app",

  "actor.id": "px_7d41a9…", "actor.type": "user",
  "object.type": "query", "object.subtype": "discover",

  "metric.count": 42, "metric.duration_ms": 87,
  "session.id": "s_4a91…",
  "outcome": "success",
  "attr.search_mode": "native_fallback"    // extension slot in use
}
```

`attr.search_mode` shows the escape hatch working — and by the promotion rule,
once a second and third use appears it becomes a core attribute rather than
staying ad hoc.

### 8. Notification

```jsonc
{
  "event.name": "notification.skipped",
  "event.uid":  "ntf:act:9f2c…:3:INBOUND_STATUS",
  "event.category": "delivery",
  "event.parent_uid": "act:9f2c…:3",       // the change that triggered it
  "network": "yellow_dot", "channel": "system",

  "actor.type": "system",
  "object.type": "notification", "object.subtype": "email",
  "object.owner": "px_7d41a9…",

  "outcome": "skipped", "outcome.reason": "no_email"
}
```

`event.parent_uid` is what closes the loop: every notification is traceable to
the domain change that caused it, and the skip reasons become a measurable
dark-user rate rather than a log line.

### 9. Operational — same SDK, other signals

```jsonc
// span
{
  "name": "action.forward_to_target_instance",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",   // same trace as example 1
  "status": "Ok",
  "attributes": {
    "target.instance": "https://provider.example.org",
    "object.subtype":  "apply",
    "http.response.status_code": 201,
    "metric.duration_ms": 312
  }
}
```

Metrics are ordinary instruments — a histogram for peer-fetch duration, counters
for search requests and notifications sent — reusing the same attribute names as
dimensions, so a metric and an event can be joined on `network`, `source.domain`,
or `state.bucket` without a translation table.

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

**2. Identify — deterministic `event.uid`.** Derived from the domain natural key,
never from a timestamp or the producer:

| Event | `event.uid` |
|---|---|
| Action created / status changed | `act:{action_id}:{update_count}` |
| Item created / updated / lifecycle | `itm:{item_id}:{revision}` — **needs the `revision` migration** |
| Consent accepted | `csn:{consent_record_id}` |
| User provisioned | `usr:{user_id}:provisioned` |
| Notification | `ntf:{parent_uid}:{shape}` |

The same change yields the same uid on every instance that observes it, so any
duplicate is provably the same event and collapsible. This is a design
discipline, not a format feature — which is why it survived the format change
intact.

**The action uid is already validated by the schema.** `action_events` has a
unique index on `(partition_network, action_type, origin_instance_domain,
action_id, update_count)`. The action `event.uid` is precisely that key *minus*
`origin_instance_domain` — i.e. the key under which the authoritative row and the
mirrored row collapse into one. The dedup discipline isn't a new invariant; it's
the one the table already encodes.

**3. Collapse — idempotent sink** keyed on `event.uid`.

Two properties OTEL adds for free: `dpg.instance` makes every event attributable
to its emitting deployment (not `service.instance.id`, which is per-pod and cycles
on restart), and because trace context propagates across the cross-instance hop,
one apply is a single trace — so a duplicate appears as two events sharing a uid
within one trace, which is trivially alertable.

**Ordering.** Timestamps are explicitly not used for ordering; instance clocks
are independent. `object.version` is the monotonic tiebreak.

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

### Emit sites

Actions have one write function; items do **not**. Getting this wrong is how the
single-emitter rule gets violated in practice, so the sites are named here rather
than left as "a handful of choke points."

**Actions — one function, three callers, one of them the mirror receiver.**
`insertActionEvent` (`utils/action_event_runtime.ts:121`) is genuinely the single
write path, called from exactly three places:

| Caller | Role |
|---|---|
| `routes/v1/network/action/perform_action.ts:352` | write authority |
| `routes/v1/action/update_action_status.ts:607` | write authority |
| `routes/v1/event/store_event.ts:109` | **mirror receiver** |

Instrument the function naively and the source instance emits on mirror-receive —
exactly the double emission the single-emitter rule forbids.

Two mechanisms already in the code make this safe without inventing anything:

- **Emit inside the existing `if (createdEvent)` guard.** `insertActionEvent` uses
  `onConflictDoNothing(...).returning(...)` and returns `null` on a duplicate, so
  retry-duplication is handled by the database for free.
- **The single-emitter rule is a column comparison, not a convention.**
  `origin_instance_domain` is set to `getCurrentApiBaseUrl()` at both authority
  sites (`perform_action.ts:338`, `update_action_status.ts:578`) and carries the
  *originating* instance on the mirror path. So the rule is: emit only when
  `origin_instance_domain` normalises to this instance. That is checkable in one
  expression, rather than a standing agreement about which routes not to
  instrument.

**Items — six write sites, and lifecycle bypasses the service layer.**

| Site | Note |
|---|---|
| `services/item_service.ts:345` | create |
| `services/item_service.ts:518`, `:748` | update |
| `routes/v1/item/lifecycle.ts:161`, `:215` | writes `items` directly, bypassing `item_service` — this is the path behind the `lifecycle_changed` example (#5) |
| `scripts/backfill_lifecycle.ts:144` | backfill script |

All the runtime paths already run inside a transaction, so "emit in the same
transaction as the write" needs no restructuring. But item instrumentation is six
sites, not one — and each is also where the `revision` bump has to happen, so the
two changes should land together.

---

## Pipeline

```
signals-api  ─┐                            ┌─▶ raw topic          (replay, audit)
signals-ui   ─┼─ OTLP ──▶ OTLP→Kafka ──────┤
aggregator   ─┘           bridge           └─▶ transformed topic  (analytics)
```

Producers speak OTLP and nothing else. An OTLP→Kafka bridge — the OTEL
Collector's Kafka exporter, or an equivalent service — publishes to two topics:

- **Raw topic** — OTLP payloads verbatim. Kept for replay and audit, and so a
  downstream schema mistake is always recoverable.
- **Transformed topic** — attribute arrays flattened to flat maps, resource and
  scope fields promoted to top level. This is what analytics consumes.

**Deliberately datastore-independent.** Nothing above the Kafka topics is part of
this design. Any warehouse, OLAP store, or analytics platform can consume the
transformed topic; swapping one for another changes no producer code and no event
schema. The fixed attribute schema is what makes that portability real — flat,
stable names map cleanly onto whatever table shape the sink prefers.

**The durability gap to close.** Emitting OTLP over the network is best-effort:
if the bridge is unavailable, those events are gone. That is fine for UI events,
spans, and metrics. It is **not** fine for events that trigger notifications — a
lost event means a lost email, which is the problem this design exists to fix. So
record-grade events commit to a local durable store in the same transaction as
the domain write and are relayed from there; everything else emits directly.
Mechanics are in the full spec.

---

## Metrics this unlocks

- **Funnel per network and domain:** account created → profile created → profile
  live → first action → accepted. `flow.name` and `flow.step` join the UI and
  server sides, so you see where people stalled as well as what committed.
- **Profile completion behaviour** — `metric.score` over time, and which fields
  are most often left blank, from `fields.changed` and `fields.missing`.
- **Directional per item:** initiated vs received, from `source.*` and
  `target.*` — the same split the dashboard computes today, but from a stream
  instead of a full recompute scan.
- **Cross-instance activity** — events where `source.instance` differs from
  `target.instance`, grouped by emitter. Currently unanswerable.
- **Time-to-decision and time-in-state**, from `state.duration_ms`.
- **Consent conversion** — acceptance through to the profile going live, joined
  on `event.parent_uid`.
- **Notification health** — `outcome` and `outcome.reason` give sent / skipped /
  failed and the dark-user rate.
- **Search health** — fallback rate and latency from `metric.duration_ms`.
- **U18 gate** — blocked-action rate by `channel`, confirming the API gate rather
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
| `actor.id` and `object.owner` are keyed pseudonyms: stable enough to join events, not reversible. Erasure is then a single-key delete. |
| Field **names** yes, field **values** no. `fields.changed` / `fields.error` / `fields.missing` are what make form analytics possible without PII. |
| No coordinates, jittered or not. Coarse geohash only, and only where geography is genuinely needed. |
| Search text is never an attribute; capturing raw queries is opt-in and off, because a query can contain a person's name. |
| Facets restricted to the same declared, non-private fields the API already allows, so telemetry can't enumerate what the API refuses to expose. |
| Minors: `actor.is_minor` only, never DOB or guardian contact. Guardian OTP events carry a scope hash, never the OTP or the contact. |
| `error.message` must be a safe message. Never put PII in span attributes either — the operational plane is not a loophole. |

The fixed schema helps here too: with no free-form per-feature fields, a PII leak
has to go through a named slot that review can check, rather than arriving in an
attribute nobody was watching.

Telemetry does not replace the consent ledger or the PII-reveal audit. Those
remain the compliance records of truth; telemetry mirrors them for analysis.

---

## Key decisions

1. **OpenTelemetry as the single format** for domain and operational telemetry.
   The single-format requirement rules out Sunbird v3, which has no span or
   metric model.
2. **One fixed attribute schema for all events**, with `attr.*` as a bounded
   escape hatch and a promotion rule. No per-scenario fields.
3. **`event.name` is a static, unprefixed `<area>.<verb>`**; everything dynamic is
   an attribute.
4. **Deterministic `event.uid`** — the discipline that makes multi-instance
   correct. Prevent duplication at the emitter, identify it by uid, collapse it
   at the sink.
5. **Only the write authority emits**, expressed as an
   `origin_instance_domain == this instance` check rather than a convention;
   every instance notifies its own users.
6. **API is the only record-grade source.** Never the UI, never `item_metrics`.
   Deployment identity is `dpg.instance`, not `service.instance.id`.
7. **Record-grade events commit with the domain write**, so a notification can't
   be lost; everything else emits best-effort.
8. **Raw and transformed Kafka topics are the boundary.** No analytics datastore
   is part of this design.
9. **`object.org` carries subject attribution**, separate from
   `actor.on_behalf_of`. Without it, per-aggregator metrics can't come from the
   stream.

## Prerequisites

Two things must land before item events are implementable, both surfaced by the
2026-08-13 review:

1. **A `revision` column on `items`** — `integer not null default 1`, bumped in
   the same transaction as every mutation, at all six write sites. Until then
   item `event.uid`s and `object.version` have no source.
2. **`object.org` resolution** — the item owner's `user.onboarded_by_org_id` must
   be available at emit time on the item and action paths.

## Open questions

1. **Browser OTEL is immature** — client instrumentation is experimental and the
   JS logs SDK is still an experimental package. Wrap it behind a thin internal
   emitter so it can be swapped without touching call sites. Decide whether GA4
   stays during the transition.
2. **Durable lane mechanics** for record-grade events — a local outbox plus relay
   is the proposal; confirm against how the OTLP→Kafka bridge is deployed and
   whether it is reachable from every instance.
3. The instance-to-instance mirror needs a decision — fix its authentication or
   retire it once telemetry carries the events. A live defect independent of
   telemetry; needs its own issue.
4. Should the stream maintain `item_metrics` incrementally, or only pre-warm it?
   Parity test before deciding — and blocked until `object.org` lands, since
   without it the parity test cannot reproduce a single dashboard tile.
5. Do aggregator bulk-create writes set `actor.on_behalf_of` for the acting org?
   Cross-repo contract; resolve together with `object.org`, since the two org
   fields are the easiest thing here to conflate.
6. Should the transformed topic be split by trust tier, so tier-2 events can't be
   read into a metric of record by mistake? A filter on `service.name` works, but
   separate topics make it structural.
7. What increments `items.revision`, and does the backfill script bump it too?
   A migration decision that gates every item event.

## References

- [OTEL semantic conventions for events](https://opentelemetry.io/docs/specs/semconv/general/events/)
- [OTEL logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [OTEL Collector Kafka exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/kafkaexporter)
