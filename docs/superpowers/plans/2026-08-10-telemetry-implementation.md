# Telemetry implementation plan

**Date:** 2026-08-10 · **Revised:** 2026-08-13 (OpenTelemetry)
**Spec:** `docs/superpowers/specs/2026-08-10-telemetry-design.md`
**Brief:** `docs/superpowers/specs/2026-08-10-telemetry-design-brief.md`

Six phases. Each is independently shippable and independently revertable, and each
leaves the system working if the next never lands. `TELEMETRY_ENABLED=false` is the
global kill switch through phase 2.

---

## Phase 0 — prerequisites

Three items. None is telemetry code; all three block telemetry that is correct.

### 0a. `items.revision` migration

`items` has no monotonic column (spec §4.4), so item `event.uid`s and
`object.version` have no source. Without this, three of the brief's five
state-change examples are unimplementable.

1. Custom Drizzle migration adding `revision integer not null default 1` to
   `items`. Hand-written via `drizzle-kit generate --custom` per
   `apps/api/drizzle/README.md` (the table is partitioned, so this is not a
   generated migration). Regenerate with `pnpm schema:bundle`.
2. Bump it in the same transaction as every mutation, at **all six write sites**:
   `item_service.ts:345,518,748`, `lifecycle.ts:161,215`,
   `backfill_lifecycle.ts:144`.
3. **One test per write site** asserting the bump. A missed site means that item's
   events silently collide on `event.uid` and get deduped as duplicates — a
   failure mode that is invisible without this test.

Decide explicitly whether the backfill script bumps (spec §14.2 Q2). Recommended:
yes, so the invariant "every mutation bumps" holds without exceptions to remember.

### 0b. `object.org` resolution

Make the item owner's `user.onboarded_by_org_id` available at emit time on the item
and action paths (spec §6.4). On the action path both owners are already loaded for
the notification payload, so this is one join rather than a query per event.

Resolve alongside the cross-repo question of whether aggregator bulk-create sets
`actor.on_behalf_of` — the two org fields are the easiest thing here to conflate,
and getting them backwards produces per-aggregator numbers that look plausible and
are wrong.

### 0c. The mirror defect

Pre-existing and independent of telemetry (spec §10.4), but phase 4 removes the
mirror — so it must be fixed first, or "we replaced it with the stream" becomes the
reason nobody notices source instances have been missing cross-instance events all
along.

1. **Open an issue.** Reproduce with two instances,
   `INSTANCE_ENV=production`, one cross-instance action → expect the
   `'Failed to mirror action event to source instance'` log with a 401.
2. **Fix:** send peer HMAC headers via `instance_token.ts` and switch
   `/api/v1/event/store` to `peer_instance_guard`, matching the other peer routes.
3. **Integration test:** a cross-instance action produces an `action_events` row on
   *both* instances.

Reproduce → fix → re-run the reproduction before moving on. Parity in phase 4
cannot be measured against a mirror that delivers nothing.

---

## Phase 1 — SDK, schema, outbox, emitters (dark)

Producer side only. Nothing consumes the stream yet.

**Packages**

- `packages/schemas/src/telemetry.ts` — Zod schemas for the fixed attribute set,
  the `event.name` enum, `event.category`, and required-attribute rules **per
  `event.name`** (spec §5.6). Exported from the package index.
- `packages/config/src/secrets.ts` — `TelemetrySecretsSchema` (spec §13). **Add the
  same vars to `turbo.json`'s `globalPassThroughEnv` in the same commit** — the
  two-places rule in `.claude/rules/env-vars.md`.

**Database**

- Custom migration for `telemetry_outbox` (spec §7.3). **Not** partitioned — it is
  a transient queue. Partial index `(published_at, created_at) WHERE published_at
  IS NULL`.

**API**

- `apps/api/src/telemetry/sdk.ts` — `@opentelemetry/sdk-node` init with
  auto-instrumentation for Fastify, `pg`, `ioredis`, `undici`. `Resource` per spec
  §3.1, including `dpg.instance` derived from
  `normalizeInstanceUrl(getCurrentApiBaseUrl())` — **not** a new env var.
- `apps/api/src/telemetry/event.ts` — `buildEvent()`: fills `event.uid`
  (deterministic, spec §5.1), `event.category`, the pseudonymised `actor.id`
  (HMAC with `SIGNALS_PII_KEY`), both placement blocks, and validates against the
  Zod schema before returning.
- `apps/api/src/telemetry/emit.ts` — two entry points:
  - `emitRecord(tx, event)` — inserts into the outbox **on the caller's
    transaction**, `ON CONFLICT (event_uid) DO NOTHING`. Record-grade only.
  - `emitDirect(event)` — straight to the SDK, never throws. UI, search, spans,
    metrics.
  Both no-op when `TELEMETRY_ENABLED=false`.
- Wire the emit sites, each its own commit, in this order:
  1. `utils/action_event_runtime.ts` → inside `insertActionEvent`'s
     `if (created)` path, **guarded on the single-emitter comparison**
     `normalizeInstanceUrl(origin_instance_domain) === normalizeInstanceUrl(getCurrentApiBaseUrl())`.
     This one edit covers action create, status change, and the mirror-receive
     path correctly (spec §6.3).
  2. The six item write sites — same commits as the 0a `revision` bumps.
  3. `services/auth/provisioning.ts` (onboarding).
  4. The `consent_record` insert sites.
  5. `discover.ts` / `markers.ts` (search, with `attr.search_mode`).
  6. `guardian_action_gate.ts`, `action_pair_cap.ts` (blocked actions),
     `get_action_contact_details.ts` (PII reveal).

Item and action paths already run inside transactions, so `emitRecord` needs the
existing handle threaded in — **do not open a nested transaction.**

**Tests**

- **`event.uid` determinism** — the same natural key yields the same uid from two
  different `dpg.instance` values. This is the test that protects the whole
  multi-instance model.
- **Single-emitter** — a mirror-receive through `store_event_handler` produces
  **zero** outbox rows, while the authority path produces one.
- **Retry idempotency** — a duplicate `insertActionEvent` produces no second row.
- Every catalogue entry validates against its `event.name` rules; a missing
  required attribute fails.
- **PII** — no email/phone/name/DOB/coordinate/remark reaches an event, including
  for a U18 actor and a `remark`-carrying action event.
- `TELEMETRY_ENABLED=false` ⇒ zero rows, zero SDK calls.

**Exit criteria:** enabled in staging, outbox filling, all events schema-valid, no
behaviour change with the flag off, `pnpm typecheck` and
`pnpm --filter api test` green.

---

## Phase 2 — relay and collector

Still no notification change.

- `apps/api/src/telemetry/relay.ts` — claim a batch with `FOR UPDATE SKIP LOCKED`,
  emit via the SDK, stamp `published_at`, sweep published rows past
  `TELEMETRY_OUTBOX_RETENTION_HOURS`. Started from `app.ts` only when
  `TELEMETRY_ENABLED`.
- Collector/bridge deployment: OTLP in, raw + transformed topics out (spec §7.1),
  with required-attribute enforcement at the bridge and a DLQ.
- Operational signals: the hand-added spans and instruments in spec §4.3, plus
  `traceparent` injection/acceptance on the three peer-facing call sites.
- Alerting: outbox depth, **age of the oldest unpublished row** (not depth alone),
  DLQ rate.

**Verify §11 explicitly:** confirm no sampler or memory-limiter in the deployed
pipeline can drop domain events. A globally-tuned sampler silently corrupting the
record-grade stream is the failure this phase must rule out.

**Exit criteria:** events queryable end-to-end from a staging instance; a
deliberate bridge outage queues and drains with no loss.

---

## Phase 3 — notification cutover

The only phase with user-visible risk.

- `apps/api/src/telemetry/consumers/notification_consumer.ts` — event → validate →
  filter to notifiable `(event.name, state.bucket)` per network config → map to
  `NotificationEvent` → `buildNotifications` (**unchanged**) →
  `createDirectDispatcher` (**unchanged**) → NS. 3 attempts then DLQ.
- `notification_sent (event_uid, shape, recipient_user_id)` table, PK-guarded.
- Emit `notification.*` from the consumer, closing the loop.

**Validate before cutting over.** Run the consumer in staging with a no-op `notify`
and diff the plans it produces against the plans the in-route dispatcher produces
for the same actions. They must match exactly, including locality filtering, before
any real send.

**The cutover.** Doubled email is the failure mode (spec §8.5). Therefore, in **one
commit**: delete the five in-route dispatch call sites —
`network/action/perform_action.ts:358`, `update_action_status.ts:614`,
`dispatchRetireCancelNotifications` at `item/lifecycle.ts:287`, and
`sendWelcomeNotifications` at `provisioning.ts:467` and
`routes/auth/create_auth.ts:60` — **and** flip
`NOTIFICATION_CONSUMER_ENABLED=true`. Never a state where both are live.

**Tests**

- Consumer produces byte-identical `NotificationPlan[]` to the current path, for
  all four shapes.
- Two-instance fixture: each instance notifies only its own owner, neither twice.
- Re-delivery of the same `event.uid` sends exactly one email.
- Previously-unnotified paths now notify: local `/action/perform`; cancellations
  are recorded (copy still deliberately absent).
- NS 5xx ⇒ offset not advanced ⇒ retry ⇒ DLQ after 3.

**Exit criteria:** staging parity diff clean, then production cutover with email
volume monitored against the prior baseline for 48h.

---

## Phase 4 — retire the mirror

Only after phase 3 is stable and 0c gave a working mirror to compare against.

- Source instances consume the stream to populate local `action_events`, replacing
  `mirrorActionEventToSourceInstance`.
- Run both paths in parallel and assert row-level parity on the source instance for
  a full week, including a deliberate peer-unreachable window — the stream should
  back-fill where the mirror lost the event permanently.
- Then delete the mirror and decide `/api/v1/event/store`'s fate (spec §14.2 Q4).

---

## Phase 5 — UI telemetry

Independent of 1–4; can run in parallel.

- `POST /api/v1/telemetry` collector endpoint: batch accept, rate limited,
  origin-checked, auth-optional so pre-login funnel events survive. **Untrusted
  input** — forces `service.name: signals-ui`, ignores any client-supplied
  `Resource`, stamps its own receive time alongside the client's. Publishes to the
  behavioural path only, never the record-grade one.
- A thin internal emitter in `apps/ui`, wrapping the OTEL browser SDK so it can be
  swapped without touching call sites — client instrumentation is experimental and
  expected to churn (spec §14.2 Q1).
- `flow.name` / `flow.step` on the profile-creation and signup flows, matching the
  server-side values so funnels join.
- Decide GA4's fate: keep during transition, or drop.

---

## Phase 6 — metrics projector (optional)

- Consumer maintaining `item_metrics` incrementally.
- **Blocked until 0b (`object.org`) has landed** — without subject attribution the
  projector cannot reproduce a single dashboard tile, so parity cannot be measured.
- **Parity gate:** projector output must equal a full
  `recompute_aggregator_domain_metrics` run for every domain in a staging dataset,
  including the self-domain doubling rule
  (`services/metrics/README.md` §directionality). No cutover without it.
- Then remove the synchronous stale-cache recompute from the request path.

---

## Sequencing

| Phase | Risk | Reversible by |
|---|---|---|
| 0 — prerequisites | Low | Independent of telemetry; revert individually |
| 1 — producers | Very low | `TELEMETRY_ENABLED=false` |
| 2 — relay + collector | Low | Same flag; no consumers yet |
| 3 — notification cutover | **High** | Revert the cutover commit (restores in-route dispatch) |
| 4 — retire mirror | Medium | Revert; mirror code present until deleted |
| 5 — UI | Low | Independent flags |
| 6 — projector | Medium | Keep recompute until parity holds |

## Cross-cutting, not a phase

**Cross-DPG harmonisation** (spec §14.2 Q7). `aggregator-dpg` has a merged
telemetry design with its own envelope and SDK and an **open, unmerged**
implementation PR; `ai-diffusion-dpg` has a mature Python OTel layer with its own
conventions. Either they are re-pointed at this contract, or the platform runs
multiple OTel dialects. **This decision expires** — it gets more expensive the
longer the aggregator PR sits, so it needs an owner now rather than at phase 5.

## Docs to update on the way

- `apps/api/CLAUDE.md` — a telemetry section; the notifications description becomes
  consumer-driven after phase 3.
- `.claude/rules/telemetry.md` — new, keyed to `apps/api/src/telemetry/**` and the
  emit-site files, carrying the no-PII rule, the deterministic-`event.uid` rule,
  the single-emitter comparison, and the fixed-schema/promotion rule, so none of
  them is re-derived by whoever next adds an event.
- `.claude/rules/database-conventions.md` — the `items.revision` bump invariant.
- `docs/operations/` — collector/topic configuration, DLQ runbook, outbox alerting.
- Root `CLAUDE.md` and `packages/notification/CLAUDE.md` — after the phase-3
  cutover.
