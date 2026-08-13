# Telemetry design — reconciliation memo

**Date:** 2026-08-13
**Purpose:** align the fresh Signals telemetry brief with the July cross-DPG umbrella, record what is now settled, and list what must be fixed before either goes to implementation plans.
**Status:** review feedback. No spec has been rewritten; the doc structure is deliberately left open (see §8).

## 1. What is being reconciled

| Doc | Location | Scope |
|---|---|---|
| **Telemetry design brief** (new) | `signals-dpg` branch `telemetry-design`, `docs/superpowers/specs/2026-08-10-telemetry-design-brief.md` (`cb888824`, revised `0554c212`) | Signals-only. Format choice, event vocabulary, multi-instance correctness, privacy. |
| **Cross-DPG telemetry & insight platform** (July umbrella) | `signals-dpg` branch `feat/telemetry-platform`, `2026-07-08-telemetry-platform-design.md` + `.technical.md`. Tracked as signals-dpg **#277** (open, no comments). | All DPGs. Two planes, envelope, pipeline, insight service, backend, SP1–SP4 phasing. |
| **Telemetry design — Aggregator-DPG** (already merged) | `aggregator-dpg` `docs/telemetry-design.md`, authored 2026-05-22 (`f4dc44b`) and long since on `develop` and `main`. Implementation **PR #354 still OPEN**, head `telemetry-implementation`, base `develop`. | Aggregator-only OTel: `@aggregator-dpg/telemetry`, Collector → Jaeger/Loki/Prometheus, YAML-declared outcome metrics. |

A fourth exists in practice: **ai-diffusion-dpg's `observability_layer`** (Python, mature OTel + `dpg_telemetry`). It is not referenced by the brief.

Every finding below was checked against the code on `signals-dpg` `feature`, not inferred from the docs.

**Confirmed accurate in the brief:** Signals has no OpenTelemetry at all (no `opentelemetry` dependency in any `package.json`). `item_metrics` is a synchronous TTL cache — `services/metrics/staleness.ts:7` defaults to 3600s, and `services/metrics/README.md` confirms there is no background job; whichever request finds it stale recomputes and blocks. GA4 is page-views-only and off unless a deployment sets `VITE_ANALYTICS_GA_ID` (`apps/ui/src/lib/api-config.ts:14`). The four-substitutes framing is a fair description of today.

## 2. Verdict

**Adopt the brief's format and event model.** On the three points where the two docs disagree about mechanism, the brief is better and the umbrella's version should be dropped, not defended:

1. **Deterministic `event.uid` from the domain natural key** beats the umbrella's random `mid`. A random message id only dedups retries of one emission; a deterministic key collapses the *same change observed on two instances*, which is the actual multi-instance problem. It also happens to mirror an invariant already in the schema — see §6.4.
2. **One fixed attribute schema** beats per-`eid` payload schemas. One stable wide table, uniform queries across unrelated flows, no schema migration per feature. The `attr.*` escape hatch with a promotion-after-two-uses rule is the right guard.
3. **Keep `item_metrics` as the dashboard read model, parity-gated** beats the umbrella's "retire it into the insight service." The umbrella bet a live dashboard on an unbuilt pipeline.


## 3. Settled decisions

These can be treated as fixed; neither doc needs to re-argue them.

1. **OpenTelemetry, OTLP wire format, one SDK** for domain and operational telemetry.
2. **One fixed attribute schema** for all events; `attr.*` is the only extension point, promoted into core after a second use.
3. **`event.name` is a static namespaced identifier**; everything dynamic is an attribute.
4. **Deterministic `event.uid`** from the domain natural key. Prevent duplication at the emitter, identify it by uid, collapse it at the sink.
5. **Only the write authority emits.** Every instance notifies its own users.
6. **The API is the only record-grade source.** Never the UI, never `item_metrics`. Trust tiers separated by `service.name`.
7. **`item_metrics` stays** as the dashboard read model. Stream-maintained is a later, parity-gated step.
8. **Ordering by monotonic version, never timestamps** — instance clocks are independent.
9. **Privacy posture as written in the brief** (names not values, keyed pseudonyms, no coordinates, no search text, `is_minor` flag only). The umbrella's two-list model (`audit.pii_fields_excluded` vs `telemetry.pii_fields_excluded`) adds nothing the fixed schema does not already give; drop it.
10. **`event.category` and `state.bucket` are the cross-service-stable dimensions.** Worth stating explicitly in the brief: `event.category` *is* the umbrella's domain-neutral taxonomy (`IMPRESSION`/`INTERACT`/`AUDIT`/`SEARCH` → `view`/`interaction`/`state_change`/`query`), and `state.bucket` (create/accept/reject/cancel) *is* Signals' canonical `network.json` `metric_categories` vocabulary. That is convergence, not coincidence, and naming it is what lets a cross-DPG query group by category while each service keeps its own `event.name` detail.

## 4. Superseded from the umbrella

So nobody builds the dead half:

- The **Sunbird v3 envelope** (`eid`/`ets`/`mid`/`actor`/`context.{channel,pdata,env,sid,did,cdata,rollup}`/`object`/`edata`/`tags`) — replaced by OTLP log records with the fixed attribute set.
- The **`eid` enum taxonomy** and per-`eid` `edata` schemas — replaced by static `event.name` plus `event.category`.
- **`mid`** as a random dedup key — replaced by deterministic `event.uid`.
- **"Retire `item_metrics`"** as a v1 goal — demoted to a later parity-gated step.
- **`POST /v3/telemetry`** as the browser ingest door — replaced by OTLP from the browser (subject to open question 1 in §7).

## 5. Retained from the umbrella

Five things the brief drops that should survive the format change:

1. **An organisation dimension.** The single most consequential gap; see §6.2.
2. **Two data models inside one format.** One format does not mean one model: operational signals are low-cardinality, aggregate, alert-driven; domain events are high-cardinality, per-entity, replay-driven. The brief's three-signal table already implies this — make it explicit so retention, sampling, and access rules can differ by signal without a second format.
3. **The insight service and config-driven derivations, as a later phase.** The brief is right that v1 should not touch the dashboard. But the generalisation of the `metric_categories` / `status_rules` DSL into stream derivations is the thing that eventually makes metrics cross-instance, and it should stay on the roadmap rather than vanishing.
4. **Cross-DPG harmonisation, including aggregator PR #354.** The brief lists `aggregator-api` as trust tier 3 and says nothing else. But aggregator has a *merged* telemetry design with a different envelope, its own SDK, and a Collector fan-out to Jaeger/Loki/Prometheus — and an open unmerged implementation PR. Either #354 is re-pointed at this contract before it merges, or the platform gets two OTel dialects on day one. ai-diffusion's Python layer needs the same call. This is a decision that expires: it gets more expensive the longer #354 sits.
5. **A validation gate.** A fixed schema is only fixed if something rejects events that violate it. The umbrella put per-`eid` JSON-schema validation at ingest; the equivalent here is required-attribute rules per `event.name`, enforced in the emitter and again at the bridge. Without it, `object.subtype` absorbing four former fields means nothing type-checks.

Also dropped and worth keeping from the umbrella's metric catalogue: **OTP delivery success and latency** (login-critical), **search health** (zero-result rate, filter usage, CTR, cache-hit), and **notification delivery/bounce outcomes**. See §6.5 for why the current producer list cannot emit the last two.

## 6. Fixes required before this goes to plans

### 6.1 `event.uid` for item events is not derivable today

The brief specifies `itm:{item_id}:{revision}` and defines `object.version` as "item revision." **There is no revision column on `items`** — `packages/database/src/drizzle_ref_tables/items.ts` has `item_state`, `item_private_state`, `item_locations`, `created_by`, `created_at`, `updated_at`, `lifecycle_status`, and nothing monotonic. Actions are fine: `action_events.update_count` exists.

So three of the brief's worked examples (#3 create, #4 update, #5 lifecycle) have no implementable dedup key, and `updated_at` cannot substitute without breaking the brief's own rule that a uid never derives from a timestamp.

*Recommended:* add a monotonic `revision integer not null default 1` to `items`, incremented in the same transaction as every mutation. It is a small migration and it also gives `object.version` a real meaning for items. Note it makes the item write paths in §6.4 load-bearing — every writer must bump it.

### 6.2 No organisation dimension — today's dashboard cannot be reproduced from the stream

`services/metrics/recompute.ts:118` computes metrics per **`(aggregator_id, domain)`**, where the aggregator is the participant's `onboarded_by_org_id` (`recompute.ts:131`, `:254`). Every dashboard tile in production is scoped that way.

The fixed schema has `actor.on_behalf_of` — the org *acting* — but nothing for the org a subject is *attributed to*. Those are different: a seeker onboarded by aggregator A performs their own apply, so `actor.on_behalf_of` is empty while the metric still belongs to A. The umbrella's `rollup.l4 = org` covered this; the brief has no equivalent.

*Recommended:* add `object.org` (attributing organisation of the subject, distinct from `actor.on_behalf_of`) to the Object group. Without it, no per-aggregator metric can ever be derived from the stream, and the parity gate in decision 7 can never be passed.

### 6.3 `service.instance.id` is the wrong identity for a DPG instance

The brief leans on the OTEL `Resource` for emitter identity — "`service.instance.id` makes every event attributable to its emitter" — while separately carrying `source.instance` / `target.instance` as deployment identity, with example values like `in-blr-provider-1`.

In OTEL semantic conventions `service.instance.id` identifies the **process/pod**: it changes on every restart and differs per replica. Grouping "duplicates by emitter" on it will drift silently as pods cycle, and it will not join to `source.instance` / `target.instance`.

*Recommended:* keep `service.instance.id` for what semconv means (process identity, useful for operational debugging) and add a stable deployment attribute — `deployment.name` or `dpg.instance` — carrying the same value space as `source.instance` / `target.instance`. State that the two are different things.

### 6.4 The "small change" choke points do not hold — but the discriminators already exist

The brief says "one function already handles every action write *and* its mirror, and one already handles every item mutation." Half right, and the wrong half matters.

**Actions — one function, but it also serves the mirror-receive path.** `insertActionEvent` (`utils/action_event_runtime.ts:131`) is genuinely the single write path, called from exactly three places:

- `routes/v1/network/action/perform_action.ts:393` — the write authority
- `routes/v1/action/update_action_status.ts:607` — the write authority
- `routes/v1/event/store_event.ts:109` — **the mirror receiver**

Instrument the function naively and the source instance emits on mirror-receive, producing exactly the double emission the single-emitter rule forbids.

**Items — not one function.** `routes/v1/item/lifecycle.ts` writes `items` directly at lines **161** and **215**, inside its own transaction, bypassing `item_service`. That is the path behind the brief's marquee `signals.item.lifecycle_changed` example (#5). `item_service.ts` covers create (`:350`) and update (`:550`, `:827`); `scripts/backfill_lifecycle.ts:144` is a fourth writer. So item instrumentation is four sites, not one.

**The good news, and a better formulation of the rule.** Two mechanisms the brief can inherit rather than invent:

- `action_events` already has a unique index on `(partition_network, action_type, origin_instance_domain, action_id, update_count)`, and `insertActionEvent` uses `onConflictDoNothing(...).returning(...)`, so `createdEvent` is null on a duplicate. **Emit from inside the existing `if (createdEvent)` guard** and retry-duplication is handled by the database, for free.
- That index deliberately includes `origin_instance_domain`, which is why the authoritative row and the mirrored row coexist. **The single-emitter rule is therefore expressible as a column comparison** — emit only when `origin_instance_domain` is this instance — rather than as a convention about which routes to avoid instrumenting. Note also that the brief's `event.uid` (`act:{action_id}:{update_count}`) is precisely that unique key *minus* `origin_instance_domain`, i.e. the key under which the two copies collapse. The uid discipline is already validated by the schema.
- Both item write paths run inside a `tx`, so "emit in the same transaction as the write" is achievable without restructuring.

### 6.5 The notification premise conflicts with the event-platform reframe — and would be a reliability regression

The brief's durability argument is: "a lost event means a lost email, which is the problem this design exists to fix."

That is not how notifications work today, and not where they are heading.

**Today:** Signals calls notification-service directly from the write path. `utils/notificationClient.ts` is wired into `network/action/perform_action.ts`, `action/update_action_status.ts`, `item/lifecycle.ts`, and `notifications/welcome.ts`. On the action path, `dispatchActionNotifications` fires at `perform_action.ts:399` **guarded on `createdEvent` being non-null** — i.e. the trigger is already the idempotent database insert, with a comment saying exactly that.

**Where it is heading:** the event platform's 2026-08-06 revision (notification-service `feat/event-platform`, `733600c`) reframed the model so that **consumer-owned APIs are the default contract and the bus is for fan-out only** — explicitly "the bus is not an RPC substitute."

So routing notification triggers through telemetry would move a trigger that is currently synchronous and idempotent onto a best-effort pipeline plus a new outbox — a reliability regression justified by a problem that does not exist.

*Recommended:* state plainly that **telemetry does not trigger notifications**; notifications keep the existing inline seam, and telemetry *observes* delivery outcomes. That single change collapses the durable-lane requirement from delivery-critical to **audit-grade**, which is a far cheaper build: the durable lane becomes needed only for events that must survive for audit and metrics-of-record, and the outbox can be a follow-on phase instead of a v1 blocker.

**Related producer gap.** `signals.notification.skipped` in example #8 is emitted with `actor.type: system` from `signals-api` — but the outcomes that matter (delivered, bounced, provider failure, latency) are known only to notification-service, which is not a listed producer. Same for `signals.search.executed`: `signals-search` owns `/v1/search` and is likewise absent. Either the producer list grows to four or five, or those two events describe what the emitter cannot observe.

### 6.6 The Kafka boundary hard-codes a dependency that was deliberately deprioritised

"Raw and transformed Kafka topics are the boundary. No analytics datastore is part of this design" is a good instinct — portability — expressed as a dependency on infrastructure that does not exist and is scheduled last. The event platform's stage order is explicitly **not** backbone-first: Kafka + Strimzi + Apicurio land in **Stage 3**, after NS becomes the notification authority (Stage 1) and aggregator migrates onto it (Stage 2). The July umbrella had the same flaw — it declared the analytics plane a consumer of the Kafka backbone — so this is a shared problem, not a new one.

*Recommended:* make the **OTLP endpoint** the boundary, not Kafka. Producers speak OTLP to a Collector; what the Collector exports is deployment configuration. Kafka then becomes one exporter among several and telemetry can ship — instrumentation, schema, dedup discipline, a queryable sink — before Stage 3, without changing a line of producer code when the bus arrives. This preserves the datastore-independence the brief wants while removing the gate.

### 6.7 Smaller items

- **Dangling reference.** The brief's header points to `2026-08-10-telemetry-design.md` as the full spec; that file is not committed on any branch (checked across all 20 remote branches). Either commit it or drop the pointer — a header naming a doc nobody can open will send readers to the superseded Sunbird content it warns about.
- **`ntf:{parent_uid}:{shape}` collapses cases that are not duplicates.** A genuine retry after a provider failure, and a fan-out to several recipients of the same shape, both produce one uid. Add the attempt number and a pseudonymised recipient key, or state that notification events are per-shape-per-parent aggregates rather than per-send.
- **`metric.*` slots are semantically overloaded by design.** In example #3, `metric.count` is populated-field count and `metric.score` is completion percentage; in #7 `metric.count` is result count. That is an acceptable trade for a fixed schema, but it must be documented: `metric.*` is only meaningful filtered by `event.name`, and any event needing two counts cannot express both.
- **`state.trigger` values are unbounded in practice.** `user_action` / `profile_consent_accepted` / `system` / `admin_upsert` is a good start, but it is the one field most likely to sprawl per feature. Either enumerate it closed and route the rest through `attr.*`, or apply the promotion rule to it explicitly.

## 7. Open questions, merged

Their six plus the ones this review adds, deduped, with where each gets decided.

| # | Question | Decided where |
|---|---|---|
| 1 | Browser OTEL immaturity — wrap behind a thin internal emitter; does GA4 stay during the transition? | Signals UI phase. Agreed as stated in the brief. |
| 2 | Durable lane mechanics for record-grade events | **Re-scope first** (§6.5): audit-grade, not delivery-grade. Then design the outbox. |
| 3 | Inter-instance mirror — fix or retire | Its own issue, independent of telemetry, as the brief says. Telemetry must not depend on the outcome. |
| 4 | Stream-maintained vs pre-warmed `item_metrics` | Later phase, gated on a parity test — and blocked until §6.2 lands. |
| 5 | Do aggregator bulk-create writes set the acting org? | Cross-repo; resolve together with §6.2, since the two org fields are easy to conflate. |
| 6 | Split the transformed topic by trust tier? | Follows from §6.6 — becomes an exporter-configuration question, not a schema one. |
| 7 | **Is telemetry ever a notification trigger?** | Answer no (§6.5). This is the highest-leverage decision in the memo. |
| 8 | **Do `signals-search` and `notification-service` become producers?** | Needed before their events can be believed (§6.5). |
| 9 | **Does aggregator PR #354 get re-pointed at this contract before merging?** | Decision expires; costs rise while the PR sits (§5.4). |
| 10 | **What is the item revision mechanism?** | Migration decision, blocks item-event uids (§6.1). |
| 11 | Where does required-attribute validation run — emitter, bridge, or both? | §5.5. |

## 8. Not decided here

Doc structure. Options were: merge into one revised umbrella; keep two layers with the Signals brief shipping first; or memo-only, which is what this is. That call is better made after the brief's author has responded to §6, since the fixes change how much of the umbrella is still needed — particularly §6.5 and §6.6, which between them remove telemetry's dependency on the event platform entirely.

Nothing in this memo has been committed or pushed to any branch.
